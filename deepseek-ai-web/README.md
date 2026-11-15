# DeepSeek AI Chat

Standalone source package for deploying the chat app on a Node.js hosting service.

## Requirements

- Node.js 20.19 or newer
- An APINex API key, configured as a server-side environment variable

## Run locally

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and add your APINex key.
3. Start the app: `npm run dev`
4. Open the Vite address printed in the terminal (normally `http://localhost:5173`).

## Deploy

Configure the hosting service with:

- Build command: `npm install && npm run build`
- Start command: `npm start`
- Secret/environment variable: `APINEX_API_KEY`
- Port: use the `PORT` value provided by the hosting service

The Express server serves the built website and its `/api` endpoints from the same host. Keep `APINEX_API_KEY` in the hosting service's secret settings; do not put the real key in source code or commit a `.env` file.

## File attachments

The browser extracts text from PDF, DOCX, and supported text/code files before sending the question to APINex. Scanned PDFs without selectable text and image uploads are not supported. Extracted document text is included in the local browser chat history.

Before making the site public, configure request limits or access controls on the hosting service to protect API quota.
