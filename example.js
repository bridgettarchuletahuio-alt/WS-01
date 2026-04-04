const {
    Client,
    Location,
    Poll,
    List,
    Buttons,
    LocalAuth,
    MessageMedia,
} = require('./index');
const fetch = require('node-fetch');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

let qrcode = null;
try {
    qrcode = require('qrcode-terminal');
} catch {}

const isHeadlessEnv = !process.env.DISPLAY;
const botStartedAt = Date.now();
const awaitingChecknumTxtByChat = new Set();
const botStats = {
    messagesReceived: 0,
    commandsProcessed: 0,
    repliesSent: 0,
    broadcastsSent: 0,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const formatUptime = (ms) => {
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
};

const askViaDuckDuckGo = async (question) => {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(question)}&format=json&no_html=1&skip_disambig=1`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.AbstractText) return data.AbstractText;
    if (Array.isArray(data.RelatedTopics)) {
        const firstRelated = data.RelatedTopics.find((item) => item?.Text);
        if (firstRelated?.Text) return firstRelated.Text;
    }

    return '我暂时没有检索到明确答案，请换个问法再试试。';
};

const normalizePhoneInput = (raw) => raw.replace(/[^0-9]/g, '');

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

const checkActivityByWsFrames = async (clientRef, rawNumber, waitMs = 5000) => {
    const number = normalizePhoneInput(rawNumber);
    if (!number) {
        return {
            ok: false,
            message: '号码为空或格式无效',
        };
    }

    const cdp = await clientRef.pupPage.target().createCDPSession();
    await cdp.send('Network.enable');

    const hits = [];
    const keywords = ['presence', 'last', 'status', 'jid', '404', 'available'];
    const numberHints = [number, `${number}@c.us`, `${number}@s.whatsapp.net`];

    const normalizeFrameText = (event) => {
        const payload =
            event?.response?.payloadData || event?.request?.payloadData || '';
        if (!payload) return '';

        const opcode = event?.response?.opcode ?? event?.request?.opcode;
        if (opcode === 2) {
            try {
                return Buffer.from(payload, 'base64').toString('utf8').toLowerCase();
            } catch {
                return '';
            }
        }

        return String(payload).toLowerCase();
    };

    const onFrame = (event) => {
        const text = normalizeFrameText(event);
        if (!text) return;
        if (!keywords.some((k) => text.includes(k))) return;
        if (!numberHints.some((hint) => text.includes(hint.toLowerCase()))) return;

        hits.push(text.slice(0, 600));
    };

    cdp.on('Network.webSocketFrameReceived', onFrame);
    cdp.on('Network.webSocketFrameSent', onFrame);

    try {
        await clientRef.pupPage.goto(
            `https://web.whatsapp.com/send?phone=${number}`,
            { waitUntil: 'domcontentloaded' },
        );
        await sleep(Math.max(waitMs, 8000));
    } finally {
        cdp.off('Network.webSocketFrameReceived', onFrame);
        cdp.off('Network.webSocketFrameSent', onFrame);
        await cdp.detach().catch(() => {});
    }

    const merged = hits.join('\n');
    let state = 'unknown';
    if (merged.includes('404')) state = 'unregistered';
    else if (merged.includes('presence') && merged.includes('available'))
        state = 'online';
    else if (merged.includes('last')) state = 'recent_activity';
    else if (merged.includes('status')) state = 'status_signal';

    // Fallback to registration-based verdict when presence signals are absent.
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
        frameCount: hits.length,
        sample: hits[0] || '',
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

const client = new Client({
    authStrategy: new LocalAuth(),
    // proxyAuthentication: { username: 'username', password: 'password' },
    /**
     * This option changes the browser name from defined in user agent to custom.
     */
    // deviceName: 'Your custom name',
    /**
     * This option changes browser type from defined in user agent to yours. It affects the browser icon
     * that is displayed in 'linked devices' section.
     * Valid value are: 'Chrome' | 'Firefox' | 'IE' | 'Opera' | 'Safari' | 'Edge'.
     * If another value is provided, the browser icon in 'linked devices' section will be gray.
     */
    // browserName: 'Firefox',
    puppeteer: {
        // args: ['--proxy-server=proxy-server-that-requires-authentication.example.com'],
        headless: isHeadlessEnv,
        args: isHeadlessEnv
            ? ['--no-sandbox', '--disable-setuid-sandbox']
            : [],
    },
    // pairWithPhoneNumber: {
    //     phoneNumber: '96170100100' // Pair with phone number (format: <COUNTRY_CODE><PHONE_NUMBER>)
    //     showNotification: true,
    //     intervalMs: 180000 // Time to renew pairing code in milliseconds, defaults to 3 minutes
    // }
});

// client initialize does not finish at ready now.
client.initialize();

console.log(
    `Example booted (${isHeadlessEnv ? 'headless' : 'headful'} mode).`,
);
console.log(
    'After READY, send "!help" to view command list, or "!ping" for a quick test.',
);

client.on('loading_screen', (percent, message) => {
    console.log('LOADING SCREEN', percent, message);
});

client.on('qr', async (qr) => {
    // NOTE: This event will not be fired if a session is specified.
    console.log('QR RECEIVED');
    if (qrcode) {
        qrcode.generate(qr, { small: true });
    } else {
        console.log(
            'Install qrcode-terminal for in-terminal QR rendering: npm i qrcode-terminal --no-save',
        );
        console.log(qr);
    }
});

client.on('code', (code) => {
    console.log('Pairing code:', code);
});

client.on('authenticated', () => {
    console.log('AUTHENTICATED');
});

client.on('auth_failure', (msg) => {
    // Fired if session restore was unsuccessful
    console.error('AUTHENTICATION FAILURE', msg);
});

client.on('ready', async () => {
    console.log('READY');
    const debugWWebVersion = await client.getWWebVersion();
    console.log(`WWebVersion = ${debugWWebVersion}`);

    client.pupPage.on('pageerror', function (err) {
        console.log('Page error: ' + err.toString());
    });
    client.pupPage.on('error', function (err) {
        console.log('Page error: ' + err.toString());
    });
});

client.on('message', async (msg) => {
    console.log('MESSAGE RECEIVED', msg);
    botStats.messagesReceived++;

    if (msg.body.startsWith('!')) {
        botStats.commandsProcessed++;
    }

    if (msg.body === '!help') {
        await msg.reply(
            [
                '*可用命令*',
                '!ping - 机器人回复 pong',
                '!echo 文本 - 原样回显',
                '!ask 问题 - 在线检索简要答案',
                '!checknum - 发送后上传TXT，机器人检测并回传TXT结果',
                '!activity 8613800138000 - 基于WebSocket帧做活跃状态探测',
                '!behavior 8613800138000 - 模拟页面行为检测号码状态',
                '!stats - 查看机器人运行统计',
                '!broadcast 文本 - 广播到所有私聊会话',
            ].join('\n'),
        );
        botStats.repliesSent++;
    } else if (msg.body === '!ping reply') {
        // Send a new message as a reply to the current one
        msg.reply('pong');
    } else if (msg.body === '!ping') {
        // Send a new message to the same chat
        client.sendMessage(msg.from, 'pong');
    } else if (msg.body.startsWith('!ask ')) {
        const question = msg.body.slice(5).trim();
        if (!question) {
            await msg.reply('用法: !ask 你的问题');
            botStats.repliesSent++;
        } else {
            try {
                const answer = await askViaDuckDuckGo(question);
                await msg.reply(`*Q:* ${question}\n*AI:* ${answer}`);
                botStats.repliesSent++;
            } catch (error) {
                await msg.reply('检索失败，请稍后重试。');
                botStats.repliesSent++;
            }
        }
    } else if (msg.body.startsWith('!activity ')) {
        const input = msg.body.slice('!activity '.length).trim();
        const number = normalizePhoneInput(input);
        if (!number) {
            await msg.reply('用法: !activity 8613800138000');
            botStats.repliesSent++;
        } else {
            await msg.reply('开始探测活跃状态，请稍候 3-6 秒...');
            botStats.repliesSent++;
            try {
                const result = await checkActivityByWsFrames(client, number, 5000);
                if (!result.ok) {
                    await msg.reply(`探测失败: ${result.message}`);
                    botStats.repliesSent++;
                } else {
                    await msg.reply(
                        [
                            `号码: ${result.number}`,
                            `状态判定: ${result.state}`,
                            `命中帧数: ${result.frameCount}`,
                            `样本: ${(result.sample || '无').slice(0, 180)}`,
                        ].join('\n'),
                    );
                    botStats.repliesSent++;
                }
            } catch (error) {
                await msg.reply('活跃探测异常，请稍后重试。');
                botStats.repliesSent++;
            }
        }
    } else if (msg.body.startsWith('!behavior ')) {
        const input = msg.body.slice('!behavior '.length).trim();
        const number = normalizePhoneInput(input);
        if (!number) {
            await msg.reply('用法: !behavior 8613800138000');
            botStats.repliesSent++;
        } else {
            await msg.reply('开始模拟页面行为检测，请稍候 6-10 秒...');
            botStats.repliesSent++;
            try {
                const result = await checkNumberBehavior(client, number, 5000);
                if (!result.ok) {
                    await msg.reply(`行为检测失败: ${result.message}`);
                    botStats.repliesSent++;
                } else {
                    await msg.reply(
                        [
                            `号码: ${result.number}`,
                            `行为判定: ${result.behavior}`,
                            '说明: valid=可进入聊天输入框, invalid=页面明确无效, unknown=无法明确判断',
                        ].join('\n'),
                    );
                    botStats.repliesSent++;
                }
            } catch (error) {
                await msg.reply('行为检测异常，请稍后重试。');
                botStats.repliesSent++;
            }
        }
    } else if (msg.body.startsWith('!checknum')) {
        awaitingChecknumTxtByChat.add(msg.from);
        await msg.reply(
            '请发送TXT文件（每行一个号码或混排文本均可），我会自动提取号码并回传检测结果TXT。',
        );
        botStats.repliesSent++;
    } else if (
        awaitingChecknumTxtByChat.has(msg.from) &&
        msg.hasMedia &&
        !msg.body?.startsWith('!')
    ) {
        try {
            const media = await msg.downloadMedia();
            const filename = media?.filename || 'numbers.txt';
            const isTxt =
                media?.mimetype === 'text/plain' || filename.endsWith('.txt');

            if (!media || !isTxt) {
                await msg.reply('请发送TXT文件（.txt）');
                botStats.repliesSent++;
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
                awaitingChecknumTxtByChat.delete(msg.from);
                botStats.repliesSent++;
                return;
            }

            await msg.reply(
                `已收到文件，开始检测 ${numbers.length} 个号码，请稍候...`,
            );
            botStats.repliesSent++;

            const rows = ['number\tstatus\twa_id'];
            for (const number of numbers) {
                try {
                    const numberId = await client.getNumberId(number);
                    const status = numberId ? 'valid' : 'invalid';
                    const waId = numberId?._serialized || `${number}@c.us`;
                    rows.push(`${number}\t${status}\t${waId}`);
                } catch {
                    rows.push(`${number}\terror\t-`);
                }
            }

            const resultName = `checknum-result-${Date.now()}.txt`;
            const resultPath = path.join(os.tmpdir(), resultName);
            await fs.writeFile(resultPath, rows.join('\n'), 'utf8');

            const resultMedia = MessageMedia.fromFilePath(resultPath);
            await msg.reply(resultMedia, null, { sendMediaAsDocument: true });
            await msg.reply(`检测完成，结果已通过TXT回传（${numbers.length}条）。`);
            botStats.repliesSent += 2;

            await fs.unlink(resultPath).catch(() => {});
            awaitingChecknumTxtByChat.delete(msg.from);
        } catch (error) {
            awaitingChecknumTxtByChat.delete(msg.from);
            await msg.reply('处理TXT失败，请重试。');
            botStats.repliesSent++;
        }
    } else if (msg.body === '!stats') {
        await msg.reply(
            [
                '*Bot 运行统计*',
                `Uptime: ${formatUptime(Date.now() - botStartedAt)}`,
                `Messages: ${botStats.messagesReceived}`,
                `Commands: ${botStats.commandsProcessed}`,
                `Replies: ${botStats.repliesSent}`,
                `Broadcast messages: ${botStats.broadcastsSent}`,
            ].join('\n'),
        );
        botStats.repliesSent++;
    } else if (msg.body.startsWith('!broadcast ')) {
        const text = msg.body.slice('!broadcast '.length).trim();
        if (!text) {
            await msg.reply('用法: !broadcast 你要群发的文本');
            botStats.repliesSent++;
        } else {
            const chats = await client.getChats();
            const targets = chats.filter((chat) =>
                chat.id?._serialized?.endsWith('@c.us'),
            );

            let success = 0;
            let failed = 0;

            for (const target of targets) {
                try {
                    await client.sendMessage(target.id._serialized, text);
                    success++;
                    botStats.broadcastsSent++;
                } catch {
                    failed++;
                }
            }

            await msg.reply(
                `广播完成。成功: ${success}，失败: ${failed}，目标会话: ${targets.length}`,
            );
            botStats.repliesSent++;
        }
    } else if (msg.body.startsWith('!sendto ')) {
        // Direct send a new message to specific id
        let number = msg.body.split(' ')[1];
        let messageIndex = msg.body.indexOf(number) + number.length;
        let message = msg.body.slice(messageIndex, msg.body.length);
        number = number.includes('@c.us') ? number : `${number}@c.us`;
        let chat = await msg.getChat();
        chat.sendSeen();
        client.sendMessage(number, message);
    } else if (msg.body.startsWith('!subject ')) {
        // Change the group subject
        let chat = await msg.getChat();
        if (chat.isGroup) {
            let newSubject = msg.body.slice(9);
            chat.setSubject(newSubject);
        } else {
            msg.reply('This command can only be used in a group!');
        }
    } else if (msg.body.startsWith('!echo ')) {
        // Replies with the same message
        msg.reply(msg.body.slice(6));
    } else if (msg.body.startsWith('!preview ')) {
        const text = msg.body.slice(9);
        msg.reply(text, null, { linkPreview: true });
    } else if (msg.body.startsWith('!desc ')) {
        // Change the group description
        let chat = await msg.getChat();
        if (chat.isGroup) {
            let newDescription = msg.body.slice(6);
            chat.setDescription(newDescription);
        } else {
            msg.reply('This command can only be used in a group!');
        }
    } else if (msg.body === '!leave') {
        // Leave the group
        let chat = await msg.getChat();
        if (chat.isGroup) {
            chat.leave();
        } else {
            msg.reply('This command can only be used in a group!');
        }
    } else if (msg.body.startsWith('!join ')) {
        const inviteCode = msg.body.split(' ')[1];
        try {
            await client.acceptInvite(inviteCode);
            msg.reply('Joined the group!');
        } catch (e) {
            msg.reply('That invite code seems to be invalid.');
        }
    } else if (msg.body.startsWith('!addmembers')) {
        const group = await msg.getChat();
        const result = await group.addParticipants([
            'number1@c.us',
            'number2@c.us',
            'number3@c.us',
        ]);
        /**
         * The example of the {@link result} output:
         *
         * {
         *   'number1@c.us': {
         *     code: 200,
         *     message: 'The participant was added successfully',
         *     isInviteV4Sent: false
         *   },
         *   'number2@c.us': {
         *     code: 403,
         *     message: 'The participant can be added by sending private invitation only',
         *     isInviteV4Sent: true
         *   },
         *   'number3@c.us': {
         *     code: 404,
         *     message: 'The phone number is not registered on WhatsApp',
         *     isInviteV4Sent: false
         *   }
         * }
         *
         * For more usage examples:
         * @see https://github.com/pedroslopez/whatsapp-web.js/pull/2344#usage-example1
         */
        console.log(result);
    } else if (msg.body === '!creategroup') {
        const partitipantsToAdd = [
            'number1@c.us',
            'number2@c.us',
            'number3@c.us',
        ];
        const result = await client.createGroup(
            'Group Title',
            partitipantsToAdd,
        );
        /**
         * The example of the {@link result} output:
         * {
         *   title: 'Group Title',
         *   gid: {
         *     server: 'g.us',
         *     user: '1111111111',
         *     _serialized: '1111111111@g.us'
         *   },
         *   participants: {
         *     'botNumber@c.us': {
         *       statusCode: 200,
         *       message: 'The participant was added successfully',
         *       isGroupCreator: true,
         *       isInviteV4Sent: false
         *     },
         *     'number1@c.us': {
         *       statusCode: 200,
         *       message: 'The participant was added successfully',
         *       isGroupCreator: false,
         *       isInviteV4Sent: false
         *     },
         *     'number2@c.us': {
         *       statusCode: 403,
         *       message: 'The participant can be added by sending private invitation only',
         *       isGroupCreator: false,
         *       isInviteV4Sent: true
         *     },
         *     'number3@c.us': {
         *       statusCode: 404,
         *       message: 'The phone number is not registered on WhatsApp',
         *       isGroupCreator: false,
         *       isInviteV4Sent: false
         *     }
         *   }
         * }
         *
         * For more usage examples:
         * @see https://github.com/pedroslopez/whatsapp-web.js/pull/2344#usage-example2
         */
        console.log(result);
    } else if (msg.body === '!groupinfo') {
        let chat = await msg.getChat();
        if (chat.isGroup) {
            msg.reply(`
                *Group Details*
                Name: ${chat.name}
                Description: ${chat.description}
                Created At: ${chat.createdAt.toString()}
                Created By: ${chat.owner.user}
                Participant count: ${chat.participants.length}
            `);
        } else {
            msg.reply('This command can only be used in a group!');
        }
    } else if (msg.body === '!chats') {
        const chats = await client.getChats();
        client.sendMessage(msg.from, `The bot has ${chats.length} chats open.`);
    } else if (msg.body === '!info') {
        let info = client.info;
        client.sendMessage(
            msg.from,
            `
            *Connection info*
            User name: ${info.pushname}
            My number: ${info.wid.user}
            Platform: ${info.platform}
        `,
        );
    } else if (msg.body === '!mediainfo' && msg.hasMedia) {
        const attachmentData = await msg.downloadMedia();
        msg.reply(`
            *Media info*
            MimeType: ${attachmentData.mimetype}
            Filename: ${attachmentData.filename}
            Data (length): ${attachmentData.data.length}
        `);
    } else if (msg.body === '!quoteinfo' && msg.hasQuotedMsg) {
        const quotedMsg = await msg.getQuotedMessage();

        quotedMsg.reply(`
            ID: ${quotedMsg.id._serialized}
            Type: ${quotedMsg.type}
            Author: ${quotedMsg.author || quotedMsg.from}
            Timestamp: ${quotedMsg.timestamp}
            Has Media? ${quotedMsg.hasMedia}
        `);
    } else if (msg.body === '!resendmedia' && msg.hasQuotedMsg) {
        const quotedMsg = await msg.getQuotedMessage();
        if (quotedMsg.hasMedia) {
            const attachmentData = await quotedMsg.downloadMedia();
            client.sendMessage(msg.from, attachmentData, {
                caption: "Here's your requested media.",
            });
        }
        if (quotedMsg.hasMedia && quotedMsg.type === 'audio') {
            const audio = await quotedMsg.downloadMedia();
            await client.sendMessage(msg.from, audio, {
                sendAudioAsVoice: true,
            });
        }
    } else if (msg.body === '!isviewonce' && msg.hasQuotedMsg) {
        const quotedMsg = await msg.getQuotedMessage();
        if (quotedMsg.hasMedia) {
            const media = await quotedMsg.downloadMedia();
            await client.sendMessage(msg.from, media, { isViewOnce: true });
        }
    } else if (msg.body === '!location') {
        // only latitude and longitude
        await msg.reply(new Location(37.422, -122.084));
        // location with name only
        await msg.reply(new Location(37.422, -122.084, { name: 'Googleplex' }));
        // location with address only
        await msg.reply(
            new Location(37.422, -122.084, {
                address: '1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA',
            }),
        );
        // location with name, address and url
        await msg.reply(
            new Location(37.422, -122.084, {
                name: 'Googleplex',
                address: '1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA',
                url: 'https://google.com',
            }),
        );
    } else if (msg.location) {
        msg.reply(msg.location);
    } else if (msg.body.startsWith('!status ')) {
        const newStatus = msg.body.split(' ')[1];
        await client.setStatus(newStatus);
        msg.reply(`Status was updated to *${newStatus}*`);
    } else if (msg.body === '!mentionUsers') {
        const chat = await msg.getChat();
        const userNumber = 'XXXXXXXXXX';
        /**
         * To mention one user you can pass user's ID to 'mentions' property as is,
         * without wrapping it in Array, and a user's phone number to the message body:
         */
        await chat.sendMessage(`Hi @${userNumber}`, {
            mentions: userNumber + '@c.us',
        });
        // To mention a list of users:
        await chat.sendMessage(`Hi @${userNumber}, @${userNumber}`, {
            mentions: [userNumber + '@c.us', userNumber + '@c.us'],
        });
    } else if (msg.body === '!mentionGroups') {
        const chat = await msg.getChat();
        const groupId = 'YYYYYYYYYY@g.us';
        /**
         * Sends clickable group mentions, the same as user mentions.
         * When the mentions are clicked, it opens a chat with the mentioned group.
         * The 'groupMentions.subject' can be custom
         *
         * @note The user that does not participate in the mentioned group,
         * will not be able to click on that mentioned group, the same if the group does not exist
         *
         * To mention one group:
         */
        await chat.sendMessage(`Check the last message here: @${groupId}`, {
            groupMentions: { subject: 'GroupSubject', id: groupId },
        });
        // To mention a list of groups:
        await chat.sendMessage(
            `Check the last message in these groups: @${groupId}, @${groupId}`,
            {
                groupMentions: [
                    { subject: 'FirstGroup', id: groupId },
                    { subject: 'SecondGroup', id: groupId },
                ],
            },
        );
    } else if (msg.body === '!getGroupMentions') {
        // To get group mentions from a message:
        const groupId = 'ZZZZZZZZZZ@g.us';
        const msg = await client.sendMessage(
            'chatId',
            `Check the last message here: @${groupId}`,
            {
                groupMentions: { subject: 'GroupSubject', id: groupId },
            },
        );
        /** {@link groupMentions} is an array of `GroupChat` */
        const groupMentions = await msg.getGroupMentions();
        console.log(groupMentions);
    } else if (msg.body === '!delete') {
        if (msg.hasQuotedMsg) {
            const quotedMsg = await msg.getQuotedMessage();
            if (quotedMsg.fromMe) {
                quotedMsg.delete(true);
            } else {
                msg.reply('I can only delete my own messages');
            }
        }
    } else if (msg.body === '!pin') {
        const chat = await msg.getChat();
        await chat.pin();
    } else if (msg.body === '!archive') {
        const chat = await msg.getChat();
        await chat.archive();
    } else if (msg.body === '!mute') {
        const chat = await msg.getChat();
        // mute the chat for 20 seconds
        const unmuteDate = new Date();
        unmuteDate.setSeconds(unmuteDate.getSeconds() + 20);
        await chat.mute(unmuteDate);
    } else if (msg.body === '!typing') {
        const chat = await msg.getChat();
        // simulates typing in the chat
        chat.sendStateTyping();
    } else if (msg.body === '!recording') {
        const chat = await msg.getChat();
        // simulates recording audio in the chat
        chat.sendStateRecording();
    } else if (msg.body === '!clearstate') {
        const chat = await msg.getChat();
        // stops typing or recording in the chat
        chat.clearState();
    } else if (msg.body === '!jumpto') {
        if (msg.hasQuotedMsg) {
            const quotedMsg = await msg.getQuotedMessage();
            client.interface.openChatWindowAt(quotedMsg.id._serialized);
        }
    } else if (msg.body === '!buttons') {
        let button = new Buttons(
            'Button body',
            [{ body: 'bt1' }, { body: 'bt2' }, { body: 'bt3' }],
            'title',
            'footer',
        );
        client.sendMessage(msg.from, button);
    } else if (msg.body === '!list') {
        let sections = [
            {
                title: 'sectionTitle',
                rows: [
                    { title: 'ListItem1', description: 'desc' },
                    { title: 'ListItem2' },
                ],
            },
        ];
        let list = new List(
            'List body',
            'btnText',
            sections,
            'Title',
            'footer',
        );
        client.sendMessage(msg.from, list);
    } else if (msg.body === '!reaction') {
        await msg.react('👍');
    } else if (msg.body === '!sendpoll') {
        /** By default the poll is created as a single choice poll: */
        await msg.reply(new Poll('Winter or Summer?', ['Winter', 'Summer']));
        /** If you want to provide a multiple choice poll, add allowMultipleAnswers as true: */
        await msg.reply(
            new Poll('Cats or Dogs?', ['Cats', 'Dogs'], {
                allowMultipleAnswers: true,
            }),
        );
        /**
         * You can provide a custom message secret, it can be used as a poll ID:
         * @note It has to be a unique vector with a length of 32
         */
        await msg.reply(
            new Poll('Cats or Dogs?', ['Cats', 'Dogs'], {
                messageSecret: [
                    1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                ],
            }),
        );
    } else if (msg.body === '!vote') {
        if (msg.hasQuotedMsg) {
            const quotedMsg = await msg.getQuotedMessage();
            if (quotedMsg.type === 'poll_creation') {
                await quotedMsg.vote(msg.body.replace('!vote', ''));
            } else {
                msg.reply('Can only be used on poll messages');
            }
        }
    } else if (msg.body === '!edit') {
        if (msg.hasQuotedMsg) {
            const quotedMsg = await msg.getQuotedMessage();
            if (quotedMsg.fromMe) {
                await quotedMsg.edit(msg.body.replace('!edit', ''));
            } else {
                msg.reply('I can only edit my own messages');
            }
        }
    } else if (msg.body === '!updatelabels') {
        const chat = await msg.getChat();
        await chat.changeLabels([0, 1]);
    } else if (msg.body === '!addlabels') {
        const chat = await msg.getChat();
        let labels = (await chat.getLabels()).map((l) => l.id);
        labels.push('0');
        labels.push('1');
        await chat.changeLabels(labels);
    } else if (msg.body === '!removelabels') {
        const chat = await msg.getChat();
        await chat.changeLabels([]);
    } else if (msg.body === '!approverequest') {
        /**
         * Presented an example for membership request approvals, the same examples are for the request rejections.
         * To approve the membership request from a specific user:
         */
        await client.approveGroupMembershipRequests(msg.from, {
            requesterIds: 'number@c.us',
        });
        /** The same for execution on group object (no need to provide the group ID): */
        const group = await msg.getChat();
        await group.approveGroupMembershipRequests({
            requesterIds: 'number@c.us',
        });
        /** To approve several membership requests: */
        const approval = await client.approveGroupMembershipRequests(msg.from, {
            requesterIds: ['number1@c.us', 'number2@c.us'],
        });
        /**
         * The example of the {@link approval} output:
         * [
         *   {
         *     requesterId: 'number1@c.us',
         *     message: 'Rejected successfully'
         *   },
         *   {
         *     requesterId: 'number2@c.us',
         *     error: 404,
         *     message: 'ParticipantRequestNotFoundError'
         *   }
         * ]
         *
         */
        console.log(approval);
        /** To approve all the existing membership requests (simply don't provide any user IDs): */
        await client.approveGroupMembershipRequests(msg.from);
        /** To change the sleep value to 300 ms: */
        await client.approveGroupMembershipRequests(msg.from, {
            requesterIds: ['number1@c.us', 'number2@c.us'],
            sleep: 300,
        });
        /** To change the sleep value to random value between 100 and 300 ms: */
        await client.approveGroupMembershipRequests(msg.from, {
            requesterIds: ['number1@c.us', 'number2@c.us'],
            sleep: [100, 300],
        });
        /** To explicitly disable the sleep: */
        await client.approveGroupMembershipRequests(msg.from, {
            requesterIds: ['number1@c.us', 'number2@c.us'],
            sleep: null,
        });
    } else if (msg.body === '!pinmsg') {
        /**
         * Pins a message in a chat, a method takes a number in seconds for the message to be pinned.
         * WhatsApp default values for duration to pass to the method are:
         * 1. 86400 for 24 hours
         * 2. 604800 for 7 days
         * 3. 2592000 for 30 days
         * You can pass your own value:
         */
        const result = await msg.pin(60); // Will pin a message for 1 minute
        console.log(result); // True if the operation completed successfully, false otherwise
    } else if (msg.body === '!howManyConnections') {
        /**
         * Get user device count by ID
         * Each WaWeb Connection counts as one device, and the phone (if exists) counts as one
         * So for a non-enterprise user with one WaWeb connection it should return "2"
         */
        let deviceCount = await client.getContactDeviceCount(msg.from);
        await msg.reply(`You have *${deviceCount}* devices connected`);
    } else if (msg.body === '!syncHistory') {
        const isSynced = await client.syncHistory(msg.from);
        // Or through the Chat object:
        // const chat = await client.getChatById(msg.from);
        // const isSynced = await chat.syncHistory();

        await msg.reply(
            isSynced
                ? 'Historical chat is syncing..'
                : 'There is no historical chat to sync.',
        );
    } else if (msg.body === '!statuses') {
        const statuses = await client.getBroadcasts();
        console.log(statuses);
        const chat = await statuses[0]?.getChat(); // Get user chat of a first status
        console.log(chat);
    } else if (msg.body === '!sendMediaHD' && msg.hasQuotedMsg) {
        const quotedMsg = await msg.getQuotedMessage();
        if (quotedMsg.hasMedia) {
            const media = await quotedMsg.downloadMedia();
            await client.sendMessage(msg.from, media, { sendMediaAsHd: true });
        }
    } else if (msg.body === '!parseVCard') {
        const vCard =
            'BEGIN:VCARD\n' +
            'VERSION:3.0\n' +
            'FN:John Doe\n' +
            'ORG:Microsoft;\n' +
            'EMAIL;type=INTERNET:john.doe@gmail.com\n' +
            'URL:www.johndoe.com\n' +
            'TEL;type=CELL;type=VOICE;waid=18006427676:+1 (800) 642 7676\n' +
            'END:VCARD';
        const vCardExtended =
            'BEGIN:VCARD\n' +
            'VERSION:3.0\n' +
            'FN:John Doe\n' +
            'ORG:Microsoft;\n' +
            'item1.TEL:+1 (800) 642 7676\n' +
            'item1.X-ABLabel:USA Customer Service\n' +
            'item2.TEL:+55 11 4706 0900\n' +
            'item2.X-ABLabel:Brazil Customer Service\n' +
            'PHOTO;BASE64:here you can paste a binary data of a contact photo in Base64 encoding\n' +
            'END:VCARD';
        const userId = 'XXXXXXXXXX@c.us';
        await client.sendMessage(userId, vCard);
        await client.sendMessage(userId, vCardExtended);
    } else if (msg.body === '!changeSync') {
        // NOTE: this action will take effect after you restart the client.
        const backgroundSync = await client.setBackgroundSync(true);
        console.log(backgroundSync);
    } else if (msg.body === '!postStatus') {
        await client.sendMessage('status@broadcast', 'Hello there!');
        // send with a different style
        await client.sendMessage(
            'status@broadcast',
            'Hello again! Looks different?',
            {
                fontStyle: 1,
                backgroundColor: '#0b3296',
            },
        );
    }
});

client.on('message_create', async (msg) => {
    // Fired on all message creations, including your own
    if (msg.fromMe) {
        // do stuff here
    }

    // Unpins a message
    if (msg.fromMe && msg.body.startsWith('!unpin')) {
        const pinnedMsg = await msg.getQuotedMessage();
        if (pinnedMsg) {
            // Will unpin a message
            const result = await pinnedMsg.unpin();
            console.log(result); // True if the operation completed successfully, false otherwise
        }
    }
});

client.on('message_ciphertext', (msg) => {
    // Receiving new incoming messages that have been encrypted
    // msg.type === 'ciphertext'
    msg.body = 'Waiting for this message. Check your phone.';

    // do stuff here
});

client.on('message_revoke_everyone', async (after, before) => {
    // Fired whenever a message is deleted by anyone (including you)
    console.log(after); // message after it was deleted.
    if (before) {
        console.log(before); // message before it was deleted.
    }
});

client.on('message_revoke_me', async (msg) => {
    // Fired whenever a message is only deleted in your own view.
    console.log(msg.body); // message before it was deleted.
});

client.on('message_ack', (msg, ack) => {
    /*
        == ACK VALUES ==
        ACK_ERROR: -1
        ACK_PENDING: 0
        ACK_SERVER: 1
        ACK_DEVICE: 2
        ACK_READ: 3
        ACK_PLAYED: 4
    */

    if (ack == 3) {
        // The message was read
    }
});

client.on('group_join', (notification) => {
    // User has joined or been added to the group.
    console.log('join', notification);
    notification.reply('User joined.');
});

client.on('group_leave', (notification) => {
    // User has left or been kicked from the group.
    console.log('leave', notification);
    notification.reply('User left.');
});

client.on('group_update', (notification) => {
    // Group picture, subject or description has been updated.
    console.log('update', notification);
});

client.on('change_state', (state) => {
    console.log('CHANGE STATE', state);
});

// Change to false if you don't want to reject incoming calls
let rejectCalls = true;

client.on('call', async (call) => {
    console.log('Call received, rejecting. GOTO Line 261 to disable', call);
    if (rejectCalls) await call.reject();
    await client.sendMessage(
        call.from,
        `[${call.fromMe ? 'Outgoing' : 'Incoming'}] Phone call from ${call.from}, type ${call.isGroup ? 'group' : ''} ${call.isVideo ? 'video' : 'audio'} call. ${rejectCalls ? 'This call was automatically rejected by the script.' : ''}`,
    );
});

client.on('disconnected', (reason) => {
    console.log('Client was logged out', reason);
});

client.on('contact_changed', async (message, oldId, newId, isContact) => {
    /** The time the event occurred. */
    const eventTime = new Date(message.timestamp * 1000).toLocaleString();

    console.log(
        `The contact ${oldId.slice(0, -5)}` +
            `${
                !isContact
                    ? ' that participates in group ' +
                      `${(await client.getChatById(message.to ?? message.from)).name} `
                    : ' '
            }` +
            `changed their phone number\nat ${eventTime}.\n` +
            `Their new phone number is ${newId.slice(0, -5)}.\n`,
    );

    /**
     * Information about the @param {message}:
     *
     * 1. If a notification was emitted due to a group participant changing their phone number:
     * @param {message.author} is a participant's id before the change.
     * @param {message.recipients[0]} is a participant's id after the change (a new one).
     *
     * 1.1 If the contact who changed their number WAS in the current user's contact list at the time of the change:
     * @param {message.to} is a group chat id the event was emitted in.
     * @param {message.from} is a current user's id that got an notification message in the group.
     * Also the @param {message.fromMe} is TRUE.
     *
     * 1.2 Otherwise:
     * @param {message.from} is a group chat id the event was emitted in.
     * @param {message.to} is @type {undefined}.
     * Also @param {message.fromMe} is FALSE.
     *
     * 2. If a notification was emitted due to a contact changing their phone number:
     * @param {message.templateParams} is an array of two user's ids:
     * the old (before the change) and a new one, stored in alphabetical order.
     * @param {message.from} is a current user's id that has a chat with a user,
     * whos phone number was changed.
     * @param {message.to} is a user's id (after the change), the current user has a chat with.
     */
});

client.on('group_admin_changed', (notification) => {
    if (notification.type === 'promote') {
        /**
         * Emitted when a current user is promoted to an admin.
         * {@link notification.author} is a user who performs the action of promoting/demoting the current user.
         */
        console.log(`You were promoted by ${notification.author}`);
    } else if (notification.type === 'demote')
        /** Emitted when a current user is demoted to a regular user. */
        console.log(`You were demoted by ${notification.author}`);
});

client.on('group_membership_request', async (notification) => {
    /**
     * The example of the {@link notification} output:
     * {
     *     id: {
     *         fromMe: false,
     *         remote: 'groupId@g.us',
     *         id: '123123123132132132',
     *         participant: 'number@c.us',
     *         _serialized: 'false_groupId@g.us_123123123132132132_number@c.us'
     *     },
     *     body: '',
     *     type: 'created_membership_requests',
     *     timestamp: 1694456538,
     *     chatId: 'groupId@g.us',
     *     author: 'number@c.us',
     *     recipientIds: []
     * }
     *
     */
    console.log(notification);
    /** You can approve or reject the newly appeared membership request: */
    await client.approveGroupMembershipRequestss(
        notification.chatId,
        notification.author,
    );
    await client.rejectGroupMembershipRequests(
        notification.chatId,
        notification.author,
    );
});

client.on('message_reaction', async (reaction) => {
    console.log('REACTION RECEIVED', reaction);
});

client.on('vote_update', (vote) => {
    /** The vote that was affected: */
    console.log(vote);
});
