'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const zlib = require('zlib');
const fsSync = require('fs');

const express = require('express');
const ExcelJS = require('exceljs');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { MongoClient } = require('mongodb');

const { Client, LocalAuth, RemoteAuth, MessageMedia } = require('../../index');

const PORT = Number(process.env.PORT || process.env.WWEBJS_UI_PORT || 3399);
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_DIR = process.env.WWEBJS_AUTH_DIR
    ? path.resolve(process.env.WWEBJS_AUTH_DIR)
    : path.resolve(process.cwd(), '.wwebjs_auth');
const REMOTE_AUTH_ENABLED =
    String(process.env.REMOTE_AUTH_ENABLED || 'false').toLowerCase() === 'true';
const REMOTE_AUTH_STORE = String(process.env.REMOTE_AUTH_STORE || 'postgres').toLowerCase();
const REMOTE_AUTH_MONGO_URI =
    process.env.REMOTE_AUTH_MONGO_URI || process.env.MONGODB_URI || '';
const REMOTE_AUTH_DB_NAME = process.env.REMOTE_AUTH_DB_NAME || 'wwebjs';
const REMOTE_AUTH_COLLECTION =
    process.env.REMOTE_AUTH_COLLECTION || 'wwebjs_remote_sessions';
const REMOTE_AUTH_DATA_PATH = process.env.REMOTE_AUTH_DATA_PATH
    ? path.resolve(process.env.REMOTE_AUTH_DATA_PATH)
    : path.resolve(process.cwd(), '.wwebjs_remote_auth');
const REMOTE_AUTH_BACKUP_INTERVAL_MS = Number(
    process.env.REMOTE_AUTH_BACKUP_INTERVAL_MS || 300000,
);
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROMIUM_PATH;
const CLIENT_IDS = String(process.env.WWEBJS_CLIENT_IDS || 'visual-ui')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
const MAIN_CLIENT_ID =
    process.env.WWEBJS_MAIN_CLIENT_ID &&
    CLIENT_IDS.includes(process.env.WWEBJS_MAIN_CLIENT_ID.trim())
        ? process.env.WWEBJS_MAIN_CLIENT_ID.trim()
        : CLIENT_IDS[0];

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const normalizePhoneInput = (raw) => {
    const text = String(raw || '').normalize('NFKC');
    let out = '';
    for (const ch of text) {
        const code = ch.charCodeAt(0);
        // ASCII 0-9
        if (code >= 48 && code <= 57) {
            out += ch;
            continue;
        }
        // Arabic-Indic digits (U+0660..U+0669)
        if (code >= 0x0660 && code <= 0x0669) {
            out += String(code - 0x0660);
            continue;
        }
        // Extended Arabic-Indic digits (U+06F0..U+06F9)
        if (code >= 0x06f0 && code <= 0x06f9) {
            out += String(code - 0x06f0);
            continue;
        }
    }
    return out;
};
const commandSeen = new Set();
const awaitingTxtModeByChat = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clientPool = new Map();
const contactGuardCache = new Map();
let rrCursor = 0;

const makeChatScopeKey = (clientId, chatId) => `${clientId}::${chatId}`;
const AVATAR_FETCH_TIMEOUT_MS = Number(process.env.AVATAR_FETCH_TIMEOUT_MS || 12000);
const CONTACT_GUARD_CACHE_TTL_MS = Number(
    process.env.CONTACT_GUARD_CACHE_TTL_MS || 21600000,
);
const AUTO_LINK_FILTER_BOTS =
    String(process.env.AUTO_LINK_FILTER_BOTS || 'true').toLowerCase() === 'true';
const AUTO_LINK_TEXT =
    process.env.AUTO_LINK_TEXT || '系统建联消息（机器人自动发送），可忽略。';
const JWT_SECRET = process.env.JWT_SECRET || 'change_me_in_production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const DATABASE_URL = process.env.DATABASE_URL || '';

let dbPool = null;
let dbReady = false;
let remoteMongoClient = null;
let remoteSessionStore = null;
const chatRouteCache = new Map();
const CHAT_ROUTE_CACHE_TTL_MS = Number(process.env.CHAT_ROUTE_CACHE_TTL_MS || 120000);

// userId → Set<clientId>：操作员被分配的 WA 账号绑定（内存缓存）
const userClientMap = new Map();

const reloadUserClientBindings = async () => {
    userClientMap.clear();
    if (!dbPool) return;
    const res = await dbQuery(`SELECT user_id, client_id FROM user_clients`);
    for (const row of res.rows) {
        const uid = Number(row.user_id);
        if (!userClientMap.has(uid)) userClientMap.set(uid, new Set());
        userClientMap.get(uid).add(row.client_id);
    }
};

// 返回某用户可见的 clients 视图（admin 看全部）
const getClientsViewForUser = (userId, role) => {
    if (role === 'admin') return state.clients;
    const assigned = userClientMap.get(Number(userId)) || new Set();
    const view = {};
    for (const [cid, info] of Object.entries(state.clients)) {
        if (assigned.has(cid)) view[cid] = info;
    }
    return view;
};

// 操作员是否有权操作某个 client
const canAccessClient = (userId, role, clientId) => {
    if (role === 'admin') return true;
    const assigned = userClientMap.get(Number(userId)) || new Set();
    return assigned.has(clientId);
};

const parseClientIdList = (raw) => {
    if (!raw) return [];
    if (Array.isArray(raw)) {
        return raw
            .map((item) => String(item || '').trim())
            .filter((item) => CLIENT_IDS.includes(item));
    }
    return String(raw)
        .split(/[\s,;，；|]+/)
        .map((item) => item.trim())
        .filter((item) => CLIENT_IDS.includes(item));
};

const toClientIdsText = (clientIds) => parseClientIdList(clientIds).join(',');

const fromClientIdsText = (value) =>
    String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => CLIENT_IDS.includes(item));

const issueToken = (user) => {
    return jwt.sign(
        {
            sub: user.id,
            username: user.username,
            role: user.role,
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN },
    );
};

const dbUnavailable = (res) => {
    res.status(503).json({ ok: false, message: '数据库未启用，请先配置 DATABASE_URL' });
};

const authRequired = async (req, res, next) => {
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) {
        res.status(401).json({ ok: false, message: '未登录' });
        return;
    }

    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ ok: false, message: '登录已失效，请重新登录' });
    }
};

const dbQuery = async (sql, params = []) => {
    if (!dbPool) throw new Error('db_not_ready');
    return dbPool.query(sql, params);
};

class MongoZipStore {
    constructor({ mongoClient, dbName, collectionName, dataPath }) {
        this.mongoClient = mongoClient;
        this.collection = this.mongoClient
            .db(dbName)
            .collection(collectionName || 'wwebjs_remote_sessions');
        this.dataPath = dataPath;
    }

    async sessionExists({ session }) {
        const count = await this.collection.countDocuments({ session }, { limit: 1 });
        return count > 0;
    }

    async save({ session }) {
        const zipPath = path.join(this.dataPath, `${session}.zip`);
        const zipData = await fs.readFile(zipPath);
        await this.collection.updateOne(
            { session },
            {
                $set: {
                    session,
                    data: zipData,
                    updatedAt: new Date(),
                },
            },
            { upsert: true },
        );
    }

    async extract({ session, path: outPath }) {
        const doc = await this.collection.findOne({ session });
        if (!doc?.data) throw new Error('remote_session_not_found');
        await fs.writeFile(outPath, doc.data);
    }

    async delete({ session }) {
        await this.collection.deleteOne({ session });
    }
}

class PostgresZipStore {
    constructor({ dataPath }) {
        this.dataPath = dataPath;
    }

    async sessionExists({ session }) {
        const result = await dbQuery(
            `SELECT 1 FROM remote_sessions WHERE session = $1 LIMIT 1`,
            [session],
        );
        return Boolean(result.rows[0]);
    }

    async save({ session }) {
        const zipPath = path.join(this.dataPath, `${session}.zip`);
        const zipData = await fs.readFile(zipPath);
        await dbQuery(
            `INSERT INTO remote_sessions (session, data, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (session)
             DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
            [session, zipData],
        );
    }

    async extract({ session, path: outPath }) {
        const result = await dbQuery(
            `SELECT data FROM remote_sessions WHERE session = $1 LIMIT 1`,
            [session],
        );
        const row = result.rows[0];
        if (!row?.data) throw new Error('remote_session_not_found');
        await fs.writeFile(outPath, row.data);
    }

    async delete({ session }) {
        await dbQuery(`DELETE FROM remote_sessions WHERE session = $1`, [session]);
    }
}

const initRemoteAuthStore = async () => {
    if (!REMOTE_AUTH_ENABLED) return;

    fsSync.mkdirSync(REMOTE_AUTH_DATA_PATH, { recursive: true });

    if (REMOTE_AUTH_STORE === 'mongo') {
        if (!REMOTE_AUTH_MONGO_URI) {
            throw new Error(
                'REMOTE_AUTH_STORE=mongo 但未配置 REMOTE_AUTH_MONGO_URI/MONGODB_URI',
            );
        }
        remoteMongoClient = new MongoClient(REMOTE_AUTH_MONGO_URI);
        await remoteMongoClient.connect();
        remoteSessionStore = new MongoZipStore({
            mongoClient: remoteMongoClient,
            dbName: REMOTE_AUTH_DB_NAME,
            collectionName: REMOTE_AUTH_COLLECTION,
            dataPath: REMOTE_AUTH_DATA_PATH,
        });
        return;
    }

    if (!dbPool) {
        throw new Error('REMOTE_AUTH_STORE=postgres 需要先配置并连接 DATABASE_URL');
    }

    await dbQuery(
        `CREATE TABLE IF NOT EXISTS remote_sessions (
            session VARCHAR(128) PRIMARY KEY,
            data BYTEA NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
    );
    remoteSessionStore = new PostgresZipStore({
        dataPath: REMOTE_AUTH_DATA_PATH,
    });
};

const getChatRouteClientIds = async (chatId) => {
    if (!dbReady || !chatId) return null;

    const cached = chatRouteCache.get(chatId);
    if (cached && Date.now() - cached.ts < CHAT_ROUTE_CACHE_TTL_MS) {
        return cached.clientIds;
    }

    const result = await dbQuery(
        `SELECT client_ids
         FROM customer_routes
         WHERE chat_id = $1
         LIMIT 1`,
        [chatId],
    );

    const row = result.rows[0];
    const clientIds = row ? fromClientIdsText(row.client_ids) : null;
    chatRouteCache.set(chatId, { ts: Date.now(), clientIds });
    return clientIds;
};

const initDatabase = async () => {
    if (!DATABASE_URL) {
        log('未配置 DATABASE_URL，注册/路由管理功能将不可用。');
        return;
    }

    const useSsl =
        String(process.env.PGSSL || process.env.PGSSLMODE || '').toLowerCase() === 'require' ||
        String(process.env.PG_SSL || 'true').toLowerCase() === 'true';

    dbPool = new Pool({
        connectionString: DATABASE_URL,
        ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    });

    await dbQuery(
        `CREATE TABLE IF NOT EXISTS app_users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(64) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role VARCHAR(16) NOT NULL DEFAULT 'operator',
            approved BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
    );
    // 兼容旧表：若 approved 列不存在则新增
    await dbQuery(
        `ALTER TABLE app_users ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT FALSE`,
    );
    // 确保已有 admin 账号自动审批
    await dbQuery(`UPDATE app_users SET approved = TRUE WHERE role = 'admin' AND approved = FALSE`);

    await dbQuery(
        `CREATE TABLE IF NOT EXISTS customer_routes (
            id SERIAL PRIMARY KEY,
            chat_id VARCHAR(96) UNIQUE NOT NULL,
            demand_tag VARCHAR(96) NOT NULL,
            client_ids TEXT NOT NULL,
            owner_user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
    );

    await dbQuery(
        `CREATE INDEX IF NOT EXISTS idx_customer_routes_owner ON customer_routes(owner_user_id)`,
    );

    // ── managed_clients：持久化动态添加的账号列表 ──────────────────────────
    await dbQuery(
        `CREATE TABLE IF NOT EXISTS managed_clients (
            id SERIAL PRIMARY KEY,
            client_id VARCHAR(128) UNIQUE NOT NULL,
            is_main BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
    );
    // 把环境变量里的账号 upsert 进表（首次运行时种入）
    for (const cid of [...CLIENT_IDS]) {
        await dbQuery(
            `INSERT INTO managed_clients (client_id, is_main)
             VALUES ($1, $2)
             ON CONFLICT (client_id) DO NOTHING`,
            [cid, cid === MAIN_CLIENT_ID],
        );
    }
    // 加载 DB 中额外添加的账号（不在环境变量里的）
    const mcRes = await dbQuery(`SELECT client_id FROM managed_clients ORDER BY id ASC`);
    for (const row of mcRes.rows) {
        if (!CLIENT_IDS.includes(row.client_id)) {
            CLIENT_IDS.push(row.client_id);
        }
    }

    // ── user_clients：用户与 WA 账号的绑定关系 ──────────────────────────
    await dbQuery(
        `CREATE TABLE IF NOT EXISTS user_clients (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
            client_id VARCHAR(128) NOT NULL,
            UNIQUE(user_id, client_id)
        )`,
    );
    // 加载绑定关系到内存
    await reloadUserClientBindings();

    dbReady = true;
    log('PostgreSQL 已连接，注册与客户路由功能已启用。');
};

const detectImageExt = (mimeType = '', url = '') => {
    const lowerMime = String(mimeType).toLowerCase();
    if (lowerMime.includes('png')) return 'png';
    if (lowerMime.includes('jpeg') || lowerMime.includes('jpg')) return 'jpeg';
    if (lowerMime.includes('webp')) return 'png';

    const lowerUrl = String(url).toLowerCase();
    if (lowerUrl.includes('.png')) return 'png';
    if (lowerUrl.includes('.jpg') || lowerUrl.includes('.jpeg')) return 'jpeg';
    return 'png';
};

const downloadAvatarBuffer = async (avatarUrl) => {
    if (!avatarUrl) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AVATAR_FETCH_TIMEOUT_MS);

    try {
        const resp = await fetch(avatarUrl, {
            signal: controller.signal,
            headers: {
                'user-agent': 'wwebjs-visual-ui/1.0',
            },
        });

        if (!resp.ok) return null;

        const contentType = resp.headers.get('content-type') || '';
        const arrayBuffer = await resp.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (!buffer.length) return null;

        return {
            buffer,
            extension: detectImageExt(contentType, avatarUrl),
        };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
};

const buildChecknumWorkbook = async (rows) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('checknum');

    sheet.columns = [
        { header: 'number', key: 'number', width: 18 },
        { header: 'status', key: 'status', width: 12 },
        { header: 'wa_id', key: 'waId', width: 24 },
        { header: 'avatar_url', key: 'avatarUrl', width: 64 },
        { header: 'avatar', key: 'avatar', width: 14 },
        { header: 'note', key: 'note', width: 24 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    const imageJobs = [];

    for (const item of rows) {
        const row = sheet.addRow({
            number: item.number,
            status: item.status,
            waId: item.waId,
            avatarUrl: item.avatarUrl || '',
            note: item.note || '',
        });

        row.height = 64;

        if (item.avatarUrl) {
            const avatarUrlCell = row.getCell(4);
            avatarUrlCell.value = {
                text: item.avatarUrl,
                hyperlink: item.avatarUrl,
            };
            avatarUrlCell.font = {
                color: { argb: 'FF0563C1' },
                underline: true,
            };

            imageJobs.push({
                avatarUrl: item.avatarUrl,
                rowNumber: row.number,
            });
        }
    }

    for (const job of imageJobs) {
        const avatar = await downloadAvatarBuffer(job.avatarUrl);
        if (!avatar) continue;

        const imageId = workbook.addImage({
            buffer: avatar.buffer,
            extension: avatar.extension,
        });

        sheet.addImage(imageId, {
            tl: { col: 4, row: job.rowNumber - 1 },
            ext: { width: 56, height: 56 },
            editAs: 'oneCell',
        });
    }

    return workbook;
};

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

const resolveNumberId = async (clientRef, number, retries = 2) => {
    let last = null;

    for (let i = 0; i <= retries; i++) {
        try {
            const value = await clientRef.getNumberId(number);
            if (value) return value;
            last = value;
        } catch (error) {
            // Temporary WA-side lookup failures are common; retry a few times.
            last = null;
        }

        if (i < retries) {
            await sleep(350 + i * 250);
        }
    }

    // Fallback path: some sessions return null from getNumberId but can still
    // verify registration through isRegisteredUser.
    try {
        if (typeof clientRef.isRegisteredUser === 'function') {
            const jid = `${number}@c.us`;
            const registered = await clientRef.isRegisteredUser(jid);
            if (registered) return { _serialized: jid };
        }
    } catch {
        // ignore fallback errors and return null
    }

    return last;
};

const runProbeForNumber = async (clientRef, number, probeText) => {
    const numberId = await resolveNumberId(clientRef, number);
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

const getReadyFilterClients = (allowedClientIds = null) => {
    const allowSet = Array.isArray(allowedClientIds) && allowedClientIds.length
        ? new Set(allowedClientIds)
        : null;
    return getReadyClients().filter((entry) => {
        if (entry.clientId === MAIN_CLIENT_ID) return false;
        if (!allowSet) return true;
        return allowSet.has(entry.clientId);
    });
};

const buildClientJid = (entry) => {
    const serialized = entry?.client?.info?.wid?._serialized;
    if (serialized) return serialized;

    const user = entry?.client?.info?.wid?.user;
    if (user) return `${user}@c.us`;
    return '';
};

const ensureMainFilterLink = async (filterEntry) => {
    const cacheKey = filterEntry.clientId;
    const cached = contactGuardCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CONTACT_GUARD_CACHE_TTL_MS) {
        return { ok: cached.ok, reason: cached.reason };
    }

    const mainEntry = clientPool.get(MAIN_CLIENT_ID);
    if (!mainEntry || mainEntry.status !== 'ready') {
        const result = { ok: false, reason: '主机器人账号未就绪' };
        contactGuardCache.set(cacheKey, { ...result, ts: Date.now() });
        return result;
    }

    const mainJid = buildClientJid(mainEntry);
    const filterJid = buildClientJid(filterEntry);
    const mainNumber = mainJid.split('@')[0] || '';
    const filterNumber = filterJid.split('@')[0] || '';

    if (!mainJid || !filterJid || !mainNumber || !filterNumber) {
        const result = { ok: false, reason: '账号JID未就绪，请稍后重试' };
        contactGuardCache.set(cacheKey, { ...result, ts: Date.now() });
        return result;
    }

    try {
        const [mainToFilterId, filterToMainId] = await Promise.all([
            mainEntry.client.getNumberId(filterNumber).catch(() => null),
            filterEntry.client.getNumberId(mainNumber).catch(() => null),
        ]);

        if (!mainToFilterId || !filterToMainId) {
            const result = {
                ok: false,
                reason: '账号互通校验失败，请确认两个WS账号均为有效注册号码',
            };
            contactGuardCache.set(cacheKey, { ...result, ts: Date.now() });
            return result;
        }

        if (AUTO_LINK_FILTER_BOTS) {
            await Promise.allSettled([
                mainEntry.client.sendMessage(
                    mainToFilterId._serialized || `${filterNumber}@c.us`,
                    AUTO_LINK_TEXT,
                ),
                filterEntry.client.sendMessage(
                    filterToMainId._serialized || `${mainNumber}@c.us`,
                    AUTO_LINK_TEXT,
                ),
            ]);
        }

        const result = { ok: true, reason: '' };

        contactGuardCache.set(cacheKey, { ...result, ts: Date.now() });
        return result;
    } catch {
        const result = { ok: false, reason: '自动建联失败，请稍后重试' };
        contactGuardCache.set(cacheKey, { ...result, ts: Date.now() });
        return result;
    }
};

const runWithExecutionClient = async (preferredClientId, fn, options = {}) => {
    const ready = getReadyFilterClients(options.allowedClientIds || null);
    if (!ready.length) {
        throw new Error('暂无可用筛选账号，请先登录其他WS账号作为筛选账号');
    }

    const preferred = ready.find((entry) => entry.clientId === preferredClientId);
    const rrOrdered = [
        ...ready.slice(rrCursor % ready.length),
        ...ready.slice(0, rrCursor % ready.length),
    ];
    const ordered = preferred
        ? [preferred, ...rrOrdered.filter((item) => item.clientId !== preferred.clientId)]
        : rrOrdered;

    let sawRuntimeUnavailable = false;

    for (const selected of ordered) {
        const guard = await ensureMainFilterLink(selected);
        if (!guard.ok) continue;

        try {
            rrCursor = (rrCursor + 1) % Math.max(ready.length, 1);
            return await fn(selected.client, selected.clientId);
        } catch (error) {
            if (!isExecutionClientUnavailableError(error)) {
                throw error;
            }

            sawRuntimeUnavailable = true;
            contactGuardCache.delete(selected.clientId);
            continue;
        }
    }

    if (sawRuntimeUnavailable) {
        throw new Error('暂无可用筛选账号（执行中断且无可接管账号）');
    }

    throw new Error(
        '暂无符合条件的筛选账号：请确保筛选账号在线，且主机器人与筛选账号可互通',
    );
};

const isExecutionClientUnavailableError = (error) => {
    const message = String(error?.message || error || '').toLowerCase();
    return (
        message.includes('session closed') ||
        message.includes('target closed') ||
        message.includes('execution context was destroyed') ||
        message.includes('not attached to an active page') ||
        message.includes('protocol error') ||
        message.includes('disconnected') ||
        message.includes('connection closed') ||
        message.includes('connection lost') ||
        message.includes('browser has disconnected') ||
        message.includes('client is not ready') ||
        message.includes('wid')
    );
};

const isDispatchUnavailableError = (error) => {
    const message = String(error?.message || error || '');
    return (
        message.includes('暂无可用筛选账号') ||
        message.includes('暂无符合条件的筛选账号')
    );
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
    const results = [];
    // 按行与常见列分隔符拆分，每个单元格整体剥离非数字字符
    // 这样 "+86 138 1234 5678"、"86-138-1234-5678"、"(8613) 8888 9999"
    // 以及包含备注字符的行都可提取到号码。
    const tokens = String(text || '').split(/[\r\n,;|，；\t]+/);
    for (const token of tokens) {
        const digits = normalizePhoneInput(token);
        if (digits.length >= 6) {
            results.push(digits);
        }
    }
    return results;
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
            const numberId = await resolveNumberId(clientRef, number);
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
    role: {
        mainClientId: MAIN_CLIENT_ID,
    },
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

// 向所有已认证的 socket 推送各自过滤后的 clients 视图
const broadcastClients = () => {
    for (const [, socket] of io.sockets.sockets) {
        const u = socket.data?.user;
        if (!u) continue;
        socket.emit('clients', getClientsViewForUser(u.sub, u.role));
    }
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
    broadcastClients();

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
app.use(express.json({ limit: '8mb' }));

app.post('/api/auth/register', async (req, res) => {
    if (!dbReady) {
        dbUnavailable(res);
        return;
    }

    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!/^[a-z0-9_]{3,32}$/.test(username)) {
        res.status(400).json({ ok: false, message: '用户名需为3-32位字母数字下划线' });
        return;
    }
    if (password.length < 6) {
        res.status(400).json({ ok: false, message: '密码至少6位' });
        return;
    }

    try {
        const countRes = await dbQuery('SELECT COUNT(*)::int AS n FROM app_users');
        const userCount = Number(countRes.rows[0]?.n || 0);
        const role = userCount === 0 ? 'admin' : 'operator';
        const approved = role === 'admin';
        const passwordHash = await bcrypt.hash(password, 10);

        const insertRes = await dbQuery(
            `INSERT INTO app_users (username, password_hash, role, approved)
             VALUES ($1, $2, $3, $4)
             RETURNING id, username, role, approved`,
            [username, passwordHash, role, approved],
        );

        const user = insertRes.rows[0];
        const token = issueToken(user);
        res.json({ ok: true, token, user });
    } catch (error) {
        if (String(error?.message || '').includes('duplicate key')) {
            res.status(409).json({ ok: false, message: '用户名已存在' });
            return;
        }
        log(`register 失败: ${error?.message || error}`);
        res.status(500).json({ ok: false, message: '注册失败' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    if (!dbReady) {
        dbUnavailable(res);
        return;
    }

    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    try {
        const result = await dbQuery(
            `SELECT id, username, role, approved, password_hash FROM app_users WHERE username = $1 LIMIT 1`,
            [username],
        );

        const user = result.rows[0];
        if (!user) {
            res.status(401).json({ ok: false, message: '账号或密码错误' });
            return;
        }

        const passOk = await bcrypt.compare(password, user.password_hash);
        if (!passOk) {
            res.status(401).json({ ok: false, message: '账号或密码错误' });
            return;
        }

        if (!user.approved) {
            res.status(403).json({ ok: false, message: '账号待管理员审批，暂无访问权限' });
            return;
        }

        const token = issueToken(user);
        res.json({
            ok: true,
            token,
            user: { id: user.id, username: user.username, role: user.role },
        });
    } catch (error) {
        log(`login 失败: ${error?.message || error}`);
        res.status(500).json({ ok: false, message: '登录失败' });
    }
});

app.get('/api/auth/me', authRequired, async (req, res) => {
    if (!dbReady) {
        dbUnavailable(res);
        return;
    }

    try {
        const result = await dbQuery(
            `SELECT id, username, role FROM app_users WHERE id = $1 LIMIT 1`,
            [req.user.sub],
        );
        const user = result.rows[0];
        if (!user) {
            res.status(401).json({ ok: false, message: '用户不存在' });
            return;
        }
        res.json({ ok: true, user });
    } catch (error) {
        log(`me 查询失败: ${error?.message || error}`);
        res.status(500).json({ ok: false, message: '查询用户失败' });
    }
});

app.get('/api/routes', authRequired, async (req, res) => {
    if (!dbReady) {
        dbUnavailable(res);
        return;
    }

    try {
        const isAdmin = req.user.role === 'admin';
        const result = isAdmin
            ? await dbQuery(
                  `SELECT id, chat_id, demand_tag, client_ids, owner_user_id, updated_at
                   FROM customer_routes
                   ORDER BY updated_at DESC`,
              )
            : await dbQuery(
                  `SELECT id, chat_id, demand_tag, client_ids, owner_user_id, updated_at
                   FROM customer_routes
                   WHERE owner_user_id = $1
                   ORDER BY updated_at DESC`,
                  [req.user.sub],
              );

        const items = result.rows.map((row) => ({
            id: row.id,
            chatId: row.chat_id,
            demandTag: row.demand_tag,
            clientIds: fromClientIdsText(row.client_ids),
            ownerUserId: row.owner_user_id,
            updatedAt: row.updated_at,
        }));
        res.json({ ok: true, items, availableClientIds: CLIENT_IDS.filter((id) => id !== MAIN_CLIENT_ID) });
    } catch (error) {
        log(`routes 查询失败: ${error?.message || error}`);
        res.status(500).json({ ok: false, message: '查询路由失败' });
    }
});

app.post('/api/routes', authRequired, async (req, res) => {
    if (!dbReady) {
        dbUnavailable(res);
        return;
    }

    const chatId = String(req.body?.chatId || '').trim();
    const demandTag = String(req.body?.demandTag || '').trim();
    const clientIds = parseClientIdList(req.body?.clientIds).filter((id) => id !== MAIN_CLIENT_ID);

    if (!chatId || !demandTag) {
        res.status(400).json({ ok: false, message: 'chatId 与 demandTag 必填' });
        return;
    }

    if (!clientIds.length) {
        res.status(400).json({ ok: false, message: '至少选择一个筛选账号' });
        return;
    }

    try {
        const existing = await dbQuery(
            `SELECT id, owner_user_id FROM customer_routes WHERE chat_id = $1 LIMIT 1`,
            [chatId],
        );

        if (existing.rows[0]) {
            const route = existing.rows[0];
            const canEdit = req.user.role === 'admin' || Number(route.owner_user_id) === Number(req.user.sub);
            if (!canEdit) {
                res.status(403).json({ ok: false, message: '无权限修改该路由' });
                return;
            }

            await dbQuery(
                `UPDATE customer_routes
                 SET demand_tag = $2, client_ids = $3, updated_at = NOW()
                 WHERE id = $1`,
                [route.id, demandTag, toClientIdsText(clientIds)],
            );
            chatRouteCache.delete(chatId);
            res.json({ ok: true, id: route.id, updated: true });
            return;
        }

        const insertRes = await dbQuery(
            `INSERT INTO customer_routes (chat_id, demand_tag, client_ids, owner_user_id)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [chatId, demandTag, toClientIdsText(clientIds), req.user.sub],
        );
        chatRouteCache.delete(chatId);
        res.json({ ok: true, id: insertRes.rows[0].id, updated: false });
    } catch (error) {
        log(`routes 保存失败: ${error?.message || error}`);
        res.status(500).json({ ok: false, message: '保存路由失败' });
    }
});

app.delete('/api/routes/:id', authRequired, async (req, res) => {
    if (!dbReady) {
        dbUnavailable(res);
        return;
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ ok: false, message: '路由ID非法' });
        return;
    }

    try {
        const existing = await dbQuery(
            `SELECT id, chat_id, owner_user_id FROM customer_routes WHERE id = $1 LIMIT 1`,
            [id],
        );
        const row = existing.rows[0];
        if (!row) {
            res.status(404).json({ ok: false, message: '路由不存在' });
            return;
        }

        const canDelete = req.user.role === 'admin' || Number(row.owner_user_id) === Number(req.user.sub);
        if (!canDelete) {
            res.status(403).json({ ok: false, message: '无权限删除该路由' });
            return;
        }

        await dbQuery(`DELETE FROM customer_routes WHERE id = $1`, [id]);
        chatRouteCache.delete(row.chat_id);
        res.json({ ok: true });
    } catch (error) {
        log(`routes 删除失败: ${error?.message || error}`);
        res.status(500).json({ ok: false, message: '删除路由失败' });
    }
});

app.get('/api/state', (_req, res) => {
    res.json(state);
});

// ── 用户管理 API（仅 admin）──────────────────────────────────────────────
app.get('/api/users', authRequired, async (req, res) => {
    if (!dbReady) { dbUnavailable(res); return; }
    if (req.user.role !== 'admin') {
        res.status(403).json({ ok: false, message: '无权限' });
        return;
    }
    try {
        const result = await dbQuery(
            `SELECT id, username, role, approved, created_at FROM app_users ORDER BY id ASC`,
        );
        res.json({ ok: true, users: result.rows });
    } catch (error) {
        log(`users 查询失败: ${error?.message || error}`);
        res.status(500).json({ ok: false, message: '查询失败' });
    }
});

// Admin 手动创建用户
app.post('/api/users', authRequired, async (req, res) => {
    if (!dbReady) { dbUnavailable(res); return; }
    if (req.user.role !== 'admin') {
        res.status(403).json({ ok: false, message: '无权限' });
        return;
    }
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const role = ['admin', 'operator'].includes(req.body?.role) ? req.body.role : 'operator';

    if (!/^[a-z0-9_]{3,32}$/.test(username)) {
        res.status(400).json({ ok: false, message: '用户名需为3-32位字母数字下划线' });
        return;
    }
    if (password.length < 6) {
        res.status(400).json({ ok: false, message: '密码至少6位' });
        return;
    }
    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const result = await dbQuery(
            `INSERT INTO app_users (username, password_hash, role, approved)
             VALUES ($1, $2, $3, TRUE)
             RETURNING id, username, role, approved`,
            [username, passwordHash, role],
        );
        log(`admin ${req.user.username} 创建用户: ${username} (${role})`);
        res.json({ ok: true, user: result.rows[0] });
    } catch (error) {
        if (String(error?.message || '').includes('duplicate key')) {
            res.status(409).json({ ok: false, message: '用户名已存在' });
            return;
        }
        log(`admin 创建用户失败: ${error?.message || error}`);
        res.status(500).json({ ok: false, message: '创建失败' });
    }
});

app.patch('/api/users/:id', authRequired, async (req, res) => {
    if (!dbReady) { dbUnavailable(res); return; }
    if (req.user.role !== 'admin') {
        res.status(403).json({ ok: false, message: '无权限' });
        return;
    }
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
        res.status(400).json({ ok: false, message: '用户ID非法' });
        return;
    }
    const { role, approved } = req.body || {};
    const updates = [];
    const vals = [];
    if (role !== undefined) {
        if (!['admin', 'operator'].includes(role)) {
            res.status(400).json({ ok: false, message: 'role 只能为 admin 或 operator' });
            return;
        }
        vals.push(role);
        updates.push(`role = $${vals.length}`);
    }
    if (approved !== undefined) {
        vals.push(Boolean(approved));
        updates.push(`approved = $${vals.length}`);
    }
    if (!updates.length) {
        res.status(400).json({ ok: false, message: '无可更新字段' });
        return;
    }
    vals.push(targetId);
    try {
        const result = await dbQuery(
            `UPDATE app_users SET ${updates.join(', ')} WHERE id = $${vals.length}
             RETURNING id, username, role, approved`,
            vals,
        );
        if (!result.rows[0]) {
            res.status(404).json({ ok: false, message: '用户不存在' });
            return;
        }
        res.json({ ok: true, user: result.rows[0] });
    } catch (error) {
        log(`users 更新失败: ${error?.message || error}`);
        res.status(500).json({ ok: false, message: '更新失败' });
    }
});

app.post('/api/clients/:clientId/offline', authRequired, async (req, res) => {
    const { clientId } = req.params;
    if (!canAccessClient(req.user.sub, req.user.role, clientId)) {
        res.status(403).json({ ok: false, message: '无权限操作该账号' });
        return;
    }
    const entry = clientPool.get(clientId);

    if (!entry) {
        res.status(404).json({ ok: false, message: '账号不存在' });
        return;
    }

    if (entry.status === 'manual_offline') {
        res.json({ ok: true, message: '账号已处于手动下线状态' });
        return;
    }

    try {
        entry.manualOffline = true;
        await entry.client.destroy().catch(() => {});
        entry.status = 'manual_offline';
        setClientState(clientId, {
            status: 'manual_offline',
            loading: null,
            qrDataUrl: null,
        });
        log(`[${clientId}] 已手动下线。`);
        res.json({ ok: true });
    } catch (error) {
        log(`[${clientId}] 手动下线失败: ${error?.message || error}`);
        res.status(500).json({ ok: false, message: '手动下线失败' });
    }
});

app.post('/api/clients/:clientId/online', authRequired, async (req, res) => {
    const { clientId } = req.params;
    if (!canAccessClient(req.user.sub, req.user.role, clientId)) {
        res.status(403).json({ ok: false, message: '无权限操作该账号' });
        return;
    }
    const oldEntry = clientPool.get(clientId);

    if (!CLIENT_IDS.includes(clientId)) {
        res.status(404).json({ ok: false, message: '账号不在配置列表中' });
        return;
    }

    try {
        if (oldEntry) {
            oldEntry.manualOffline = false;
            await oldEntry.client.destroy().catch(() => {});
        }

        const entry = buildClient(clientId);
        await entry.client.initialize();
        log(`[${clientId}] 已手动上线，等待就绪。`);
        res.json({ ok: true });
    } catch (error) {
        log(`[${clientId}] 手动上线失败: ${error?.message || error}`);
        res.status(500).json({ ok: false, message: '手动上线失败' });
    }
});

// ── 用户 WA 账号绑定管理（admin）─────────────────────────────────────────
// 查询某用户已绑定的账号列表
app.get('/api/users/:id/clients', authRequired, async (req, res) => {
    if (req.user.role !== 'admin') { res.status(403).json({ ok: false, message: '无权限' }); return; }
    if (!dbReady) { dbUnavailable(res); return; }
    const uid = Number(req.params.id);
    const result = await dbQuery(`SELECT client_id FROM user_clients WHERE user_id = $1`, [uid]);
    res.json({ ok: true, clientIds: result.rows.map((r) => r.client_id) });
});

// 绑定账号
app.post('/api/users/:id/clients', authRequired, async (req, res) => {
    if (req.user.role !== 'admin') { res.status(403).json({ ok: false, message: '无权限' }); return; }
    if (!dbReady) { dbUnavailable(res); return; }
    const uid = Number(req.params.id);
    const clientId = String(req.body?.clientId || '').trim();
    if (!clientId) { res.status(400).json({ ok: false, message: 'clientId 不能为空' }); return; }
    try {
        await dbQuery(
            `INSERT INTO user_clients (user_id, client_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [uid, clientId],
        );
        await reloadUserClientBindings();
        broadcastClients();
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, message: error?.message || '绑定失败' });
    }
});

// 解绑账号
app.delete('/api/users/:id/clients/:clientId', authRequired, async (req, res) => {
    if (req.user.role !== 'admin') { res.status(403).json({ ok: false, message: '无权限' }); return; }
    if (!dbReady) { dbUnavailable(res); return; }
    const uid = Number(req.params.id);
    const clientId = req.params.clientId;
    try {
        await dbQuery(`DELETE FROM user_clients WHERE user_id = $1 AND client_id = $2`, [uid, clientId]);
        await reloadUserClientBindings();
        broadcastClients();
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, message: error?.message || '解绑失败' });
    }
});

// ── 动态添加账号（admin）

app.post('/api/clients', authRequired, async (req, res) => {
    // 所有已登录用户均可添加账号，账号自动绑定到创建者
    const clientId = String(req.body?.clientId || '').trim();
    if (!/^[a-zA-Z0-9_-]{2,64}$/.test(clientId)) {
        res.status(400).json({ ok: false, message: '账号ID只能包含字母/数字/下划线/横线，长度2-64' });
        return;
    }
    if (clientPool.has(clientId)) {
        res.status(409).json({ ok: false, message: '该账号ID已存在' });
        return;
    }

    try {
        if (dbReady) {
            await dbQuery(
                `INSERT INTO managed_clients (client_id, is_main) VALUES ($1, FALSE)
                 ON CONFLICT (client_id) DO NOTHING`,
                [clientId],
            );
            // 自动绑定到创建者
            await dbQuery(
                `INSERT INTO user_clients (user_id, client_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [req.user.sub, clientId],
            );
            await reloadUserClientBindings();
        }
        if (!CLIENT_IDS.includes(clientId)) CLIENT_IDS.push(clientId);

        const entry = buildClient(clientId);
        entry.client.initialize().catch((err) => {
            log(`[${clientId}] initialize 失败: ${err?.message || err}`);
        });

        log(`[${clientId}] 已由用户 ${req.user.username} 添加，开始初始化。`);
        res.json({ ok: true, clientId });
    } catch (error) {
        log(`添加账号失败: ${error?.message || error}`);
        res.status(500).json({ ok: false, message: '添加账号失败' });
    }
});

// ── 动态删除账号（自己的账号；admin 可删所有非主机器人账号） ──────────────
app.delete('/api/clients/:clientId', authRequired, async (req, res) => {
    const { clientId } = req.params;
    const isAdmin = req.user.role === 'admin';

    if (clientId === MAIN_CLIENT_ID) {
        res.status(400).json({ ok: false, message: '主机器人账号不可删除' });
        return;
    }

    // 非 admin 只能删自己绑定的账号
    if (!isAdmin && !canAccessClient(req.user.sub, req.user.role, clientId)) {
        res.status(403).json({ ok: false, message: '无权限删除该账号' });
        return;
    }

    const entry = clientPool.get(clientId);
    if (!entry) {
        res.status(404).json({ ok: false, message: '账号不存在' });
        return;
    }

    try {
        await entry.client.destroy().catch(() => {});
        clientPool.delete(clientId);
        const idx = CLIENT_IDS.indexOf(clientId);
        if (idx !== -1) CLIENT_IDS.splice(idx, 1);

        if (dbReady) {
            await dbQuery(`DELETE FROM managed_clients WHERE client_id = $1`, [clientId]);
            // user_clients 通过 ON DELETE CASCADE 自动清理
        }
        await reloadUserClientBindings();

        const newClients = { ...state.clients };
        delete newClients[clientId];
        state.clients = newClients;
        broadcastClients();

        log(`[${clientId}] 账号已由 ${req.user.username} 删除。`);
        res.json({ ok: true });
    } catch (error) {
        log(`删除账号失败: ${error?.message || error}`);
        res.status(500).json({ ok: false, message: '删除账号失败' });
    }
});

// ── UI 任务执行 API ────────────────────────────────────────────────────────
const VALID_TASK_MODES = ['checknum', 'probe', 'checknumlist', 'activity', 'wsdebug', 'behavior'];

app.post('/api/task/run', authRequired, async (req, res) => {
    const { mode, numbers, fileContent, clientId: preferredClientId } = req.body || {};
    const userId = req.user.sub;
    const userRole = req.user.role;

    if (!VALID_TASK_MODES.includes(mode)) {
        res.status(400).json({ ok: false, message: '无效的任务模式' });
        return;
    }

    // 解析号码：优先尝试文件，失败或为空时自动回退到手动输入
    let parsedNumbers = [];
    if (fileContent) {
        try {
            const raw = String(fileContent || '').trim();
            const normalizedBase64 = raw.replace(/^data:[^;]+;base64,/i, '');
            const buffer = Buffer.from(normalizedBase64, 'base64');
            parsedNumbers = extractPhoneNumbersFromBuffer(buffer);
        } catch {
            res.status(400).json({ ok: false, message: 'TXT文件解析失败' });
            return;
        }
    }

    // 文件未提取到号码时，回退到 numbers 字段继续尝试
    if (!parsedNumbers.length && Array.isArray(numbers)) {
        parsedNumbers = numbers
            .map((n) => normalizePhoneInput(String(n || '')))
            .filter((n) => n.length >= 6);
    } else if (!parsedNumbers.length && typeof numbers === 'string' && numbers.trim()) {
        parsedNumbers = extractPhoneNumbers(numbers);
    }

    if (!parsedNumbers.length) {
        res.status(400).json({ ok: false, message: '未能提取到有效电话号码。请确认每行含数字，或直接粘贴号码文本再试。' });
        return;
    }

    // 确定该用户可用的筛选账号
    const allowedClientIds =
        userRole === 'admin'
            ? null
            : [...(userClientMap.get(Number(userId)) || new Set())];

    try {
        if (mode === 'checknum') {
            const numbers2 = parsedNumbers;
            const excelRows = [];
            let stoppedEarly = false;

            for (const number of numbers2) {
                try {
                    const numberId = await runWithExecutionClient(
                        preferredClientId,
                        (execClient) => resolveNumberId(execClient, number),
                        { allowedClientIds },
                    );
                    const status = numberId ? 'valid' : 'invalid';
                    const waId = numberId?._serialized || `${number}@c.us`;

                    let avatarUrl = '';
                    let note = '';
                    if (numberId?._serialized) {
                        try {
                            const maybeAvatar = await runWithExecutionClient(
                                preferredClientId,
                                (execClient) =>
                                    execClient.getProfilePicUrl(numberId._serialized),
                                { allowedClientIds },
                            );
                            avatarUrl = maybeAvatar || '';
                            if (!avatarUrl) note = 'no_avatar';
                        } catch {
                            note = 'avatar_fetch_failed';
                        }
                    } else {
                        note = 'not_registered';
                    }

                    excelRows.push({ number, status, waId, avatarUrl, note });
                } catch (error) {
                    if (isDispatchUnavailableError(error)) {
                        stoppedEarly = true;
                        break;
                    }
                    excelRows.push({ number, status: 'error', waId: '-', avatarUrl: '', note: error?.message || 'check_failed' });
                }
            }

            const workbook = await buildChecknumWorkbook(excelRows);
            const buffer = await workbook.xlsx.writeBuffer();
            log(`[task/checknum] 用户 ${req.user.username} 完成，共 ${excelRows.length} 条${stoppedEarly ? '（提前中止）' : ''}`);
            res.json({
                ok: true,
                mode,
                count: excelRows.length,
                stoppedEarly,
                fileContent: Buffer.from(buffer).toString('base64'),
                filename: `checknum_${Date.now()}.xlsx`,
                mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            });

        } else if (mode === 'probe') {
            const numbers2 = [...new Set(parsedNumbers)];
            const rows = ['number\tactivity\tack\tchannel\tnote'];
            let stoppedEarly = false;

            for (const number of numbers2) {
                try {
                    const result = await runWithExecutionClient(
                        preferredClientId,
                        (execClient) => runProbeForNumber(execClient, number, PROBE_TEXT),
                        { allowedClientIds },
                    );
                    rows.push(
                        `${result.number}\t${result.activity}\t${result.ack === null ? 'timeout' : result.ack}\t${result.source}\t${result.note || '-'}`,
                    );
                } catch (error) {
                    if (isDispatchUnavailableError(error)) {
                        stoppedEarly = true;
                        break;
                    }
                    rows.push(`${number}\terror\t-\t-\tprobe_failed`);
                }
            }

            const text = rows.join('\n');
            log(`[task/probe] 用户 ${req.user.username} 完成，共 ${rows.length - 1} 条${stoppedEarly ? '（提前中止）' : ''}`);
            res.json({
                ok: true,
                mode,
                count: rows.length - 1,
                stoppedEarly,
                fileContent: Buffer.from(text).toString('base64'),
                filename: `probe_${Date.now()}.txt`,
                mimeType: 'text/plain',
            });

        } else if (mode === 'checknumlist') {
            const numbers2 = parsedNumbers;
            const resultLines = [];
            let stoppedEarly = false;

            for (const number of numbers2) {
                try {
                    const numberId = await runWithExecutionClient(
                        preferredClientId,
                        (execClient) => resolveNumberId(execClient, number),
                        { allowedClientIds },
                    );
                    const waId = numberId?._serialized || '';
                    resultLines.push(`${number}\t${numberId ? 'registered' : 'unregistered'}\t${waId}`);
                } catch (error) {
                    if (isDispatchUnavailableError(error)) {
                        stoppedEarly = true;
                        break;
                    }
                    resultLines.push(`${number}\terror\t${error?.message || 'failed'}`);
                }
            }

            const text3 = resultLines.join('\n');
            log(`[task/checknumlist] 用户 ${req.user.username} 完成，共 ${resultLines.length} 条`);
            res.json({
                ok: true, mode, count: resultLines.length, stoppedEarly,
                fileContent: Buffer.from(text3).toString('base64'),
                filename: `checknumlist_${Date.now()}.txt`,
                mimeType: 'text/plain',
            });

        } else if (mode === 'activity') {
            const numbers2 = parsedNumbers;
            const resultLines = [];
            let stoppedEarly = false;

            for (const number of numbers2) {
                try {
                    const r = await runWithExecutionClient(
                        preferredClientId,
                        (execClient) => checkActivityByWsFrames(execClient, number, 5000),
                        { allowedClientIds },
                    );
                    resultLines.push(
                        `${r.number}\t${r.state}\tframes=${r.frameCount}\tkeyword=${r.keywordHits}\tsvc=${r.serviceHits}\t${r.sample ? r.sample.slice(0, 100) : '-'}`,
                    );
                } catch (error) {
                    if (isDispatchUnavailableError(error)) {
                        stoppedEarly = true;
                        break;
                    }
                    resultLines.push(`${number}\terror\t${error?.message || 'failed'}`);
                }
            }

            const text4 = resultLines.join('\n');
            log(`[task/activity] 用户 ${req.user.username} 完成，共 ${resultLines.length} 条`);
            res.json({
                ok: true, mode, count: resultLines.length, stoppedEarly,
                fileContent: Buffer.from(text4).toString('base64'),
                filename: `activity_${Date.now()}.txt`,
                mimeType: 'text/plain',
            });

        } else if (mode === 'wsdebug') {
            const number = parsedNumbers[0] || '';
            if (!number) {
                res.status(400).json({ ok: false, message: '请提供至少一个号码' });
                return;
            }
            const r = await runWithExecutionClient(
                preferredClientId,
                (execClient) => checkActivityByWsFrames(execClient, number, 5000, { includeDebugFrames: true }),
                { allowedClientIds },
            );
            const lines = [
                `号码: ${r.number}`,
                `状态: ${r.state}`,
                `总帧数: ${r.totalFrames} / 已解码: ${r.decodedFrames}`,
                `关键词命中: ${r.keywordHits} / 服务命中: ${r.serviceHits} / 服务解码: ${r.serviceDecoded}`,
                `服务状态: ${r.serviceStatus}`,
                '',
                '---- 帧调试信息 ----',
                ...(r.debugFrames || []),
            ];
            const text = lines.join('\n');
            log(`[task/wsdebug] 用户 ${req.user.username} 完成: ${number}`);
            res.json({
                ok: true,
                mode,
                count: 1,
                fileContent: Buffer.from(text).toString('base64'),
                filename: `wsdebug_${number}_${Date.now()}.txt`,
                mimeType: 'text/plain',
            });

        } else if (mode === 'behavior') {
            const numbers2 = parsedNumbers;
            const resultLines = [];
            let stoppedEarly = false;

            for (const number of numbers2) {
                try {
                    const r = await runWithExecutionClient(
                        preferredClientId,
                        (execClient) => checkNumberBehavior(execClient, number, 5000),
                        { allowedClientIds },
                    );
                    resultLines.push(
                        `${r.number || number}\t${r.behavior || (r.ok ? 'ok' : 'error')}\t${r.message || '-'}`,
                    );
                } catch (error) {
                    if (isDispatchUnavailableError(error)) {
                        stoppedEarly = true;
                        break;
                    }
                    resultLines.push(`${number}\terror\t${error?.message || 'failed'}`);
                }
            }

            const text6 = resultLines.join('\n');
            log(`[task/behavior] 用户 ${req.user.username} 完成，共 ${resultLines.length} 条`);
            res.json({
                ok: true, mode, count: resultLines.length, stoppedEarly,
                fileContent: Buffer.from(text6).toString('base64'),
                filename: `behavior_${Date.now()}.txt`,
                mimeType: 'text/plain',
            });
        }
    } catch (error) {
        log(`任务执行失败 [${mode}]: ${error?.message || error}`);
        if (isDispatchUnavailableError(error)) {
            res.status(503).json({ ok: false, message: error.message });
        } else {
            res.status(500).json({ ok: false, message: error?.message || '任务执行失败' });
        }
    }
});

// Socket.IO 认证中间件
io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token || '';
    if (!token) {
        // 未认证仍允许连接，但 data.user 为空（只收到公共事件）
        return next();
    }
    try {
        socket.data.user = jwt.verify(token, JWT_SECRET);
    } catch {
        // token 无效时不报错，只当匿名
    }
    next();
});

io.on('connection', (socket) => {
    const u = socket.data?.user;
    socket.emit('status', state.status);
    socket.emit('loading', state.loading);
    socket.emit('qr', state.qrDataUrl);
    socket.emit('logs', state.logs);
    socket.emit('clients', u ? getClientsViewForUser(u.sub, u.role) : {});
    socket.emit('role', state.role);
});
const buildClient = (clientId) => {
    const puppeteerConfig = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
        ],
    };

    if (CHROMIUM_PATH) {
        puppeteerConfig.executablePath = CHROMIUM_PATH;
    }

    const authStrategy = REMOTE_AUTH_ENABLED
        ? new RemoteAuth({
              clientId,
              dataPath: REMOTE_AUTH_DATA_PATH,
              backupSyncIntervalMs: Math.max(REMOTE_AUTH_BACKUP_INTERVAL_MS, 60000),
              store: remoteSessionStore,
          })
        : new LocalAuth({ clientId, dataPath: AUTH_DIR });

    const client = new Client({
        authStrategy,
        puppeteer: puppeteerConfig,
    });

    const entry = {
        clientId,
        client,
        status: 'starting',
        manualOffline: false,
    };
    clientPool.set(clientId, entry);
    setClientState(clientId, { status: 'starting' });

    client.on('loading_screen', (percent, message) => {
        if (clientId === MAIN_CLIENT_ID) {
            state.loading = { percent, message };
            io.emit('loading', state.loading);
        }
        setClientState(clientId, { loading: { percent, message } });
    });

    client.on('qr', async (qr) => {
        entry.status = 'waiting_for_scan';
        setClientState(clientId, { status: 'waiting_for_scan' });
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 1 });
        if (clientId === MAIN_CLIENT_ID) {
            state.qrDataUrl = qrDataUrl;
            io.emit('qr', state.qrDataUrl);
        }
        setClientState(clientId, { qrDataUrl });
        log(`[${clientId}] 收到新的登录二维码，请扫码。`);
    });

    client.on('authenticated', () => {
        entry.status = 'authenticated';
        if (clientId === MAIN_CLIENT_ID) {
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
        if (entry.manualOffline) {
            entry.status = 'manual_offline';
            setClientState(clientId, { status: 'manual_offline' });
            log(`[${clientId}] 已手动下线。`);
            return;
        }

        entry.status = 'disconnected';
        setClientState(clientId, { status: 'disconnected' });
        log(`[${clientId}] 连接断开: ${reason}`);
    });

    if (clientId === MAIN_CLIENT_ID) {
        client.on('message', (msg) => handleCommandMessage(msg, client, clientId));
        client.on('message_create', (msg) =>
            handleCommandMessage(msg, client, clientId),
        );
    }

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
    const routeClientIds = await getChatRouteClientIds(chatId).catch(() => null);

    if (
        awaitingTxtModeByChat.has(chatScopeKey) &&
        msg.hasMedia &&
        !msg.body?.startsWith('!')
    ) {
        try {
            const awaitingConfig = awaitingTxtModeByChat.get(chatScopeKey);
            const mode =
                typeof awaitingConfig === 'string'
                    ? awaitingConfig
                    : awaitingConfig?.mode;
            const scopedClientIds =
                typeof awaitingConfig === 'string'
                    ? routeClientIds
                    : awaitingConfig?.routeClientIds || routeClientIds;
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
                let stoppedByDispatcher = false;
                for (const number of uniqueNumbers) {
                    try {
                        const result = await runWithExecutionClient(
                            currentClientId,
                            (execClient) =>
                                runProbeForNumber(execClient, number, PROBE_TEXT),
                            { allowedClientIds: scopedClientIds },
                        );
                        rows.push(
                            `${number}\t${result.activity}\t${
                                result.ack === null ? 'timeout' : result.ack
                            }\t${result.source}\t${result.note || '-'}`,
                        );
                    } catch (error) {
                        if (isDispatchUnavailableError(error)) {
                            stoppedByDispatcher = true;
                            break;
                        }
                        rows.push(`${number}\terror\t-\t-\tprobe_failed`);
                    }
                }
                if (stoppedByDispatcher) {
                    rows.push('----\t----\t----\t----\tdispatcher_unavailable_stopped');
                }
                resultName = `probe-result-${Date.now()}.txt`;
            } else {
                if (!getReadyFilterClients(scopedClientIds).length) {
                    await msg.reply('暂无可用筛选账号，请先上线至少一个筛选账号后重试。');
                    awaitingTxtModeByChat.delete(chatScopeKey);
                    log(`checknum 无可用筛选账号: ${chatId}`);
                    return;
                }

                await msg.reply(
                    `已收到文件，开始检测 ${numbers.length} 个号码，请稍候...`,
                );

                const excelRows = [];
                let stoppedByDispatcher = false;
                for (const number of numbers) {
                    try {
                        const numberId = await runWithExecutionClient(
                            currentClientId,
                            (execClient) => resolveNumberId(execClient, number),
                            { allowedClientIds: scopedClientIds },
                        );
                        const status = numberId ? 'valid' : 'invalid';
                        const waId = numberId?._serialized || `${number}@c.us`;

                        let avatarUrl = '';
                        let note = '';
                        if (numberId?._serialized) {
                            try {
                                const maybeAvatar = await runWithExecutionClient(
                                    currentClientId,
                                    (execClient) =>
                                        execClient.getProfilePicUrl(numberId._serialized),
                                    { allowedClientIds: scopedClientIds },
                                );
                                avatarUrl = maybeAvatar || '';
                                if (!avatarUrl) {
                                    note = 'no_avatar';
                                }
                            } catch {
                                note = 'avatar_fetch_failed';
                            }
                        } else {
                            note = 'not_registered';
                        }

                        excelRows.push({
                            number,
                            status,
                            waId,
                            avatarUrl,
                            note,
                        });
                    } catch (error) {
                        if (isDispatchUnavailableError(error)) {
                            stoppedByDispatcher = true;
                            break;
                        }

                        excelRows.push({
                            number,
                            status: 'error',
                            waId: '-',
                            avatarUrl: '',
                            note: 'check_failed',
                        });
                    }
                }

                const avatarRows = excelRows.filter((item) => Boolean(item.avatarUrl));
                const workbook = await buildChecknumWorkbook(avatarRows);
                resultName = `checknum-result-${Date.now()}.xlsx`;
                const resultPath = path.join(os.tmpdir(), resultName);
                await workbook.xlsx.writeFile(resultPath);

                const resultMedia = MessageMedia.fromFilePath(resultPath);
                await msg.reply(resultMedia, null, { sendMediaAsDocument: true });
                await msg.reply(
                    stoppedByDispatcher
                        ? `筛选账号中途异常，已回传当前成功结果（已处理${excelRows.length}条，仅回传有头像${avatarRows.length}条）。`
                        : `检测完成，结果已通过Excel回传（共检测${excelRows.length}条，仅回传有头像${avatarRows.length}条）。`,
                );

                await fs.unlink(resultPath).catch(() => {});
                awaitingTxtModeByChat.delete(chatScopeKey);
                log(
                    stoppedByDispatcher
                        ? `checknum 部分回传完成: ${chatId}, 已处理 ${excelRows.length} 个号码, 回传有头像 ${avatarRows.length} 个`
                        : `checknum Excel处理完成: ${chatId}, 检测 ${excelRows.length} 个号码, 回传有头像 ${avatarRows.length} 个`,
                );
                return;
            }

            const resultPath = path.join(os.tmpdir(), resultName);
            await fs.writeFile(resultPath, rows.join('\n'), 'utf8');

            const resultMedia = MessageMedia.fromFilePath(resultPath);
            await msg.reply(resultMedia, null, { sendMediaAsDocument: true });
            if (mode === 'probe') {
                const partialStopped = rows.some((line) =>
                    line.includes('dispatcher_unavailable_stopped'),
                );
                await msg.reply(
                    partialStopped
                        ? `筛选账号中途异常，已回传当前探测结果（${rows.length - 2}条）。`
                        : `活跃探测完成，结果已通过TXT回传（${rows.length - 1}条）。`,
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
                '!checknum - 先提示上传TXT，机器人批量检测并回传含头像的Excel结果',
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

        if (!getReadyFilterClients(routeClientIds).length) {
            await msg.reply('暂无可用筛选账号，请先上线至少一个筛选账号再执行批量检测。');
            log('checknumlist 无可用筛选账号');
            return;
        }

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
                    (execClient) => resolveNumberId(execClient, number),
                    { allowedClientIds: routeClientIds },
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
                { allowedClientIds: routeClientIds },
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
                { allowedClientIds: routeClientIds },
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
                { allowedClientIds: routeClientIds },
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
        awaitingTxtModeByChat.set(chatScopeKey, {
            mode: 'probe',
            routeClientIds,
        });
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
                { allowedClientIds: routeClientIds },
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
        awaitingTxtModeByChat.set(chatScopeKey, {
            mode: 'checknum',
            routeClientIds,
        });
        await msg.reply(
            '请发送TXT文件（每行一个号码或混排文本均可），我会自动提取号码并回传含头像的Excel结果。',
        );
        log(`进入TXT检测等待状态: ${currentClientId}/${chatId}`);
        return;
    }
}

async function start() {
    if (REMOTE_AUTH_ENABLED) {
        await fs.mkdir(REMOTE_AUTH_DATA_PATH, { recursive: true });
    } else {
        await fs.mkdir(AUTH_DIR, { recursive: true });
    }

    await initDatabase().catch((error) => {
        log(`数据库初始化失败: ${error?.message || error}`);
    });
    await initRemoteAuthStore().catch((error) => {
        throw new Error(`RemoteAuth初始化失败: ${error?.message || error}`);
    });

    server.listen(PORT, HOST, () => {
        log(`可视化页面已启动: http://${HOST}:${PORT}`);
        log(
            REMOTE_AUTH_ENABLED
                ? `会话模式: RemoteAuth(${REMOTE_AUTH_STORE}), 临时目录: ${REMOTE_AUTH_DATA_PATH}`
                : `会话模式: LocalAuth, 会话目录: ${AUTH_DIR}`,
        );
        if (CHROMIUM_PATH) {
            log(`Chromium路径: ${CHROMIUM_PATH}`);
        }
        const filterIds = CLIENT_IDS.filter((id) => id !== MAIN_CLIENT_ID);
        log(`账号池已配置: ${CLIENT_IDS.join(', ')}`);
        log(`主机器人账号: ${MAIN_CLIENT_ID}`);
        log(`筛选账号: ${filterIds.length ? filterIds.join(', ') : '(未配置)'}`);
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
    try {
        if (dbPool) await dbPool.end();
    } catch {}
    try {
        if (remoteMongoClient) await remoteMongoClient.close();
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
