# BlackDesi AI

Chat app with free AI models, plus an optional agent mode that builds apps in a cloud sandbox.

## Run locally

```bash
npm install
cp .env.example .env     # then fill in the keys you have
npm run dev              # backend on :3001, frontend on :5173
```

## Free models and API keys

Keys are read from `.env` on the server. They are never sent to the browser.

| Variable | Used for |
|---|---|
| `GEMINI_API_KEY` | Free: `models/gemini-3.1-flash-lite`, `models/gemini-3.5-flash-lite` |
| `VYCE_API_KEY` | Free: `agnes-3.0-flash` |
| `NOVITA_API_KEY` | Agent mode cloud sandbox |

- A free model is tagged **FREE** in the model selector and uses the shared key.
- If a visitor saves their own key for that provider in **Settings → Providers**, their key is used instead and the tag is hidden.
- Every other model needs the visitor's own key.

## Deploy on Vercel

1. Import this repo in Vercel. Framework: Vite, build `npm run build`, output `dist` (already set in `vercel.json`).
2. In **Project → Settings → Environment Variables** add:

```
GEMINI_API_KEY=...
VYCE_API_KEY=...
NOVITA_API_KEY=...
BLACKDESI_ALLOWED_HOSTS=.vercel.app,.blackdesi.com
BLACKDESI_DISABLE_PREVIEW_AUTH=1
```

3. Deploy. `api/index.js` runs the backend; `vercel.json` sends `/api/*` to it and everything else to the app.

Notes:
- `BLACKDESI_ALLOWED_HOSTS` lets the agent routes answer on the public host. `BLACKDESI_DISABLE_PREVIEW_AUTH=1` removes the access code, so anyone can use agent mode and the Novita sandbox. To lock it, delete the second line and set `BLACKDESI_PREVIEW_TOKEN=<your code>`.
- Local folder workspaces are disabled on Vercel. Use cloud sandbox workspaces.
- The Vercel filesystem is temporary. Server-saved settings and chats live in `/tmp` and can be lost. Browsers also keep chats in local storage.

## Contact

Contact@blackdesi.com
