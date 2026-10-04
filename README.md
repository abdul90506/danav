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
  - **Retry Handling**: A provider that is briefly unavailable — HTTP 429, 5xx, or a connection that dies before the first token — is retried twice with backoff (honouring `Retry-After`), so one rate-limit blip no longer ends a turn. The reply says it was retried. Anything still failing gets an inline **Retry** button in the message.
- **Polished Input Area**:
  - **Attachments**: images are resized before they are sent, text files are truncated, and the whole set is kept inside one message's budget — a file that does not fit says why instead of quietly dropping (or failing the send with a server error later).
  - **Auto-growing textarea that stays put**: it grows with the prompt instead of collapsing itself to measure — a long prompt no longer scrolls back to the top while you type — and after you send, the caret returns to the box, so you can keep typing without clicking it again.
  - `Enter` to send, `Shift + Enter` for new lines.
  - One-click **Stop Generation** button during streaming.
- **Modular Provider Architecture**:
  - Add and configure OpenAI-compatible providers, Ollama, Groq, OpenRouter, or local LLMs.
  - "Test Connection" button with instant diagnostic feedback.
  - "Fetch Models" button queries `/v1/models` and populates the model selector in real time.
  - Built-in Demo provider for out-of-the-box offline testing.
- **AI Agent Mode** (the **Agent** pill above the message box) — the model builds instead of describing: it creates and edits files, runs commands, reads the output and fixes what breaks, in a **cloud sandbox** or a **folder on this machine**. Every step is a plain line of text, in the order it happened (see [Agent mode](#-agent-mode)).
- **Web tools that refuse to be turned inward**: `fetch_url` follows redirects one hop at a time and checks every hop, so a public page cannot answer `302 → http://localhost:3001/api/settings` and have the model read it back. Loopback, private, link-local and cloud-metadata addresses are refused; only public pages are fetched. Provider Base URLs are held to the same rule for the metadata address class, so a URL typed into Settings cannot be aimed at the instance's credentials.
- **Long conversations keep working**: when a chat finally outgrows the model's context window, the provider's 400 ("maximum context length is …") is recognised and the request is retried with the oldest turns left out — halving each time, up to three times — instead of ending the turn with an error. The reply says what was left out; the messages stay in your chat.
- **Resilient search & fetching**:
  - `web_search` cascades through DuckDuckGo HTML → DuckDuckGo Lite → Bing → Mojeek → DDG Instant Answer → Wikipedia, so one blocked engine never fails a query. Results are deduped (max 2 per domain) and returned as structured cards.
  - `fetch_url` detects anti-bot/security interstitials (Cloudflare challenges, captchas, 403/429) and automatically retries through a reader proxy. If a page still can't be read it fails honestly instead of feeding the model a captcha page.
  - Long queries and URLs render on a single truncated line in the action row.
- **Persistent Storage**:
  - Conversations, active chat, custom providers, and theme preferences survive page refreshes via local storage.
  - Agent workspaces are listed in `server/data/agent-workspaces.json` (names, paths, sandbox ids — never keys or file contents).
  - The server keeps the chat store on disk, and before it ever lets it *shrink* (a stale tab saving over newer history, an accidental wipe) it writes the previous version aside to `server/data/conversations.backup.json`. The store route has its own, larger request ceiling (the store carries every conversation and its images) and a store that is somehow still too big to post is retried without the older chats' image payloads — the open chat keeps its pictures — so syncing degrades instead of stopping. **Settings → Chat Data** restores that copy — repeatedly, because restoring leaves the backup in place — and exports every chat as a JSON file.

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

**The file is really being written while you watch.** A `write_file` call is a promise that a file will exist, so the file is created the moment its path is known and every complete line after that is written straight to disk — the workspace panel, a dev server's watcher and `cat` all see the same growing file. The `+N` in the chat is a *reading of that file*, never a promise about it: it is capped at the number of lines actually on disk, so the count can lag behind the model but can never run ahead of the file.

Providers differ in how the body arrives. Those that stream tool calls (OpenAI, Gemini, …) drive it from the token stream. Those that hand over the whole call in one frame — Vyce/Agnes and several proxies do — get the body replayed through the same partial-argument reader, at the same pace, into the same file; nothing about the write changes except who sets the tempo. Either way the row finishes on the numbers the real diff reports, and a run that is **Stopped** mid-write puts the file back exactly as it was.

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

`list_dir` · `file_outline` · `read_file` (line ranges, several in one call) · `write_file` · `append_file` · `edit_file` · `multi_edit` (several edits, in one file or across many, atomically) · `grep_search` · `file_search` · `replace_in_files` · `run_command` (foreground, or `background` for servers) · `list_processes` · `read_process_output` · `stop_process` · `get_preview_url` · `web_search` · `fetch_url` · `image_search` · `search_memory` · `remember` / `forget` · `update_plan`

Housekeeping is not a tool of its own. `write_file` creates every missing parent on its way to the file; folders, moves, copies and removals are `run_command` (`mkdir -p`, `mv`, `cp`, `rm -rf`, or the platform equivalent). A model that still calls an old name such as `create_dir`, `move_file` or `delete_file` is told exactly what to do instead, in one line, rather than left to guess — and the look-before-you-leap rule those tools carried now guards the shell commands: a removal or a move whose targets were never inspected in the run is refused, moving onto a file the agent has never opened is refused, and a command that would take the workspace itself with it always is. What the shell does is fed back into the run's ledger, so a file moved with `mv` is still a file the run knows. The rule is enforced without getting in the way: when a command would remove or replace something the run has not looked at yet, the run looks at it there and then — the folder is listed, the file is read, bounded — and the tool result says in one line what was found, so the model still learns what it is about to touch. Only what cannot be looked at that way (a file over 2 MB, a listing that comes back incomplete) is refused, with the reason; removing or moving the workspace itself is refused, always.

Memory notes are structured by category and priority, ranked against the current request, searchable on demand, and blocked from storing likely credentials. A private, bounded run journal automatically remembers changed paths and recognized test/build checks—never user prompts or file bodies—and appears beside the notes in the Files panel. Context compaction keeps the active request and recent tool results, and the agent retries with a smaller context if a provider rejects an oversized prompt. Danav also loads bounded `AGENTS.md`, Cursor, Windsurf, Claude and Copilot project guidance; those files remain untrusted and cannot override safety rules. Local data files are Git-ignored and written with restrictive permissions on POSIX systems.

Edits are exact-match with guidance when they miss (closest lines are shown), tolerate indentation drift, keep CRLF files CRLF, and report real `+added −removed` and line ranges computed from a Myers diff. A path with a typo is answered with the closest names that exist (`File not found: app.ts Did you mean "app.js"?`), and a pattern that is not a valid regular expression is searched literally *and says so* instead of being reported as "no matches". `list_processes` recovers the ids of background servers from earlier turns, so a dev server started last message can still be checked, previewed or stopped.

### A long run keeps its head

An agent run is dozens of model turns, minutes of wall clock, and a context window that has to be trimmed to fit. Danav manages that in the loop itself, rather than assuming the model behaves:

- **The budget is visible.** Halfway through, the run tells the model where it stands; with five steps or 15% of the time left it says so in the chat too. A wrap-up becomes a decision, not a surprise.
- **Nothing learned is dropped silently.** When the transcript must shrink, the oldest tool rounds each leave one line behind — the call and the first line of what came back — in a small `[work so far]` note at the top. The file bodies go; the findings stay.
- **A dead end is named.** The same call returning the same result four times ends the run with a reason instead of burning what is left of the budget, and any repeat is told plainly that it learned nothing new.
- **Verification is part of the job, not a nag.** The prompt tells the model to run the project's own check before it calls work done, and the checks it recognises (`npm test`, `node --test`, `pytest`, `vitest`, `tsc`, `go test`, `cargo test`, … even inside `cd x && …` or `CI=1 …`) are recorded in the journal.
- **A cut-off answer is not lost.** If the provider's connection dies mid-sentence, the request is repeated and only the part not yet shown is streamed; if it keeps dying, the half that arrived stays on screen and the run carries on. An answer stopped by the provider's own output limit is continued from the exact word it stopped at, rather than shipped half-written.
- **An almost-right tool call still runs.** Weaker models send JSON that is nearly valid — a missing comma, raw newlines inside the body, unescaped quotes in HTML, bare keys, a code fence, a whole object wrapped in a string. Those are repaired (strings are never rewritten: a real `\n` stays a line break, a lone backslash stays text, and a Windows path is not turned into line breaks), and a call that cannot be parsed at all is still mined for its content. If the *path* is what went missing, the body is not thrown away: it is parked in `.danav-recovered/` and the model is told to `move_file` it into place — the file is never retyped. Anything unclaimed is deleted when the run ends.
- **A long file is written in parts.** A write cut off by the output limit keeps every complete line, tells the model the line the file now ends at and says to continue with `append_file` — so a file of any length is built from parts without a single line repeated.
- **The checklist is finished, not abandoned.** A run that has set itself a checklist does not get to end with items still open: the model is handed its own open items back once — silently, in the transcript only — and asked to do them, mark them off, or rewrite the list so it says what is really left, before the closing summary is accepted. A stale list is the model's to fix, and the question is only asked while there is real budget left.
- **Stopping is a pause, not a loss.** The `update_plan` checklist is written into the journal with the files a run changed and the checks it ran, so a run stopped by a limit — or by you — is picked up by the next one (`continue`) from the first unfinished step instead of from scratch. A checklist with open items is handed over even when the run claimed to be finished, because a closing message is not evidence that the work is done. A write that was still in flight when the run stopped is rolled back and named in that handover, so the next run knows the file is exactly as it was rather than assuming half of it landed.
- **It does what was asked — and reads the request charitably.** Typos, broken spelling, Roman Urdu mixed into English, half a sentence: the intent is worked out and acted on, without correcting the user or asking them to rephrase. Extra features, files and refactors nobody asked for are treated as bugs, not bonuses — anything else worth doing is one line at the end, not a surprise commit.
- **It talks like a colleague, not a status ticker.** Most turns carry no message at all: the action rows already show every file read, check run and folder listed, and a sentence that just restates the row under it is noise. The prompt bans the progress formulas outright ("I am going to check X", "Now I will update Y", "Running a syntax check on W") and asks for a line only when the rows cannot say it: what a real change means for you, a check that failed, a decision the agent took — about 0–3 short lines for a whole run. A run that goes three turns without a word and no visible progress is asked once for a line about where the work stands (twice at the very most, and never an announcement of the next tool call). A run that would end in silence is asked for the closing summary instead. That summary is the last message: what changed, which checks passed or failed, and how to run or see it — short by default, with a longer explanation only when you ask for one. It is told to write that summary directly — a report followed by a shorter version of the same thing is exactly what not to do. Ask for a report, a walkthrough or a deep dive and the answer stays as long as you want.
- **One revealed thing at a time.** Opening a menu closes whatever menu was open, an outside click closes it, Escape closes it: the sidebar's chat menu, the composer's model / thinking / attach menus and the workspace menu all share one rule. The file panel, the workspaces dialog, the sandbox manager and Settings are mutually exclusive too — the newest one wins and the older ones close themselves.
- **The composer keeps its caret.** The box has one textarea, in one place in the tree; the layout around it changes with CSS order, so the moment the text grows past a line the element is not thrown away, the caret stays where it was, and typing continues without a click. Sending always brings the chat back to the bottom, even from far up the history — and scrolling up mid-answer stops the follow until the user comes back down.
- **Memory is ranked, not matched literally.** Notes are scored by how rare each word is among your notes, by curated tags, recency and category, and looked up against both the request and the files the workspace was last working on.
- **Six calls deep with no plan** earns one reminder to call `update_plan` — the checklist is rendered in the chat and carried into the next run.

### Safety model

- **Local file tools cannot leave the workspace folder** (`..`, absolute paths and symlinks are checked; `.ssh`, `.aws`, `.gnupg`, `.kube` are blocked; `.git` is read-only for the file tools).
- **Commands run with the app's own secrets stripped from their environment**, and anything resembling those secrets is redacted from file/command output before it reaches the model or the chat. Catastrophic commands (`rm -rf /`, `mkfs`, fork bombs, …) are blocked outright on local workspaces — a heuristic, not a sandbox: that is why local workspaces ask before running commands.
- **The web cannot be a way in:** `fetch_url` refuses localhost, private, link-local and cloud-metadata addresses, so a hostile page cannot make the agent read your local services. The same guard covers the **chat's** web tools — it follows redirects one hop at a time and checks each one, because a public URL can answer `302 → http://localhost:3001/api/settings`. Provider Base URLs supplied by the browser are refused for the cloud-metadata address class (no real endpoint lives there, while a local Ollama or a LAN gateway keeps working).
- **Agent routes are not reachable from other websites:** `/api/agent/*` sends no CORS headers, requires a custom header, and only answers on `localhost` unless you list more hosts in `DANAV_ALLOWED_HOSTS`.
- **A public Danav asks for an access code.** The moment `DANAV_ALLOWED_HOSTS` says this app is reachable on another hostname, every `/api` route needs `x-danav-preview-token` — otherwise any visitor to that URL could spend your provider key and start Agent runs. Danav generates a code on first start, prints it in the banner and keeps it in `server/data/preview-token.txt`; the UI shows a lock screen and remembers the code for the tab. Set `DANAV_PREVIEW_TOKEN` to choose your own, or `DANAV_DISABLE_PREVIEW_AUTH=1` if something else in front of the app already authenticates everyone. Local development is unaffected.
- Runs are bounded (steps, time, per-command timeout), one run per workspace at a time, and **Stop** kills whatever is running — including child processes.

### Serving the built app

`npm run build` writes `dist/`, and `npm start` serves it from the same process as the API (port 3001). Responses are compressed, hashed assets are sent with a one-year immutable cache, and `index.html` is always revalidated — so a deploy is picked up on the next load instead of being masked by a cached page.

### Configuration

| Variable | Default | |
|---|---|---|
| `NOVITA_API_KEY` | – | cloud sandboxes |
| `DANAV_WORKSPACES_DIR` | `~/danav-workspaces` | where new local workspaces go |
| `DANAV_ALLOW_ANY_LOCAL_PATH` | off | `1` lets a local workspace be any folder (never your whole home folder) |
| `DANAV_ALLOWED_HOSTS` | loopback only | extra hostnames for `/api/agent/*` (e.g. `.trycloudflare.com`); also switches on the preview access code |
| `DANAV_PREVIEW_TOKEN` | generated | the access code a public preview must send |
| `DANAV_DISABLE_PREVIEW_AUTH` | off | `1` serves publicly with no access code (behind your own auth) |
| `NOVITA_SANDBOX_TIMEOUT_MINUTES` | 30 | idle time before a sandbox pauses |
| `DANAV_AGENT_MAX_STEPS` / `_MAX_RUN_MINUTES` | 80 / 45 | limits for one run |
| `DANAV_AGENT_COMMAND_TIMEOUT_SECONDS` | 120 | default per-command timeout (max 900) |
| `DANAV_AGENT_CONTEXT_CHARS` | 420000 | old tool output is trimmed beyond this |
| `DANAV_MAX_TOKENS` | 32768 | output cap per model round |
| `TMDB_API_KEY` | TMDB's published sample key | the key behind `movie_search`; your own gets a private quota |
| `FLIXRAID_API_URL` | – | optional self-hosted catalogue API used when TMDB returns nothing |

On **Windows**, local commands run in PowerShell (set `DANAV_SHELL=cmd` for `cmd.exe`).

## 🧪 Testing

Full app / streaming suite — runs against the instance you are using, so it needs the dev server up (it drives the mock provider, not your keys):
```bash
node scripts/test-all.js
```

Everything else is self-contained and runs together with `npm run test:suites`:

| Suite | What it covers |
|---|---|
| `test:splitter` | the fence/thought stream splitter |
| `test:tooltrail` | how a tool trail is persisted and settled |
| `test:fetchguard` | the web-fetch guard: loopback/private/metadata refusal, per-hop redirect checks, provider Base URL policy |
| `test:server` | a real `server/index.js` on a spare port with its own data dir: keys never reach the browser, the chat store round-trips, shrinks are backed up, restore works and survives itself, 4xx answers are JSON |
| `test:markdown`, `test:storage`, `test:api` | the frontend's normalisers, storage revival and streaming client, run against the real `.ts` sources |
| `test:agent` | agent mode end to end with a scripted model |

Agent mode (no API keys or network needed — a scripted fake LLM drives the real loop, tools, HTTP routes and the UI's data path):
```bash
npm run test:agent
```
Also hit a **real** Novita sandbox (creates one sandbox, uses it, kills it):
```bash
npm run test:agent:sandbox        # needs NOVITA_API_KEY in .env
```
Try Agent mode in the browser without a model key: `npm run fake-llm`, then add a provider with base URL `http://127.0.0.1:4010/v1` and model `fake-build`.

### Measuring what a unit test cannot

Some behaviour only exists in a real browser or against a real model. These drive one and print what they measured (they need `npm run dev:web` running, and a Chrome/Edge install):

```bash
npm run harness:preview            # drag the divider: renders per frame, header height, font ramp
npm run harness:preview:reload     # rebuild the app behind a stable preview URL: does the panel follow?
npm run probe:raw <model>          # is a tool call really streamed, or dumped in one SSE frame?
npm run probe:live <model>         # the whole HTTP/SSE path, with the gap between live updates
npm run probe:gate <model>         # asks a real model to delete a folder it has never seen
```
