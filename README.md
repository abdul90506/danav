# Danav AI Chat

A modern, clean, professional AI chatbot application built with a flat 2D interface.

## ✨ Features

- **Flat 2D Modern UI**: Lightweight, minimal design with subtle borders, clean spacing, and default Light theme (supports Light, Dark, and System).
- **Collapsible Sidebar**:
  - **New Chat** button immediately starts a fresh conversation without clearing history.
  - **Chat History**: Compact list with timestamps, inline rename, and delete actions.
  - **Search**: Instant chat filtering across titles and messages.
  - **Sidebar Collapse**: Minimizes to an icon sidebar for maximum chat viewing width.
- **Top Bar Model & Thinking Selectors**:
  - **Dynamic Model Selector**: Groups models by provider (OpenAI, Groq, Ollama, Custom APIs). Updates automatically when providers or models are added/edited in Settings.
  - **Thinking Level Control**: Clean, unobtrusive dropdown (Auto, Low, Medium, High) forwarded to reasoning models (OpenAI o1/o3, DeepSeek R1, Claude 3.7).
- **Open & Focused Chat Area**:
  - Full support for Markdown, headings, lists, tables, and links.
  - **Code Blocks**: Dedicated language badge and isolated **Copy** button per code block.
  - **Message Actions**: One-click copy for user and assistant messages.
  - **Subtle Status Indicator**: Unobtrusive "Thinking..." or "Generating..." indicator without bulky cards or progress bars.
  - **Retry Handling**: Inline retry button if an upstream provider error occurs.
- **Polished Input Area**:
  - Auto-growing multiline textarea.
  - `Enter` to send, `Shift + Enter` for new lines.
  - One-click **Stop Generation** button during streaming.
- **Modular Provider Architecture**:
  - Add and configure OpenAI-compatible providers, Ollama, Groq, OpenRouter, or local LLMs.
  - "Test Connection" button with instant diagnostic feedback.
  - "Fetch Models" button queries `/v1/models` and populates the model selector in real time.
  - Built-in Demo provider for out-of-the-box offline testing.
- **AI Agent Mode** (the **Agent** toggle next to the model picker):
  - **Chronological transcript**: every step is rendered in the exact order the model produced it — Thinking panel, then each tool action, then the sentence written about it. Nothing is reordered or hidden, so an action and the text describing it always stay together.
  - **Live actions**: files, edits, terminal commands and searches appear as compact action rows while they run, with `+/-` line counts and expandable output.
  - **Thinking**: rendered in the same collapsible *Thinking* panel as normal chat mode.
  - **Workspace tools**: `list_dir`, `read_file`, `write_file`, `edit_file`, `run_command`, `web_search`, `image_search`, `fetch_url`, `file_search`, `grep_search`, `delete_file`.
  - **Persistent memory**: per-workspace memory of every file created/edited, command run and search performed. Injected back into the agent on each turn, so it never rebuilds work it already did — even after a reload.
  - **Context management**: long sessions are compacted into a rolling summary against a token budget, so the agent never overflows the model's context window mid-task. The **memory pill** in the top-right shows context usage and everything the agent remembers.
  - **Honest completion**: if the model tries to stop right after a tool call without saying anything, the agent nudges it to actually report what it did — and never fabricates a "successfully updated" message. Finished turns always collapse their Thinking panel.
  - **Self-recovery**: a failed tool feeds a `[RECOVERY]` hint back to the model; if the same action fails repeatedly the agent stops looping and explains the blocker. Step budget remaining is shown to the model, and exhausting it produces a real wrap-up summary instead of silence.
- **Resilient search & fetching**:
  - `web_search` cascades through DuckDuckGo HTML → DuckDuckGo Lite → Bing → Mojeek → DDG Instant Answer → Wikipedia, so one blocked engine never fails a query. Results are deduped (max 2 per domain) and returned as structured cards.
  - `fetch_url` detects anti-bot/security interstitials (Cloudflare challenges, captchas, 403/429) and automatically retries through a reader proxy. If a page still can't be read it fails honestly instead of feeding the model a captcha page.
  - Long queries and URLs render on a single truncated line in the action row.
- **Persistent Storage**:
  - Conversations, active chat, custom providers, and theme preferences survive page refreshes via local storage.
  - Agent memory is persisted server-side in `server/data/memory.json`, keyed by workspace.

## 🚀 Getting Started

### 1. Start the Application
One command starts **both** the backend (port 3001) and the frontend (port 5173):
```bash
npm run dev
```
The supervisor waits until the backend is accepting connections before starting Vite, and restarts the backend automatically if it crashes — so you should never see a wall of `http proxy error ... ECONNREFUSED`.

> Running `vite` by itself only starts the frontend. Every `/api/*` call then fails with `ECONNREFUSED` because nothing is listening on port 3001. Use `npm run dev`, not `npm run dev:web`, unless you already have a backend running.

Run the two halves separately if you prefer:
```bash
# Terminal 1: Backend proxy, agent tools & model fetcher (Port 3001)
npm run server

# Terminal 2: Vite frontend only (Port 5173)
npm run dev:web
```

Override ports with `PORT` / `VITE_PORT` (the Vite proxy follows `PORT` automatically):
```bash
PORT=3021 VITE_PORT=5273 npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### 2. Configure Providers
1. Click **Settings** in the bottom of the sidebar.
2. Select **Providers & Models** tab.
3. Click **Add Provider**, enter your base URL (e.g., `https://api.openai.com/v1`, `https://api.groq.com/openai/v1`, or `http://localhost:11434`), enter your API key, and click **Fetch Models**.
4. Click **Save Provider**. Your newly fetched models will appear in the top model selector.

## 🧪 Testing

Full app / streaming suite (requires the backend and Vite dev server running):
```bash
node scripts/test-all.js
```

Agent + memory suite (requires the backend running on port 3001):
```bash
npm run test:agent
```
Override the target with `AGENT_TEST_URL=http://localhost:3011 npm run test:agent`.
