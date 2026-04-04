# WS Decode Service (Baileys)

A small Node.js service that accepts Base64 websocket frames and decodes them with Baileys protobuf (`WebMessageInfo`).

Activity levels:

- `high_active`: presence available or clear message activity signal.
- `mid_active`: last-seen like signal detected.
- `low_active`: decoded but weak/no presence signal.
- `not_exist`: decode failed.

## 1) Install

```bash
cd tools/ws-decode-service
npm install
```

## 2) Start service

```bash
npm start
```

Default port is `3000`.

You can change it with:

```bash
WS_DECODE_PORT=3100 npm start
```

## 3) API

### Health

`GET /health`

### Decode frames

`POST /decode`

Request body:

```json
{
  "frames": ["<base64_1>", "<base64_2>"],
  "includeRaw": false
}
```

Response example:

```json
{
  "success": true,
  "total": 2,
  "decoded": 1,
  "activity": "high_active",
  "results": [
    {
      "index": 0,
      "exists": true,
      "activity": "high_active",
      "type": "conversation",
      "summary": {
        "key": {"remoteJid": "xxx@s.whatsapp.net"},
        "messageTimestamp": "1743770000",
        "status": "SERVER_ACK",
        "participant": null,
        "messageType": "conversation",
        "hasMessage": true,
        "pushName": null,
        "messageStubType": null,
        "messageStubParameters": null
      }
    },
    {
      "index": 1,
      "exists": false,
      "error": "index out of range"
    }
  ]
}
```

### Batch decode by phone

`POST /decode-batch`

Request body format A:

```json
{
  "items": [
    { "phone": "85295693975", "frames": ["<base64_1>", "<base64_2>"] },
    { "phone": "85291234567", "frames": ["<base64_3>"] }
  ],
  "includeRaw": false
}
```

Request body format B:

```json
{
  "data": {
    "85295693975": ["<base64_1>", "<base64_2>"],
    "85291234567": ["<base64_3>"]
  },
  "includeRaw": false
}
```

Response example:

```json
{
  "success": true,
  "totalNumbers": 2,
  "results": [
    {
      "index": 0,
      "phone": "85295693975",
      "totalFrames": 2,
      "decodedFrames": 1,
      "activity": "mid_active",
      "results": []
    }
  ]
}
```

## 4) Python integration

Use [python_client_example.py](python_client_example.py) as a base:

1. Capture WS frame bytes from your robot/Playwright.
2. Base64 encode and post to `/decode`.
3. Use returned `type`/`summary` to classify state.

Batch to CSV:

```bash
python3 python_batch_to_csv.py --input sample_batch_input.json --output ws_activity.csv
```

Generated CSV columns:

- `phone`
- `activity`
- `total_frames`
- `decoded_frames`

Input JSON file can be:

- `{ "data": { "phone": ["base64..."] } }`
- or directly `{ "phone": ["base64..."] }`

## Notes

- Not all websocket frames are `WebMessageInfo`; decode failures are expected.
- `includeRaw=true` can return a large payload. Keep it `false` in production for speed.
