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
- **AI Agent Mode** (the **Agent** pill above the message box) — the model builds instead of describing: it creates and edits files, runs commands, reads the output and fixes what breaks, in a **cloud sandbox** or a **folder on this machine**. Every step is a plain line of text, in the order it happened (see [Agent mode](#-agent-mode)).
- **Resilient search & fetching**:
  - `web_search` cascades through DuckDuckGo HTML → DuckDuckGo Lite → Bing → Mojeek → DDG Instant Answer → Wikipedia, so one blocked engine never fails a query. Results are deduped (max 2 per domain) and returned as structured cards.
  - `fetch_url` detects anti-bot/security interstitials (Cloudflare challenges, captchas, 403/429) and automatically retries through a reader proxy. If a page still can't be read it fails honestly instead of feeding the model a captcha page.
  - Long queries and URLs render on a single truncated line in the action row.
- **Persistent Storage**:
  - Conversations, active chat, custom providers, and theme preferences survive page refreshes via local storage.
  - Agent workspaces are listed in `server/data/agent-workspaces.json` (names, paths, sandbox ids — never keys or file contents).

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

## 🤖 Agent mode

Turn on **Agent** and the model stops *describing* code and starts *building* it. You watch every step as it happens, as plain text — no cards, no status boxes:

```
Creating  📄 index.html  +77 −98          ← the label shimmers while it runs; +N counts up live as the model writes
Analyzed  📄 src/App.tsx  L1–L120
Edited    📄 style.css  L12–L18, L40  +9 −4 · 2 edits      ← click for the diff
Ran       $ npm test  · 4.2s              ← click for the output
Started   $ vite --host 0.0.0.0  bg-1 :5173
Preview ready on port 5173  abc-5173.sandbox.novita.ai ↗
```

A file is always *watched* being written, never dumped. Providers that stream tool calls (OpenAI, Gemini, …) drive `+N` directly from the token stream. Providers that hand over a whole call in one frame — Vyce/Agnes and several proxies do — get the body replayed instead: the same partial-argument reader is fed growing prefixes of the finished JSON, so the count climbs and the last lines scroll exactly as if it were being typed. Only the display is paced; the write itself happens at full speed, and the row finishes on the numbers the real diff reports.

### Two kinds of workspace

| | ☁ Cloud sandbox | 💻 This machine |
|---|---|---|
| Runs on | an isolated Linux micro-VM from [Novita Agent Sandbox](https://novita.ai) (root, Node, Python, git, gcc) | the computer running Danav — files appear right on your disk |
| Commands | run without asking (it is disposable) | **ask first** by default — *Allow / Always allow / Deny* in the chat |
| Web apps | get a public preview link (`get_preview_url`) | `http://localhost:PORT` |
| Lifetime | pauses after 30 idle minutes and resumes in ~1 s with files intact; deleting the workspace kills it | a normal folder (`~/danav-workspaces/<name>` by default) |

### Set up

1. **Sandbox:** create a key at *novita.ai → Key Management*, then either put `NOVITA_API_KEY=sk_…` in `.env` (copy `.env.example`) or paste it in the *New workspace* dialog. The key lives on the server only — it is never sent to the browser, never shown in a response, and removed from anything the agent reads or runs.
2. Click **Agent → New workspace…**, pick *Cloud sandbox* or *This machine*, and describe what to build.
3. Use any model that supports **tool calling** (OpenAI-compatible `tools`). `Think` levels are passed through.

**Files** (next to the workspace chip) opens a side panel with the workspace's file tree and a viewer; it refreshes while the agent works.

### Tools

`list_dir` · `file_outline` · `read_file` (line ranges, several in one call) · `write_file` · `append_file` · `edit_file` · `multi_edit` (several edits, in one file or across many, atomically) · `delete_file` · `move_file` · `create_dir` · `grep_search` · `file_search` · `replace_in_files` · `run_command` (foreground, or `background` for servers) · `list_processes` · `read_process_output` · `stop_process` · `get_preview_url` · `web_search` · `fetch_url` · `image_search` · `remember` / `forget` · `update_plan`

Edits are exact-match with guidance when they miss (closest lines are shown), tolerate indentation drift, keep CRLF files CRLF, and report real `+added −removed` and line ranges computed from a Myers diff. `list_processes` recovers the ids of background servers from earlier turns, so a dev server started last message can still be checked, previewed or stopped.

### Safety model

- **Local file tools cannot leave the workspace folder** (`..`, absolute paths and symlinks are checked; `.ssh`, `.aws`, `.gnupg`, `.kube` are blocked; `.git` is read-only for the file tools).
- **Commands run with the app's own secrets stripped from their environment**, and anything resembling those secrets is redacted from file/command output before it reaches the model or the chat. Catastrophic commands (`rm -rf /`, `mkfs`, fork bombs, …) are blocked outright on local workspaces — a heuristic, not a sandbox: that is why local workspaces ask before running commands.
- **The web cannot be a way in:** `fetch_url` refuses localhost, private, link-local and cloud-metadata addresses, so a hostile page cannot make the agent read your local services.
- **Agent routes are not reachable from other websites:** `/api/agent/*` sends no CORS headers, requires a custom header, and only answers on `localhost` unless you list more hosts in `DANAV_ALLOWED_HOSTS`. If you expose Danav publicly, put it behind authentication first — whoever can reach it can run commands in your workspaces.
- Runs are bounded (steps, time, per-command timeout), one run per workspace at a time, and **Stop** kills whatever is running — including child processes.

### Configuration

| Variable | Default | |
|---|---|---|
| `NOVITA_API_KEY` | – | cloud sandboxes |
| `DANAV_WORKSPACES_DIR` | `~/danav-workspaces` | where new local workspaces go |
| `DANAV_ALLOW_ANY_LOCAL_PATH` | off | `1` lets a local workspace be any folder (never your whole home folder) |
| `DANAV_ALLOWED_HOSTS` | loopback only | extra hostnames for `/api/agent/*` (e.g. `.trycloudflare.com`) |
| `NOVITA_SANDBOX_TIMEOUT_MINUTES` | 30 | idle time before a sandbox pauses |
| `DANAV_AGENT_MAX_STEPS` / `_MAX_RUN_MINUTES` | 80 / 45 | limits for one run |
| `DANAV_AGENT_COMMAND_TIMEOUT_SECONDS` | 120 | default per-command timeout (max 900) |
| `DANAV_AGENT_CONTEXT_CHARS` | 420000 | old tool output is trimmed beyond this |
| `DANAV_MAX_TOKENS` | 32768 | output cap per model round |

On **Windows**, local commands run in PowerShell (set `DANAV_SHELL=cmd` for `cmd.exe`).

## 🧪 Testing

Full app / streaming suite (requires the backend and Vite dev server running):
```bash
node scripts/test-all.js
```

The repo's unit suites (`test:splitter`, `test:tooltrail`, `test:markdown`, `test:storage`, `test:api`, `test:agent`) run together with `npm run test:suites`. The TypeScript ones use `--experimental-strip-types`, so they need **Node 22.6+** (`test:agent` works on Node 20 too).

Agent mode (no API keys or network needed — a scripted fake LLM drives the real loop, tools, HTTP routes and the UI's data path):
```bash
npm run test:agent
```
Also hit a **real** Novita sandbox (creates one sandbox, uses it, kills it):
```bash
npm run test:agent:sandbox        # needs NOVITA_API_KEY in .env
```
Try Agent mode in the browser without a model key: `npm run fake-llm`, then add a provider with base URL `http://127.0.0.1:4010/v1` and model `fake-build`.
