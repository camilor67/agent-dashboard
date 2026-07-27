# Agent Dashboard

A real-time pixel-art dashboard for monitoring multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI agent sessions running on your machine.

![Agent Dashboard](https://img.shields.io/badge/Claude_Code-Monitor-7aa2f7?style=flat-square)

## What it does

Agent Dashboard reads Claude Code's local JSONL session files (`~/.claude/projects/`) and displays all active and recent sessions in a visual dashboard with:

- **Pixel-art office view** — Each project gets its own "zone" with desks and animated characters representing agents. The grid layout adapts automatically based on the number of projects (roughly square).
- **Side panel** with real-time agent cards showing:
  - Project name and current status (working, thinking, completed, needs input, needs permission)
  - Last user prompt and last assistant response (click to expand)
  - Current tool being used (Read, Edit, Bash, etc.)
  - Model name (e.g. `opus-4-6`, `sonnet-4-6`)
  - Time since last activity
  - Working directory
- **Warp integration** — Click "Open in Warp" to jump to the session's Warp window (matched by title, with app activation as fallback), and "New agent" to launch a fresh `claude` session in a new Warp window via a generated Launch Configuration.
- **Claude.ai plan usage** — Shows your current plan utilization (5-hour and 7-day limits) by scraping the claude.ai usage API with your session cookie.
- **Sound alerts** — Optional notification sound when an agent needs your attention (permission or input).
- **WebSocket live updates** — File changes are detected instantly via chokidar and pushed to the browser.

## Requirements

- **Node.js** >= 18
- **Claude Code CLI** — must be installed and running sessions locally
- **Warp** (optional) — for the "Open in Warp" / "New agent" terminal features
- **macOS** — process detection uses `ps` and `lsof`; terminal integration uses `open`, Warp Launch Configurations, and (for window focus) System Events, which needs Accessibility permission for the terminal that runs the server — it degrades to just activating Warp without it

## Setup

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/agent-dashboard.git
cd agent-dashboard

# Install dependencies
npm install

# Create your .env file from the example
cp .env.example .env
```

Edit `.env` with your values:

```env
CLAUDE_ORG_ID=your-org-id-here
CLAUDE_SESSION_KEY=sk-ant-sid01-xxxxx
CLAUDE_COOKIE=your-full-cookie-string-here
```

### How to get these values

1. **CLAUDE_ORG_ID**: Go to [claude.ai/settings](https://claude.ai/settings) — it's the UUID in the URL or visible in network requests.
2. **CLAUDE_COOKIE**: Open DevTools on claude.ai → Application → Cookies. Copy the full cookie string (you can also grab it from a network request's `Cookie` header). This is needed for plan usage tracking.
3. **CLAUDE_SESSION_KEY**: The `sessionKey` value from your claude.ai cookies (also included inside `CLAUDE_COOKIE`).

> **Note:** Cookies expire periodically. Use the "Update Cookie" button in the dashboard to refresh them without restarting the server.

## Running

```bash
# Start the server
node server.js

# Or use --watch for auto-reload during development
node --watch server.js
```

Open [http://localhost:3456](http://localhost:3456) in your browser.

The server binds to `127.0.0.1` only — it is **not accessible from the network**.

## Features in detail

### Agent state detection

The dashboard analyzes JSONL session files to determine each agent's state:

| State | Description |
|-------|-------------|
| **Working** | Agent is executing a tool (Read, Edit, Bash, etc.) |
| **Thinking** | Agent received a message and is processing |
| **Completed** | Turn finished, showing last response |
| **Needs Input** | Agent asked a question and is waiting for your reply |
| **Needs Permission** | A tool call is pending approval (e.g. file write, bash command) |
| **Offline** | The last conversational turn is old and no `claude` process is running in that session's working directory |

State is decided from the last *conversational* JSONL entry (`user`, `assistant`, `progress`, or `system:turn_duration`) — other entry types the CLI writes (`attachment`, `system:away_summary`, `system:stop_hook_summary`, etc.) update the "last seen" timestamp shown in the UI but never flip the state on their own. Process liveness is checked per session (by matching the agent's working directory against `lsof`-reported cwds of running `claude` processes), not globally.

### Warp terminal integration

- **"Open in Warp"** (`POST /api/focus-terminal`) — Warp has no AppleScript dictionary (`.sdef`) and its tabs are GPU-rendered (invisible to the Accessibility tree), so individual tabs can't be focused. Warp **windows** are accessible though, and a window's title is its active tab's title — so the server raises (`AXRaise` via System Events) the first Warp window whose title contains the basename of the session's `cwd` (case-insensitive) and returns `found: true`. If no window matches (e.g. the session lives in a background tab of a shared window) or Accessibility permission is missing, it falls back to `open -a Warp` with `found: false`. Since dashboard-launched agents each get their own window titled after the project, those always match.
- **"New agent"** (`POST /api/new-agent`) — writes a Warp [Launch Configuration](https://docs.warp.dev/features/session-management/launch-configurations) YAML file to `~/.warp/launch_configurations/` (created if missing) with a `cd <dir> && claude <prompt>` command, then opens `warp://launch/<file>.yaml`, which makes Warp start (if not running) and open a **new window** in that directory running `claude`. Configs older than 1 hour are cleaned up on every launch. No Automation/osascript permission is required.

Trade-off: "New agent" always opens a new window (Warp launch configs don't support attaching to an existing window), and "Open in Warp" focuses at window granularity — a session in a background tab of a shared window can't be targeted (Warp exposes no tab-level API; verified against the URI scheme docs and the app's Accessibility tree).

### Plan usage tracking

Shows your Claude.ai plan utilization (Pro/Team) by calling the usage API. Displays:
- 5-hour rolling window usage
- 7-day rolling window usage
- Reset times for each window

The data is cached for 1 minute to avoid excessive requests.

### Security

- The server only listens on `localhost` (`127.0.0.1`)
- Session content is sanitized before being sent to the browser (secrets, tokens, auth URLs are redacted)
- Full session IDs are never exposed — only slugs
- Home directory paths are replaced with `~`
- `.env` is gitignored and never served

## Project structure

```
agent-dashboard/
├── server.js        # Node.js server: session parsing, WebSocket, API endpoints
├── index.html       # Single-page app: pixel canvas + side panel (all-in-one)
├── package.json
├── .env.example     # Template for environment variables
└── .gitignore
```

## API endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Serves the dashboard |
| `/api/sessions` | GET | Returns all recent agent sessions as JSON |
| `/api/usage` | GET | Token usage stats from local JSONL files (24h) |
| `/api/plan-usage` | GET | Claude.ai plan utilization (requires cookie) |
| `/api/new-agent` | POST | Launch a new `claude` session in a Warp window (Launch Configuration) |
| `/api/focus-terminal` | POST | Raise the Warp window matching the session's `cwd` basename (fallback: activate Warp) |
| `/api/update-cookie` | POST | Update the claude.ai cookie in `.env` |

## Acknowledgments

Inspired by [pixel-agents](https://github.com/pablodelucca/pixel-agents) — the idea of visualizing Claude Code sessions as pixel-art characters and the heuristic of using timeouts to detect tool-approval states came from that project.

## License

MIT
