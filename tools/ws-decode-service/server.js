'use strict';

const express = require('express');
const bodyParser = require('body-parser');
const { proto } = require('@adiwajshing/baileys');

const app = express();
const PORT = Number(process.env.WS_DECODE_PORT || 3000);

app.use(bodyParser.json({ limit: '10mb' }));

const summarizeMessageType = (msg) => {
    if (!msg || !msg.message) return 'other';

    const keys = Object.keys(msg.message || {});
    if (!keys.length) return 'other';

    // common message type examples: conversation, extendedTextMessage, imageMessage...
    return keys[0] || 'other';
};

const compactWebMessageInfo = (msg) => {
    if (!msg) return null;

    return {
        key: msg.key || null,
        messageTimestamp: msg.messageTimestamp || null,
        status: msg.status || null,
        participant: msg.participant || null,
        messageType: summarizeMessageType(msg),
        hasMessage: !!msg.message,
        pushName: msg.pushName || null,
        messageStubType: msg.messageStubType || null,
        messageStubParameters: msg.messageStubParameters || null,
    };
};

const extractPhoneFromSummary = (summary) => {
    const jid = summary?.key?.remoteJid || '';
    if (!jid || typeof jid !== 'string' || !jid.includes('@')) return null;
    return jid.split('@')[0] || null;
};

const looksActiveMessageType = (messageType) => {
    const highSignals = new Set([
        'conversation',
        'extendedTextMessage',
        'imageMessage',
        'videoMessage',
        'audioMessage',
        'documentMessage',
        'stickerMessage',
        'reactionMessage',
        'buttonsMessage',
        'listMessage',
        'pollCreationMessage',
    ]);
    return highSignals.has(String(messageType || 'other'));
};

const deepIncludesKey = (value, keyNames) => {
    if (!value || typeof value !== 'object') return false;
    const stack = [value];
    const lowerKeys = keyNames.map((k) => String(k).toLowerCase());

    while (stack.length) {
        const current = stack.pop();
        if (!current || typeof current !== 'object') continue;

        for (const key of Object.keys(current)) {
            const lower = key.toLowerCase();
            if (lowerKeys.some((name) => lower.includes(name))) return true;

            const next = current[key];
            if (next && typeof next === 'object') stack.push(next);
        }
    }

    return false;
};

const detectActivityLevel = (obj, summary) => {
    if (!obj) return 'not_exist';

    const asJson = JSON.stringify(obj).toLowerCase();

    const hasPresenceAvailable =
        asJson.includes('"available":true') || asJson.includes('"isonline":true');
    const hasLastSeen =
        asJson.includes('lastseen') ||
        asJson.includes('last seen') ||
        deepIncludesKey(obj, ['lastseen', 'last_seen']);

    if (hasPresenceAvailable || looksActiveMessageType(summary?.messageType)) {
        return 'high_active';
    }

    if (hasLastSeen) {
        return 'mid_active';
    }

    return 'low_active';
};

const decodeOneFrame = (frame, index, includeRaw) => {
    try {
        const buf = Buffer.from(String(frame), 'base64');
        const decoded = proto.WebMessageInfo.decode(buf);
        const asObject = proto.WebMessageInfo.toObject(decoded, {
            longs: String,
            enums: String,
            bytes: String,
        });

        const summary = compactWebMessageInfo(asObject);
        return {
            index,
            exists: true,
            phone: extractPhoneFromSummary(summary),
            type: summary?.messageType || 'other',
            activity: detectActivityLevel(asObject, summary),
            summary,
            raw: includeRaw ? asObject : undefined,
        };
    } catch (error) {
        return {
            index,
            exists: false,
            phone: null,
            type: 'decode_error',
            activity: 'not_exist',
            error: error?.message || String(error),
        };
    }
};

const pickFinalActivity = (results) => {
    if (!Array.isArray(results) || !results.length) return 'not_exist';

    const score = {
        high_active: 3,
        mid_active: 2,
        low_active: 1,
        not_exist: 0,
    };

    let best = 'not_exist';
    for (const row of results) {
        const activity = row?.activity || 'not_exist';
        if ((score[activity] || 0) > (score[best] || 0)) {
            best = activity;
        }
    }

    return best;
};

app.get('/health', (_req, res) => {
    res.json({ success: true, service: 'ws-decode-service', port: PORT });
});

// POST /decode
// body: { frames: [base64_frame1, base64_frame2, ...], includeRaw?: boolean }
app.post('/decode', (req, res) => {
    const frames = Array.isArray(req.body?.frames) ? req.body.frames : [];
    const includeRaw = !!req.body?.includeRaw;

    if (!frames.length) {
        return res.status(400).json({
            success: false,
            error: 'frames is required and must be a non-empty array',
        });
    }

    const results = frames.map((frame, index) =>
        decodeOneFrame(frame, index, includeRaw),
    );

    return res.json({
        success: true,
        total: frames.length,
        decoded: results.filter((r) => r.exists).length,
        activity: pickFinalActivity(results),
        results,
    });
});

// POST /decode-batch
// body:
// {
//   items: [{ phone: "852...", frames: ["base64..."] }],
//   includeRaw?: false
// }
// OR
// {
//   data: { "852...": ["base64..."], "852...": ["base64..."] },
//   includeRaw?: false
// }
app.post('/decode-batch', (req, res) => {
    const includeRaw = !!req.body?.includeRaw;

    let items = [];
    if (Array.isArray(req.body?.items)) {
        items = req.body.items;
    } else if (req.body?.data && typeof req.body.data === 'object') {
        items = Object.entries(req.body.data).map(([phone, frames]) => ({
            phone,
            frames,
        }));
    }

    if (!items.length) {
        return res.status(400).json({
            success: false,
            error: 'items or data is required',
        });
    }

    const results = items.map((item, itemIndex) => {
        const phone = String(item?.phone || '').trim() || null;
        const frames = Array.isArray(item?.frames) ? item.frames : [];

        const frameResults = frames.map((frame, frameIndex) =>
            decodeOneFrame(frame, frameIndex, includeRaw),
        );

        const activity = pickFinalActivity(frameResults);
        return {
            index: itemIndex,
            phone,
            totalFrames: frames.length,
            decodedFrames: frameResults.filter((r) => r.exists).length,
            activity,
            results: frameResults,
        };
    });

    return res.json({
        success: true,
        totalNumbers: results.length,
        results,
    });
});

app.listen(PORT, () => {
    console.log(`WS decode service running on port ${PORT}`);
});
