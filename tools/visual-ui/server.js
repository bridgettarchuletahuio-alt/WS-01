'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const zlib = require('zlib');

const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const { Client, LocalAuth, MessageMedia } = require('../../index');

const PORT = Number(process.env.WWEBJS_UI_PORT || 3399);
const HOST = '127.0.0.1';
const CLIENT_IDS = String(process.env.WWEBJS_CLIENT_IDS || 'visual-ui')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const normalizePhoneInput = (raw) => raw.replace(/[^0-9]/g, '');
const commandSeen = new Set();
const awaitingTxtModeByChat = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clientPool = new Map();
let rrCursor = 0;

const makeChatScopeKey = (clientId, chatId) => `${clientId}::${chatId}`;

const isMostlyPrintable = (text) => {
    if (!text) return false;
    let printable = 0;
    for (const ch of text) {
        const code = ch.charCodeAt(0);
        if (
            code === 9 ||
            code === 10 ||
            code === 13 ||
            (code >= 32 && code <= 126)
        ) {
            printable++;
        }
    }
    return printable / text.length >= 0.82;
};

const sanitizePreview = (text, maxLen = 280) => {
    if (!text) return '';
    return text
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLen);
};

const extractAsciiFragments = (buffer) => {
    const txt = buffer.toString('latin1');
    const parts = txt.match(/[ -~]{4,}/g) || [];
    return parts.slice(0, 10).join(' | ');
};

const decodeWsPayload = (payload, opcode) => {
    const decodeResult = {
        normalizedText: '',
        debugSummary: '',
    };

    if (!payload) return decodeResult;

    if (opcode !== 2) {
        const plain = sanitizePreview(String(payload));
        decodeResult.normalizedText = plain.toLowerCase();
        decodeResult.debugSummary = plain || '[text-empty]';
        return decodeResult;
    }

    let buffer;
    try {
        buffer = Buffer.from(payload, 'base64');
    } catch {
        decodeResult.debugSummary = '[binary-base64-invalid]';
        return decodeResult;
    }

    const utf8 = buffer.toString('utf8');
    if (isMostlyPrintable(utf8)) {
        const preview = sanitizePreview(utf8);
        decodeResult.normalizedText = preview.toLowerCase();
        decodeResult.debugSummary = `[binary/utf8] ${preview}`;
        return decodeResult;
    }

    const inflateAttempts = [
        ['inflate', () => zlib.inflateSync(buffer)],
        ['inflateRaw', () => zlib.inflateRawSync(buffer)],
        ['gunzip', () => zlib.gunzipSync(buffer)],
    ];

    for (const [name, fn] of inflateAttempts) {
        try {
            const inflated = fn();
            const inflatedText = inflated.toString('utf8');
            if (isMostlyPrintable(inflatedText)) {
                const preview = sanitizePreview(inflatedText);
                decodeResult.normalizedText = preview.toLowerCase();
                decodeResult.debugSummary = `[binary/${name}] ${preview}`;
                return decodeResult;
            }
        } catch {
            // ignore and continue to next strategy
        }
    }

    const fragments = sanitizePreview(extractAsciiFragments(buffer));
    if (fragments) {
        decodeResult.normalizedText = fragments.toLowerCase();
        decodeResult.debugSummary = `[binary/ascii-fragments len=${buffer.length}] ${fragments}`;
        return decodeResult;
    }

    decodeResult.debugSummary = `[binary/unreadable len=${buffer.length}] payload appears encrypted or highly compressed`;
    return decodeResult;
};

const decodeFramesViaService = async (base64Frames) => {
    const serviceUrl = process.env.WS_DECODE_URL || 'http://127.0.0.1:3000/decode';
    if (!Array.isArray(base64Frames) || !base64Frames.length) {
        return { ok: false, reason: 'no_frames', decoded: 0, hits: 0, samples: [] };
    }

    try {
        const resp = await fetch(serviceUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                frames: base64Frames.slice(0, 120),
                includeRaw: false,
            }),
        });

        if (!resp.ok) {
            return {
                ok: false,
                reason: `http_${resp.status}`,
                decoded: 0,
                hits: 0,
                samples: [],
            };
        }

        const data = await resp.json();
        const results = Array.isArray(data?.results) ? data.results : [];
        const decodedItems = results.filter((item) => item?.exists);
        const signalTypes = new Set([
            'conversation',
            'extendedTextMessage',
            'imageMessage',
            'videoMessage',
            'protocolMessage',
            'reactionMessage',
            'pollCreationMessage',
            'contactsArrayMessage',
            'buttonsMessage',
            'listMessage',
            'senderKeyDistributionMessage',
        ]);

        const hits = decodedItems.filter((item) =>
            signalTypes.has(String(item?.type || 'other')),
        );

        const samples = hits.slice(0, 8).map((item) => {
            const t = String(item?.type || 'other');
            const jid = item?.summary?.key?.remoteJid || '-';
            return `[svc] type=${t} jid=${jid}`;
        });

        return {
            ok: true,
            reason: 'ok',
            decoded: decodedItems.length,
            hits: hits.length,
            samples,
        };
    } catch (error) {
        return {
            ok: false,
            reason: error?.message || String(error),
            decoded: 0,
            hits: 0,
            samples: [],
        };
    }
};

const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 45000);
const PROBE_TEXT =
    process.env.PROBE_TEXT || '系统连通性测试消息，请忽略。';

const waitForMessageAck = (clientRef, targetMsgId, timeoutMs = PROBE_TIMEOUT_MS) => {
    return new Promise((resolve) => {
        let done = false;
        let bestAck = null;
        let sawEvent = false;

        const finish = (result) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            clientRef.off('message_ack', onAck);
            resolve(result);
        };

        const onAck = (msg, ack) => {
            const id = msg?.id?._serialized;
            if (!id || id !== targetMsgId) return;

            const n = Number(ack);
            if (Number.isNaN(n)) return;

            sawEvent = true;
            if (bestAck === null || n > bestAck) {
                bestAck = n;
            }

            // Single tick(1) may arrive first; wait for double tick(>=2) upgrade.
            if (n >= 2) {
                finish({ ack: bestAck, source: 'event' });
            }
        };

        const timer = setTimeout(() => {
            finish({
                ack: bestAck,
                source: sawEvent ? 'event_timeout' : 'timeout',
            });
        }, timeoutMs);

        clientRef.on('message_ack', onAck);
    });
};

const classifyProbeByAck = (ack) => {
    if (ack === null || Number.isNaN(Number(ack))) return 'low_active';
    const n = Number(ack);
    if (n >= 2) return 'high_active';
    if (n === 1) return 'mid_active';
    if (n >= 0) return 'low_active';
    return 'not_exist';
};

const normalizeProbeAck = (ack) => {
    if (ack === null || Number.isNaN(Number(ack))) return null;
    const n = Number(ack);
    if (n >= 2) return 2;
    if (n === 1) return 1;
    return 0;
};

const runProbeForNumber = async (clientRef, number, probeText) => {
    const numberId = await clientRef.getNumberId(number);
    if (!numberId) {
        return {
            ok: true,
            number,
            activity: 'not_exist',
            ack: null,
            source: 'unregistered',
            note: '号码未注册',
        };
    }

    const to = numberId._serialized || `${number}@c.us`;
    const sent = await clientRef.sendMessage(to, probeText);
    const ackRes = await waitForMessageAck(
        clientRef,
        sent?.id?._serialized,
        PROBE_TIMEOUT_MS,
    );
    const normalizedAck = normalizeProbeAck(ackRes.ack);

    return {
        ok: true,
        number,
        activity: classifyProbeByAck(normalizedAck),
        ack: normalizedAck,
        source: ackRes.source,
        note: '',
    };
};

const getReadyClients = () => {
    return [...clientPool.values()].filter((entry) => entry.status === 'ready');
};

const pickExecutionClient = (preferredClientId) => {
    const ready = getReadyClients();
    if (!ready.length) return null;

    const preferred = ready.find((entry) => entry.clientId === preferredClientId);
    if (preferred) return preferred;

    const picked = ready[rrCursor % ready.length];
    rrCursor = (rrCursor + 1) % Math.max(ready.length, 1);
    return picked;
};

const runWithExecutionClient = async (preferredClientId, fn) => {
    const selected = pickExecutionClient(preferredClientId);
    if (!selected) {
        throw new Error('暂无可用账号，请稍后重试或重新登录');
    }
    return fn(selected.client, selected.clientId);
};

const maskSensitive = (text) =>
    text
        .replace(/\b\d{6,18}\b/g, '[num]')
        .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '[email]');

const decodeTextBuffer = (buffer) => {
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
        return buffer.slice(2).toString('utf16le');
    }

    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
        const swapped = Buffer.from(buffer.slice(2));
        for (let i = 0; i + 1 < swapped.length; i += 2) {
            const t = swapped[i];
            swapped[i] = swapped[i + 1];
            swapped[i + 1] = t;
        }
        return swapped.toString('utf16le');
    }

    const utf8 = buffer.toString('utf8');
    if (utf8.includes('\u0000')) {
        return buffer.toString('utf16le');
    }
    return utf8;
};

const extractNumbersFromText = (text) => {
    const candidates = [];

    const plainTokens = text.match(/[0-9]{6,18}/g) || [];
    candidates.push(...plainTokens);

    const normalizedTokenText = text.replace(/[^0-9+]+/g, ' ');
    const plusTokens = normalizedTokenText.match(/\+?[0-9]{6,18}/g) || [];
    candidates.push(...plusTokens);

    return candidates
        .map((item) => normalizePhoneInput(item))
        .filter((item) => item.length >= 6 && item.length <= 18);
};

const extractPhoneNumbers = (text) => {
    return [...new Set(extractNumbersFromText(text))];
};

const extractPhoneNumbersFromBuffer = (buffer) => {
    const decodedTexts = [
        decodeTextBuffer(buffer),
        buffer.toString('utf8').replace(/\u0000/g, ''),
        buffer.toString('utf16le').replace(/\u0000/g, ''),
        buffer.toString('latin1').replace(/\u0000/g, ''),
    ];

    const merged = [];
    for (const txt of decodedTexts) {
        merged.push(...extractNumbersFromText(txt));
    }

    return [...new Set(merged)];
};

const checkActivityByWsFrames = async (
    clientRef,
    rawNumber,
    waitMs = 5000,
    options = {},
) => {
    const number = normalizePhoneInput(rawNumber);
    if (!number) {
        return {
            ok: false,
            message: '号码为空或格式无效',
        };
    }

    const cdp = await clientRef.pupPage.target().createCDPSession();
    await cdp.send('Network.enable');

    const keywordHits = [];
    const keywords = [
        'presence',
        'last',
        'status',
        'jid',
        '404',
        'available',
        'composing',
        'paused',
        'chatstate',
        'receipt',
    ];
    const numberHints = [number, `${number}@c.us`, `${number}@s.whatsapp.net`];
    let totalFrames = 0;
    let decodedFrames = 0;
    const decodedSamples = [];
    const binaryFramePayloads = [];

    const onFrame = (event) => {
        const payload =
            event?.response?.payloadData || event?.request?.payloadData || '';
        const opcode = event?.response?.opcode ?? event?.request?.opcode;

        totalFrames++;
        if (!payload) return;

        if (opcode === 2 && binaryFramePayloads.length < 180) {
            binaryFramePayloads.push(String(payload));
        }

        const { normalizedText, debugSummary } = decodeWsPayload(payload, opcode);
        decodedFrames++;

        if (decodedSamples.length < 25) {
            decodedSamples.push(maskSensitive(debugSummary.slice(0, 400)));
        }

        const text = normalizedText;
        if (!text) return;

        if (!keywords.some((k) => text.includes(k))) return;

        // Prefer strict number-hint matches, but allow presence/status-like frames as soft evidence.
        const strongHit = numberHints.some((hint) => text.includes(hint.toLowerCase()));
        const softHit =
            text.includes('presence') || text.includes('last') || text.includes('status');
        if (!strongHit && !softHit) return;

        keywordHits.push(text.slice(0, 600));
    };

    cdp.on('Network.webSocketFrameReceived', onFrame);
    cdp.on('Network.webSocketFrameSent', onFrame);

    try {
        await clientRef.pupPage
            .goto(`https://web.whatsapp.com/send?phone=${number}`, {
                waitUntil: 'commit',
                timeout: 15000,
            })
            .catch(() => {});
        await sleep(Math.max(waitMs, 9000));

        // If no frames were observed at all, trigger a socket reconnect and wait a bit more.
        if (totalFrames === 0) {
            await clientRef.pupPage
                .evaluate(() => {
                    try {
                        window.require('WAWebSocketModel').Socket.reconnect();
                    } catch {}
                })
                .catch(() => {});
            await sleep(5000);
        }
    } finally {
        cdp.off('Network.webSocketFrameReceived', onFrame);
        cdp.off('Network.webSocketFrameSent', onFrame);
        await cdp.detach().catch(() => {});
    }

    const merged = keywordHits.join('\n');
    const svcResult = await decodeFramesViaService(binaryFramePayloads);
    const serviceSamples = svcResult.samples || [];
    if (options.includeDebugFrames && serviceSamples.length) {
        decodedSamples.push(...serviceSamples);
    }

    const totalHits = keywordHits.length + (svcResult.hits || 0);
    let state = 'unknown';
    if (merged.includes('404')) state = 'unregistered';
    else if (merged.includes('presence') && merged.includes('available'))
        state = 'online';
    else if (merged.includes('last')) state = 'recent_activity';
    else if (merged.includes('status')) state = 'status_signal';
    else if ((svcResult.hits || 0) > 0) state = 'registered_signal';

    if (state === 'unknown') {
        try {
            const numberId = await clientRef.getNumberId(number);
            state = numberId ? 'registered_no_presence' : 'unregistered';
        } catch {
            state = 'unknown';
        }
    }

    return {
        ok: true,
        number,
        state,
        frameCount: totalHits,
        keywordHits: keywordHits.length,
        serviceHits: svcResult.hits || 0,
        serviceDecoded: svcResult.decoded || 0,
        serviceStatus: svcResult.ok ? 'ok' : `unavailable:${svcResult.reason}`,
        totalFrames,
        decodedFrames,
        sample: keywordHits[0] || serviceSamples[0] || '',
        debugFrames: options.includeDebugFrames ? decodedSamples : [],
    };
};

const checkNumberBehavior = async (clientRef, rawNumber, waitMs = 5000) => {
    const number = normalizePhoneInput(rawNumber);
    if (!number) {
        return { ok: false, message: '号码为空或格式无效' };
    }

    try {
        await clientRef.pupPage
            .goto(`https://web.whatsapp.com/send?phone=${number}`, {
                waitUntil: 'commit',
                timeout: 15000,
            })
            .catch(() => {});

        await sleep(waitMs);

        // Try to mimic "continue chat" click behavior if available.
        await clientRef.pupPage
            .evaluate(() => {
                const link = document.querySelector('a[href*="send"]');
                if (link) link.click();
            })
            .catch(() => {});

        await sleep(2500);

        const pageContent = (await clientRef.pupPage.content()).toLowerCase();
        if (
            pageContent.includes('phone number shared via url is invalid') ||
            pageContent.includes('not on whatsapp')
        ) {
            return { ok: true, number, behavior: 'invalid' };
        }

        const inputExists = await clientRef.pupPage
            .evaluate(() => {
                const candidates = document.querySelectorAll(
                    'div[contenteditable="true"], [role="textbox"]',
                );
                for (const el of candidates) {
                    const htmlEl = /** @type {HTMLElement} */ (el);
                    const visible =
                        !!htmlEl &&
                        htmlEl.offsetParent !== null &&
                        window.getComputedStyle(htmlEl).visibility !== 'hidden';
                    if (visible) return true;
                }
                return false;
            })
            .catch(() => false);

        if (inputExists) {
            return { ok: true, number, behavior: 'valid' };
        }

        return { ok: true, number, behavior: 'unknown' };
    } catch (error) {
        return {
            ok: false,
            number,
            message: error?.message || String(error),
        };
    }
};

const state = {
    status: 'starting',
    qrDataUrl: null,
    loading: null,
    logs: [],
    clients: {},
};

const log = (message) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    state.logs.push(line);
    if (state.logs.length > 200) state.logs.shift();
    io.emit('log', line);
    console.log(line);
};

const setStatus = (status) => {
    state.status = status;
    io.emit('status', status);
};

const setClientState = (clientId, patch) => {
    state.clients[clientId] = {
        ...(state.clients[clientId] || {
            status: 'starting',
            qrDataUrl: null,
            loading: null,
        }),
        ...patch,
    };
    io.emit('clients', state.clients);

    const statuses = Object.values(state.clients).map((item) => item.status);
    if (statuses.includes('ready')) {
        setStatus('ready');
    } else if (statuses.includes('authenticated')) {
        setStatus('authenticated');
    } else if (statuses.includes('waiting_for_scan')) {
        setStatus('waiting_for_scan');
    }
};

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (_req, res) => {
    res.json(state);
});

io.on('connection', (socket) => {
    socket.emit('status', state.status);
    socket.emit('loading', state.loading);
    socket.emit('qr', state.qrDataUrl);
    socket.emit('logs', state.logs);
    socket.emit('clients', state.clients);
});
const buildClient = (clientId) => {
    const client = new Client({
        authStrategy: new LocalAuth({ clientId }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
    });

    const entry = {
        clientId,
        client,
        status: 'starting',
    };
    clientPool.set(clientId, entry);
    setClientState(clientId, { status: 'starting' });

    client.on('loading_screen', (percent, message) => {
        if (clientId === CLIENT_IDS[0]) {
            state.loading = { percent, message };
            io.emit('loading', state.loading);
        }
        setClientState(clientId, { loading: { percent, message } });
    });

    client.on('qr', async (qr) => {
        entry.status = 'waiting_for_scan';
        setClientState(clientId, { status: 'waiting_for_scan' });
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 1 });
        if (clientId === CLIENT_IDS[0]) {
            state.qrDataUrl = qrDataUrl;
            io.emit('qr', state.qrDataUrl);
        }
        setClientState(clientId, { qrDataUrl });
        log(`[${clientId}] 收到新的登录二维码，请扫码。`);
    });

    client.on('authenticated', () => {
        entry.status = 'authenticated';
        if (clientId === CLIENT_IDS[0]) {
            state.qrDataUrl = null;
            io.emit('qr', null);
        }
        setClientState(clientId, { status: 'authenticated', qrDataUrl: null });
        log(`[${clientId}] 登录验证通过。`);
    });

    client.on('auth_failure', (msg) => {
        entry.status = 'auth_failure';
        setClientState(clientId, { status: 'auth_failure' });
        log(`[${clientId}] 登录失败: ${msg}`);
    });

    client.on('ready', () => {
        entry.status = 'ready';
        setClientState(clientId, { status: 'ready' });
        log(`[${clientId}] 机器人已就绪。发送 !help 查看可用命令。`);
    });

    client.on('disconnected', (reason) => {
        entry.status = 'disconnected';
        setClientState(clientId, { status: 'disconnected' });
        log(`[${clientId}] 连接断开: ${reason}`);
    });

    client.on('message', (msg) => handleCommandMessage(msg, client, clientId));
    client.on('message_create', (msg) =>
        handleCommandMessage(msg, client, clientId),
    );

    return entry;
};

async function handleCommandMessage(msg, clientRef, currentClientId) {
    const id = msg.id?._serialized;
    const seenKey = id ? `${currentClientId}:${id}` : null;
    if (seenKey && commandSeen.has(seenKey)) return;
    if (id) {
        commandSeen.add(seenKey);
        if (commandSeen.size > 5000) {
            const firstKey = commandSeen.values().next().value;
            commandSeen.delete(firstKey);
        }
    }

    const chatId = msg.from;
    const chatScopeKey = makeChatScopeKey(currentClientId, chatId);

    if (
        awaitingTxtModeByChat.has(chatScopeKey) &&
        msg.hasMedia &&
        !msg.body?.startsWith('!')
    ) {
        try {
            const mode = awaitingTxtModeByChat.get(chatScopeKey);
            const media = await msg.downloadMedia();
            const filename = media?.filename || 'numbers.txt';
            const isTxt =
                media?.mimetype === 'text/plain' || filename.endsWith('.txt');

            if (!media || !isTxt) {
                await msg.reply('请发送 TXT 文件（.txt）');
                log(`收到非TXT文件，等待重新上传: ${chatId}`);
                return;
            }

            const fileBuffer = Buffer.from(media.data, 'base64');
            const content = decodeTextBuffer(fileBuffer);
            const numbers = extractPhoneNumbersFromBuffer(fileBuffer).slice(
                0,
                500,
            );

            if (!numbers.length) {
                await msg.reply(
                    [
                        'TXT里没有识别到号码。',
                        `文件名: ${filename}`,
                        `MIME: ${media?.mimetype || 'unknown'}`,
                        `字节数: ${fileBuffer.length}`,
                        `内容预览: ${content.slice(0, 80).replace(/\s+/g, ' ')}`,
                    ].join('\n'),
                );
                log(`TXT未识别到号码: ${chatId}`);
                awaitingTxtModeByChat.delete(chatScopeKey);
                return;
            }

            let rows = [];
            let resultName = `result-${Date.now()}.txt`;

            if (mode === 'probe') {
                const uniqueNumbers = [...new Set(numbers)].slice(0, 80);
                await msg.reply(
                    `已收到文件，开始探测 ${uniqueNumbers.length} 个号码活跃度，请稍候...`,
                );

                rows = ['number\tactivity\tack\tchannel\tnote'];
                for (const number of uniqueNumbers) {
                    try {
                        const result = await runWithExecutionClient(
                            currentClientId,
                            (execClient) =>
                                runProbeForNumber(execClient, number, PROBE_TEXT),
                        );
                        rows.push(
                            `${number}\t${result.activity}\t${
                                result.ack === null ? 'timeout' : result.ack
                            }\t${result.source}\t${result.note || '-'}`,
                        );
                    } catch {
                        rows.push(`${number}\terror\t-\t-\tprobe_failed`);
                    }
                }
                resultName = `probe-result-${Date.now()}.txt`;
            } else {
                await msg.reply(
                    `已收到文件，开始检测 ${numbers.length} 个号码，请稍候...`,
                );

                rows = ['number\tstatus\twa_id'];
                for (const number of numbers) {
                    try {
                        const numberId = await runWithExecutionClient(
                            currentClientId,
                            (execClient) => execClient.getNumberId(number),
                        );
                        const status = numberId ? 'valid' : 'invalid';
                        const waId = numberId?._serialized || `${number}@c.us`;
                        rows.push(`${number}\t${status}\t${waId}`);
                    } catch {
                        rows.push(`${number}\terror\t-`);
                    }
                }
                resultName = `checknum-result-${Date.now()}.txt`;
            }

            const resultPath = path.join(os.tmpdir(), resultName);
            await fs.writeFile(resultPath, rows.join('\n'), 'utf8');

            const resultMedia = MessageMedia.fromFilePath(resultPath);
            await msg.reply(resultMedia, null, { sendMediaAsDocument: true });
            if (mode === 'probe') {
                await msg.reply(
                    `活跃探测完成，结果已通过TXT回传（${rows.length - 1}条）。`,
                );
            } else {
                await msg.reply(`检测完成，结果已通过TXT回传（${numbers.length}条）。`);
            }

            await fs.unlink(resultPath).catch(() => {});
            awaitingTxtModeByChat.delete(chatScopeKey);
            log(
                `${mode === 'probe' ? 'probe' : 'checknum'} TXT处理完成: ${chatId}, 共 ${rows.length - 1} 个号码`,
            );
            return;
        } catch (error) {
            awaitingTxtModeByChat.delete(chatScopeKey);
            await msg.reply('处理TXT失败，请重试。');
            log(`TXT处理失败: ${error?.message || error}`);
            return;
        }
    }

    if (typeof msg.body !== 'string' || !msg.body.startsWith('!')) return;

    log(`收到命令: ${msg.from} -> ${msg.body}`);

    if (msg.body === '!help') {
        await msg.reply(
            [
                '*可用命令*',
                '!ping - 回复 pong',
                '!checknum - 先提示上传TXT，机器人批量检测并回传TXT结果',
                '!checknumlist 8613...,8526... - 批量检查号码',
                '!activity 8613800138000 - 基于WebSocket帧做活跃状态探测',
                '!wsdebug 8613800138000 - 导出已解码WebSocket摘要',
                '!behavior 8613800138000 - 模拟页面行为检测号码状态',
                '!probe - 提示上传TXT，批量探测并回传TXT结果',
                '!probe 8613800138000 - 单号探测并按ACK返回活跃等级',
            ].join('\n'),
        );
        log('已回复: 命令菜单');
        return;
    }

    if (msg.body === '!ping') {
        await msg.reply('pong');
        log('已自动回复: pong');
        return;
    }

    if (msg.body.startsWith('!checknumlist')) {
        const input = msg.body.replace('!checknumlist', '').trim();
        const numbers = input
            .split(/[\s,;，；|]+/)
            .map((item) => normalizePhoneInput(item))
            .filter(Boolean);

        if (!numbers.length) {
            await msg.reply('用法: !checknumlist 8613800138000,85251234567');
            log('checknumlist 参数缺失');
            return;
        }

        const uniqueNumbers = [...new Set(numbers)].slice(0, 50);
        const lines = [];

        for (const number of uniqueNumbers) {
            try {
                const numberId = await runWithExecutionClient(
                    currentClientId,
                    (execClient) => execClient.getNumberId(number),
                );
                const status = numberId ? 'valid' : 'invalid';
                lines.push(`${number} => ${status}`);
            } catch {
                lines.push(`${number} => error`);
            }
        }

        await msg.reply(
            [
                `批量检测完成，共 ${uniqueNumbers.length} 个号码:`,
                ...lines,
            ].join('\n'),
        );
        log(`checknumlist 已处理: ${uniqueNumbers.length} 个号码`);
        return;
    }

    if (msg.body.startsWith('!activity ')) {
        const input = msg.body.slice('!activity '.length).trim();
        const number = normalizePhoneInput(input);

        if (!number) {
            await msg.reply('用法: !activity 8613800138000');
            log('activity 参数缺失');
            return;
        }

        try {
            await msg.reply('开始探测活跃状态，请稍候 3-6 秒...');
            log(`activity 开始执行: ${number}`);

            const result = await runWithExecutionClient(
                currentClientId,
                (execClient) => checkActivityByWsFrames(execClient, number, 4000),
            );
            if (!result.ok) {
                await msg.reply(`探测失败: ${result.message}`);
                log(`activity 失败: ${number}, ${result.message}`);
                return;
            }

            await msg.reply(
                [
                    `号码: ${result.number}`,
                    `状态判定: ${result.state}`,
                    `命中帧数: ${result.frameCount}`,
                    `关键词命中: ${result.keywordHits || 0}`,
                    `解码服务命中: ${result.serviceHits || 0}`,
                    `解码服务解出: ${result.serviceDecoded || 0}`,
                    `解码服务状态: ${result.serviceStatus || 'unknown'}`,
                    `总帧数: ${result.totalFrames}`,
                    `可解码帧数: ${result.decodedFrames}`,
                    `样本: ${(result.sample || '无').slice(0, 180)}`,
                ].join('\n'),
            );
            log(`activity 已处理: ${result.number} => ${result.state}`);
        } catch (error) {
            await msg.reply('活跃探测异常，请稍后重试。');
            log(`activity 失败: ${error?.message || error}`);
        }
        return;
    }

    if (msg.body.startsWith('!wsdebug')) {
        const input = msg.body.slice('!wsdebug'.length).trim();
        const number = normalizePhoneInput(input);

        if (!number) {
            await msg.reply('用法: !wsdebug 8613800138000');
            log('wsdebug 参数缺失');
            return;
        }

        await msg.reply('开始采集并解码WebSocket帧，请稍候 8-15 秒...');
        log(`wsdebug 开始执行: ${number}`);

        try {
            const result = await runWithExecutionClient(
                currentClientId,
                (execClient) =>
                    checkActivityByWsFrames(execClient, number, 9000, {
                        includeDebugFrames: true,
                    }),
            );

            const rows = [
                `number: ${result.number}`,
                `state: ${result.state}`,
                `frame_hits: ${result.frameCount}`,
                `keyword_hits: ${result.keywordHits || 0}`,
                `service_hits: ${result.serviceHits || 0}`,
                `service_decoded: ${result.serviceDecoded || 0}`,
                `service_status: ${result.serviceStatus || 'unknown'}`,
                `total_frames: ${result.totalFrames}`,
                `decoded_frames: ${result.decodedFrames}`,
                '',
                'decoded_frame_samples:',
                ...(result.debugFrames.length
                    ? result.debugFrames.map((f, i) => `[${i + 1}] ${f}`)
                    : ['(none)']),
            ];

            const debugName = `wsdebug-${number}-${Date.now()}.txt`;
            const debugPath = path.join(os.tmpdir(), debugName);
            await fs.writeFile(debugPath, rows.join('\n'), 'utf8');

            try {
                const debugMedia = MessageMedia.fromFilePath(debugPath);
                await msg.reply(debugMedia, null, { sendMediaAsDocument: true });
                await msg.reply('已回传 WebSocket 解码摘要 TXT。');
            } catch (sendErr) {
                await msg.reply(
                    [
                        'TXT发送失败，已降级为文本回传。',
                        ...rows.slice(0, 35),
                    ].join('\n'),
                );
                log(`wsdebug 文档发送失败，已降级文本: ${sendErr?.message || sendErr}`);
            }

            await fs.unlink(debugPath).catch(() => {});
            log(`wsdebug 已处理: ${number}`);
        } catch (error) {
            await msg.reply(
                `wsdebug 执行失败，请稍后重试。错误: ${error?.message || error}`,
            );
            log(`wsdebug 失败: ${error?.message || error}`);
        }
        return;
    }

    if (msg.body.startsWith('!behavior ')) {
        const input = msg.body.slice('!behavior '.length).trim();
        const number = normalizePhoneInput(input);

        if (!number) {
            await msg.reply('用法: !behavior 8613800138000');
            log('behavior 参数缺失');
            return;
        }

        try {
            await msg.reply('开始模拟页面行为检测，请稍候 6-10 秒...');
            log(`behavior 开始执行: ${number}`);

            const result = await runWithExecutionClient(
                currentClientId,
                (execClient) => checkNumberBehavior(execClient, number, 5000),
            );
            if (!result.ok) {
                await msg.reply(`行为检测失败: ${result.message}`);
                log(`behavior 失败: ${number}, ${result.message}`);
                return;
            }

            await msg.reply(
                [
                    `号码: ${result.number}`,
                    `行为判定: ${result.behavior}`,
                    '说明: valid=可进入聊天输入框, invalid=页面明确无效, unknown=无法明确判断',
                ].join('\n'),
            );
            log(`behavior 已处理: ${result.number} => ${result.behavior}`);
        } catch (error) {
            await msg.reply('行为检测异常，请稍后重试。');
            log(`behavior 失败: ${error?.message || error}`);
        }
        return;
    }

    if (msg.body === '!probe') {
        awaitingTxtModeByChat.set(chatScopeKey, 'probe');
        await msg.reply(
            '请发送TXT文件（每行一个号码或混排文本均可），我会自动提取号码并回传活跃探测结果TXT。',
        );
        log(`进入probe TXT等待状态: ${currentClientId}/${chatId}`);
        return;
    }

    if (msg.body.startsWith('!probe ')) {
        const raw = msg.body.slice('!probe '.length).trim();
        const [firstToken, ...restTokens] = raw.split(/\s+/);
        const number = normalizePhoneInput(firstToken || '');

        if (!number) {
            await msg.reply('用法: !probe 8613800138000 [可选探测文本]');
            log('probe 参数缺失');
            return;
        }

        const customText = restTokens.join(' ').trim();
        const probeText = customText || PROBE_TEXT;

        try {
            await msg.reply(
                `开始探测 ${number}，发送探测消息并等待ACK（约${Math.floor(
                    PROBE_TIMEOUT_MS / 1000,
                )}秒）...`,
            );

            const result = await runWithExecutionClient(
                currentClientId,
                (execClient) => runProbeForNumber(execClient, number, probeText),
            );
            if (result.activity === 'not_exist') {
                await msg.reply(
                    [`号码: ${number}`, '探测结果: not_exist', '说明: 号码未注册'].join(
                        '\n',
                    ),
                );
                log(`probe 未注册: ${number}`);
                return;
            }

            await msg.reply(
                [
                    `号码: ${number}`,
                    `探测结果: ${result.activity}`,
                    `ack: ${result.ack === null ? 'timeout' : result.ack}`,
                    `通道: ${result.source}`,
                    '说明: ack=1 为单勾；ack=2 为双勾（灰/蓝）',
                ].join('\n'),
            );

            log(
                `probe 已处理: ${number} => ${result.activity} (ack=${
                    result.ack === null ? 'timeout' : result.ack
                })`,
            );
        } catch (error) {
            await msg.reply('probe 探测异常，请稍后重试。');
            log(`probe 失败: ${error?.message || error}`);
        }
        return;
    }

    if (msg.body.startsWith('!checknum')) {
        awaitingTxtModeByChat.set(chatScopeKey, 'checknum');
        await msg.reply(
            '请发送TXT文件（每行一个号码或混排文本均可），我会自动提取号码并回传检测结果TXT。',
        );
        log(`进入TXT检测等待状态: ${currentClientId}/${chatId}`);
        return;
    }
}

async function start() {
    server.listen(PORT, HOST, () => {
        log(`可视化页面已启动: http://${HOST}:${PORT}`);
        log(`账号池已配置: ${CLIENT_IDS.join(', ')}`);
    });

    for (const clientId of CLIENT_IDS) {
        buildClient(clientId);
    }

    await Promise.allSettled(
        [...clientPool.values()].map((entry) => entry.client.initialize()),
    );
}

async function shutdown() {
    log('准备关闭可视化服务...');
    try {
        await Promise.allSettled(
            [...clientPool.values()].map((entry) => entry.client.destroy()),
        );
    } catch {}
    io.close();
    server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => {
    setStatus('crashed');
    log(`启动失败: ${err?.message || err}`);
    process.exit(1);
});
