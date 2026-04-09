'use strict';

const fs = require('fs/promises');
const path = require('path');
const pino = require('pino');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    initAuthCreds,
} = require('@whiskeysockets/baileys');

const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
        const [k, ...rest] = arg.split('=');
        return [k.replace(/^--/, ''), rest.join('=')];
    }),
);

const sessionFile = path.resolve(args.session || './session.json');
const reconnect = (args.reconnect || '1') !== '0';
const pairingPhone = String(
    args.pairingPhone || args['pairing-phone'] || args.phone || '',
)
    .replace(/[^\d]/g, '')
    .trim();
const pairingCustomCode = String(
    args.pairingCustomCode || args['pairing-custom-code'] || '',
).trim();

const log = (...items) => {
    console.log(new Date().toISOString(), ...items);
};

const normalizeBufferLike = (value) => {
    if (value === null || value === undefined) return value;
    if (Buffer.isBuffer(value)) return value;

    if (Array.isArray(value)) {
        return value.map((item) => normalizeBufferLike(item));
    }

    if (typeof value !== 'object') return value;

    if (value.type === 'Buffer' && value.data !== undefined) {
        const raw = value.data;
        if (Array.isArray(raw)) return Buffer.from(raw);
        if (typeof raw === 'string') {
            try {
                return Buffer.from(raw, 'base64');
            } catch {
                return Buffer.from(raw);
            }
        }
    }

    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = normalizeBufferLike(v);
    }
    return out;
};

const bufferReplacer = (_k, value) => {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return { type: 'Buffer', data: Buffer.from(value).toString('base64') };
    }
    return value;
};

const createInMemorySignalKeys = (initialKeys) => {
    const buckets = new Map();

    if (initialKeys && typeof initialKeys === 'object') {
        for (const [category, mapLike] of Object.entries(initialKeys)) {
            if (!mapLike || typeof mapLike !== 'object') continue;
            buckets.set(category, new Map(Object.entries(mapLike)));
        }
    }

    return {
        getAll: () => {
            const out = {};
            for (const [category, map] of buckets.entries()) {
                out[category] = Object.fromEntries(map.entries());
            }
            return out;
        },
        getStore: () => ({
            get: async (type, ids) => {
                const category = buckets.get(type) || new Map();
                const data = {};
                for (const id of ids) {
                    const value = category.get(id);
                    if (value !== undefined) data[id] = value;
                }
                return data;
            },
            set: async (data) => {
                for (const [category, entries] of Object.entries(data || {})) {
                    let map = buckets.get(category);
                    if (!map) {
                        map = new Map();
                        buckets.set(category, map);
                    }

                    for (const [id, value] of Object.entries(entries || {})) {
                        if (value === null || value === undefined) {
                            map.delete(id);
                        } else {
                            map.set(id, value);
                        }
                    }
                }
            },
        }),
    };
};

const parseSession = async () => {
    let raw;
    try {
        raw = await fs.readFile(sessionFile, 'utf8');
    } catch (err) {
        if (err?.code === 'ENOENT' && pairingPhone) {
            return {
                creds: initAuthCreds(),
                keys: {},
                shape: 'empty-for-pairing',
            };
        }
        throw err;
    }

    const parsed = JSON.parse(raw);

    if (parsed && typeof parsed === 'object' && parsed.creds) {
        return {
            creds: normalizeBufferLike(parsed.creds),
            keys: normalizeBufferLike(parsed.keys || {}),
            shape: 'creds+keys',
        };
    }

    if (parsed && typeof parsed === 'object') {
        return {
            creds: normalizeBufferLike(parsed),
            keys: {},
            shape: 'creds-only',
        };
    }

    throw new Error('session.json 格式无效，必须是对象');
};

let currentSock = null;
let currentCreds = null;
let keyBag = null;

const persistSession = async () => {
    if (!currentCreds || !keyBag) return;
    const payload = {
        creds: currentCreds,
        keys: keyBag.getAll(),
    };
    await fs.writeFile(sessionFile, JSON.stringify(payload, bufferReplacer), 'utf8');
};

const start = async () => {
    const parsed = await parseSession();
    currentCreds = parsed.creds;
    keyBag = createInMemorySignalKeys(parsed.keys);

    const { version } = await fetchLatestBaileysVersion();
    log(`[single-json] 启动中，session=${sessionFile}, shape=${parsed.shape}`);

    const sock = makeWASocket({
        version,
        logger: pino({ level: process.env.LOG_LEVEL || 'silent' }),
        browser: ['Single JSON Login', 'Chrome', '1.0.0'],
        printQRInTerminal: false,
        auth: {
            creds: currentCreds,
            keys: keyBag.getStore(),
        },
    });

    currentSock = sock;

    sock.ev.on('creds.update', async (nextCreds) => {
        currentCreds = { ...currentCreds, ...nextCreds };
        await persistSession();
        log('[single-json] 已保存凭据更新');
    });

    if (pairingPhone && !currentCreds?.registered) {
        setTimeout(async () => {
            try {
                const code = pairingCustomCode
                    ? await sock.requestPairingCode(pairingPhone, pairingCustomCode)
                    : await sock.requestPairingCode(pairingPhone);
                log(`[single-json] 配对码(${pairingPhone}): ${code}`);
                log('[single-json] 请在手机 WhatsApp -> 已关联设备 中输入配对码');
            } catch (err) {
                log(`[single-json] 获取配对码失败: ${err?.message || err}`);
            }
        }, 1500);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            log('[single-json] 已登录成功（无需扫码）');
            return;
        }

        if (connection !== 'close') return;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const reason = lastDisconnect?.error?.message || `code=${statusCode || 'unknown'}`;

        if (isLoggedOut) {
            log('[single-json] 会话无效/已登出，需要重新导入完整凭据或扫码');
            return;
        }

        log(`[single-json] 连接关闭: ${reason}`);

        if (!reconnect) return;
        setTimeout(() => {
            start().catch((err) => {
                log(`[single-json] 重连失败: ${err?.message || err}`);
            });
        }, 2000);
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages?.[0];
        if (!msg?.message) return;
        const from = msg.key?.remoteJid;
        log(`[single-json] 收到消息: ${from}`);

        if (args.reply === '1' && from) {
            await sock.sendMessage(from, { text: "Hello 👋 I'm bot" });
        }
    });
};

process.on('SIGINT', async () => {
    try {
        if (currentSock) await Promise.resolve(currentSock.end(new Error('shutdown')));
    } catch {}
    process.exit(0);
});

start().catch((err) => {
    log(`[single-json] 启动失败: ${err?.message || err}`);
    process.exit(1);
});
