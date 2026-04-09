# Visual UI Cloud Deployment

This project requires a Node.js backend for QR generation and Socket.IO updates.
Do not deploy this UI with GitHub Pages alone.

## Railway Deployment (Recommended)

1. Push this repository to GitHub.
2. Create a new Railway project from this repo.
3. Railway detects `Dockerfile` at repository root and builds automatically.
4. Add a persistent volume and mount it at `/data`.
5. Set environment variables:
   - `PORT` = Railway provided port (auto)
   - `HOST` = `0.0.0.0`
   - `CHROMIUM_PATH` = `/usr/bin/chromium`
   - `WWEBJS_AUTH_DIR` = `/data/.wwebjs_auth`
   - `WWEBJS_CLIENT_IDS` = `visual-ui` (or multiple IDs separated by commas)
6. Deploy and open the generated Railway URL.

## Render Deployment (Alternative)

1. Create a Web Service from this repo.
2. Runtime: Docker.
3. Add a persistent disk mounted at `/data`.
4. Use the same environment variables as above.
5. Deploy and open the service URL.

## Notes

- If persistent storage is missing, QR login session may be lost after restart.
- First launch may take longer because Chromium starts and WhatsApp session initializes.
