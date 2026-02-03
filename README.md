# DotClaw

A personal OpenRouter-based assistant accessible via Telegram. Runs an OpenRouter agent runtime in isolated Docker containers with persistent memory, scheduled tasks, and web access.

Forked from [NanoClaw](https://github.com/gavrielc/nanoclaw).

## Features

- **Telegram Integration** - Chat with your assistant from your phone via Telegram bot
- **Container Isolation** - Each conversation runs in a Docker container with only explicitly mounted directories accessible
- **Long-Term Memory v2** - Durable memory store with user profiles, recall, and memory controls
- **Scheduled Tasks** - Set up recurring or one-time tasks with cron expressions, intervals, or timestamps
- **Web Access** - Search the web (Brave) and fetch content from URLs
- **Tool Policy & Audit Logs** - Per-group/user tool allowlists, limits, and audit trails
- **Plugin Tools** - Drop-in HTTP/Bash plugin manifests for custom tools
- **Autotune & Behavior Config** - Continuous improvement loop with prompt canaries and behavior tuning
- **Metrics Endpoint** - Prometheus-compatible metrics for production monitoring
- **Daemon Mode** - Optional persistent containers for lower latency
- **Multi-Group Support** - Register multiple Telegram chats with isolated contexts

## Requirements

- macOS or Linux
- Node.js 20+
- [Docker](https://docker.com/products/docker-desktop)
- OpenRouter API key
- Brave Search API key (for WebSearch tool)
- Telegram bot token (create via [@BotFather](https://t.me/botfather))

## Installation

```bash
git clone https://github.com/yourusername/dotclaw.git
cd dotclaw
npm install
```

Recommended (guided setup):
```bash
npm run bootstrap
```

Manual setup:

### Configuration

1. Create a `.env` file with your credentials:

```bash
# Telegram bot token from @BotFather
TELEGRAM_BOT_TOKEN=your_bot_token_here

# OpenRouter authentication
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=moonshotai/kimi-k2.5
# Optional attribution headers (recommended by OpenRouter)
OPENROUTER_SITE_URL=https://your-domain.example
OPENROUTER_SITE_NAME=DotClaw

# Brave Search API (for WebSearch tool)
BRAVE_SEARCH_API_KEY=your_brave_search_api_key
```

Optional memory tuning (defaults are balanced):
```bash
DOTCLAW_MAX_CONTEXT_TOKENS=200000
DOTCLAW_RECENT_CONTEXT_TOKENS=80000
DOTCLAW_MAX_OUTPUT_TOKENS=4096
DOTCLAW_SUMMARY_UPDATE_EVERY_MESSAGES=12
DOTCLAW_SUMMARY_MAX_OUTPUT_TOKENS=1200
DOTCLAW_SUMMARY_MODEL=moonshotai/kimi-k2.5
```

Long-term memory v2:
```bash
DOTCLAW_MEMORY_RECALL_MAX_RESULTS=8
DOTCLAW_MEMORY_RECALL_MAX_TOKENS=1200
DOTCLAW_MEMORY_EXTRACTION_ENABLED=true
DOTCLAW_MEMORY_EXTRACTION_MESSAGES=8
DOTCLAW_MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS=900
DOTCLAW_MEMORY_MODEL=moonshotai/kimi-k2.5
DOTCLAW_MEMORY_ARCHIVE_SYNC=true
DOTCLAW_MEMORY_EXTRACT_SCHEDULED=false
```

Optional safety/tool controls:
```bash
DOTCLAW_ENABLE_BASH=true
DOTCLAW_ENABLE_WEBSEARCH=true
DOTCLAW_ENABLE_WEBFETCH=true
DOTCLAW_MAX_TOOL_STEPS=12
DOTCLAW_WEBFETCH_ALLOWLIST=example.com,developer.mozilla.org
DOTCLAW_WEBFETCH_BLOCKLIST=localhost,127.0.0.1
```

Tool policy & plugins:
```bash
# Optional plugin search paths (comma-separated)
DOTCLAW_PLUGIN_DIRS=/workspace/group/plugins,/workspace/global/plugins

# IPC tuning for memory requests
DOTCLAW_IPC_REQUEST_TIMEOUT_MS=6000
DOTCLAW_IPC_REQUEST_POLL_MS=150
```

Optional Docker hardening:
```bash
CONTAINER_PIDS_LIMIT=256
CONTAINER_MEMORY=2g
CONTAINER_CPUS=2
CONTAINER_READONLY_ROOT=true
CONTAINER_TMPFS_SIZE=64m
CONTAINER_RUN_UID=1000
CONTAINER_RUN_GID=1000
```

Performance + observability:
```bash
DOTCLAW_CONTAINER_MODE=ephemeral   # or "daemon"
DOTCLAW_CONTAINER_DAEMON_POLL_MS=200
DOTCLAW_METRICS_PORT=3001
```

Autotune:
```bash
DOTCLAW_AUTOTUNE_DAYS=7
DOTCLAW_AUTOTUNE_PROMPTS=false
DOTCLAW_AUTOTUNE_EVAL_MODEL=  # optional evaluator model id
DOTCLAW_AUTOTUNE_EVAL_SAMPLES=6
```

2. Build the Docker container:

```bash
./container/build.sh
```

3. Register your Telegram chat in `data/registered_groups.json`:

```json
{
  "YOUR_CHAT_ID": {
    "name": "main",
    "folder": "main",
    "added_at": "2024-01-01T00:00:00.000Z"
  }
}
```

### First Group Setup (Telegram)

To find your chat ID:

1. Message your bot (or create a group and add the bot).
2. Use @userinfobot or @get_id_bot in Telegram to get the chat ID.
3. Add the entry to `data/registered_groups.json` and restart the app.

Example entry:

```json
{
  "-123456789": {
    "name": "family-chat",
    "folder": "family-chat",
    "added_at": "2024-01-01T00:00:00.000Z"
  }
}
```

4. Build and run:

```bash
npm run build
npm start
```

### Quick Configure Script

You can run an interactive setup that updates `.env` and `data/model.json`:
```bash
npm run configure
```

### Bootstrap (Recommended)

For a one-shot setup (init + configure + register main chat):
```bash
npm run bootstrap
```

The bootstrap script can also run a container self-check to validate permissions and OpenRouter connectivity before you start the app.

### VPS/Linux Permissions

By default the container runs with your host UID/GID to avoid permission issues on Linux.  
If you need to override, set:
```bash
CONTAINER_RUN_UID=1000
CONTAINER_RUN_GID=1000
```

If you see permission errors, ensure the host user owns `data/` and `groups/`:
```bash
sudo chown -R $USER data/ groups/
```

For a full Ubuntu VPS + systemd guide, see `docs/UBUNTU.md`.

### Container Mode (Performance)

By default DotClaw spawns a fresh container per request (`ephemeral`).  
For lower latency, enable daemon mode:
```bash
DOTCLAW_CONTAINER_MODE=daemon
```

### Model Switching

The active model is stored in `data/model.json` and can be updated without editing `.env`.

You can set global, per-group, and per-user overrides:
```json
{
  "model": "moonshotai/kimi-k2.5",
  "allowlist": ["moonshotai/kimi-k2.5", "openai/gpt-4.1-mini"],
  "overrides": {
    "moonshotai/kimi-k2.5": { "context_window": 200000, "max_output_tokens": 4096 },
    "openai/gpt-4.1-mini": { "context_window": 128000, "max_output_tokens": 4096 }
  },
  "per_group": {
    "main": { "model": "openai/gpt-4.1-mini" }
  },
  "per_user": {
    "123456789": { "model": "moonshotai/kimi-k2.5" }
  },
  "updated_at": "2026-02-03T00:00:00.000Z"
}
```

From the main group, you can also change models via tool calls:
```
set model to moonshotai/kimi-k2.5
set model to openai/gpt-4.1-mini for group main
set model to moonshotai/kimi-k2.5 for user 123456789
```

### Prompt Packs (Autotune)

DotClaw can load optimized prompt packs (JSON) generated by Autotune.

Shared prompt packs (default):
- `~/.config/dotclaw/prompts/task-extraction.json`
- `~/.config/dotclaw/prompts/response-quality.json`
- `~/.config/dotclaw/prompts/tool-calling.json`
- `~/.config/dotclaw/prompts/memory-policy.json`

Canary packs (managed by Autotune):
- `~/.config/dotclaw/prompts/task-extraction.canary.json`
- `~/.config/dotclaw/prompts/response-quality.canary.json`
- `~/.config/dotclaw/prompts/tool-calling.canary.json`
- `~/.config/dotclaw/prompts/memory-policy.canary.json`

Override per group:
- `groups/{group}/prompts/task-extraction.json`
- `groups/{group}/prompts/response-quality.json`
- `groups/{group}/prompts/tool-calling.json`
- `groups/{group}/prompts/memory-policy.json`

Optional env tuning:
```bash
DOTCLAW_PROMPT_PACKS_ENABLED=true
DOTCLAW_PROMPT_PACKS_MAX_CHARS=6000
DOTCLAW_PROMPT_PACKS_MAX_DEMOS=4
DOTCLAW_PROMPT_PACKS_DIR=~/.config/dotclaw/prompts
DOTCLAW_PROMPT_PACKS_CANARY_RATE=0.1
```

### Tracing (Autotune)

DotClaw writes JSONL traces that Autotune consumes.

Defaults:
- `~/.config/dotclaw/traces`

Optional env tuning:
```bash
DOTCLAW_TRACE_DIR=~/.config/dotclaw/traces
DOTCLAW_TRACE_SAMPLE_RATE=1
```

### Tool Policy

Tool permissions and limits live in `data/tool-policy.json`:
```json
{
  "default": {
    "allow": ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "Bash"],
    "deny": [],
    "max_per_run": { "Bash": 4, "WebSearch": 5, "WebFetch": 6 },
    "default_max_per_run": 12
  },
  "groups": {
    "main": { "allow": ["Bash", "WebSearch", "WebFetch"] }
  },
  "users": {
    "123456789": { "deny": ["Bash"] }
  }
}
```

### Plugin Tools

Drop JSON plugin manifests into `groups/<group>/plugins/` or `groups/global/plugins/`.
Example HTTP plugin (`groups/main/plugins/github-search.json`):
```json
{
  "name": "github_search",
  "description": "Search GitHub repositories",
  "type": "http",
  "method": "GET",
  "url": "https://api.github.com/search/repositories",
  "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" },
  "query_params": { "q": "{{query}}", "per_page": "5" },
  "input": { "query": "string" },
  "required": ["query"]
}
```

The tool will be exposed as `plugin__github_search` (and must be allowed by tool policy).

### Metrics

Prometheus metrics are served on `http://localhost:3001/metrics` (configurable via `DOTCLAW_METRICS_PORT`).

### Autotune

Run the continuous optimization loop:
```bash
npm run autotune
```
This uses the published `@dotsetlabs/autotune` package and runs the full pipeline (ingest → eval → optimize → deploy → behavior tuning).
If you want to develop Autotune locally, set `AUTOTUNE_DIR` to your checkout before running `./scripts/install.sh`.
Optional evaluator model:
```bash
DOTCLAW_AUTOTUNE_EVAL_MODEL=openai/gpt-4.1-mini
```
Autotune writes `data/behavior.json` and optional canary prompt packs in `~/.config/dotclaw/prompts`.
Example:
```
set model to moonshotai/kimi-k2.5
```

If you want to restrict which models can be used, add an allowlist in `data/model.json`:
```json
{
  "model": "moonshotai/kimi-k2.5",
  "allowlist": ["moonshotai/kimi-k2.5", "openai/gpt-4.1-mini"],
  "updated_at": "2026-02-02T00:00:00.000Z"
}
```

### Running as a Service (macOS)

```bash
# Copy and configure the launchd plist
cp launchd/com.dotclaw.plist ~/Library/LaunchAgents/

# Edit the plist to set correct paths (NODE_PATH, PROJECT_ROOT, HOME)

# Load the service
launchctl load ~/Library/LaunchAgents/com.dotclaw.plist
```

## Usage

Message your bot directly in DMs. In group chats, mention the bot or reply to it:

### Quick Install (Linux/systemd)

From the DotClaw repo:
```bash
./scripts/install.sh
```

This script:
- Sets up `.env` defaults
- Builds DotClaw and the container image
- Creates systemd services with the correct Node path
- Enables Autotune timer if `AUTOTUNE_DIR` points to a local Autotune checkout (or node_modules path)

```
@dotclaw_bot what's the weather in New York?
@dotclaw_bot remind me every Monday at 9am to check my emails
@dotclaw_bot search for recent news about AI
@dotclaw_bot remember that my favorite color is blue
@dotclaw_bot what do you remember about me?
```

In your main channel, you can manage groups and tasks:

```
@dotclaw_bot list all scheduled tasks
@dotclaw_bot pause task [id]
@dotclaw_bot add a new group for "Family Chat" with chat ID -123456789
```

## Project Structure

```
dotclaw/
├── src/
│   ├── index.ts           # Main app: Telegram, routing, IPC
│   ├── config.ts          # Configuration constants
│   ├── container-runner.ts # Spawns Docker containers
│   ├── task-scheduler.ts  # Runs scheduled tasks
│   └── db.ts              # SQLite operations
├── container/
│   ├── Dockerfile         # Agent container image
│   ├── build.sh           # Build script
│   └── agent-runner/      # Code that runs inside containers
├── groups/
│   ├── global/CLAUDE.md   # Shared memory (read by all groups)
│   └── main/CLAUDE.md     # Main channel memory
├── data/
│   ├── registered_groups.json
│   ├── sessions.json
│   ├── behavior.json      # Autotune behavior config
│   └── tool-policy.json   # Tool allowlist/limits
└── store/
    ├── messages.db        # SQLite database
    └── memory.db          # Long-term memory store
```

## Architecture

```
Telegram (Telegraf) → SQLite → Event Handler → Docker Container (OpenRouter Agent Runtime) → Response
```

- Single Node.js process handles Telegram connection, message routing, and scheduling
- Each agent invocation spawns an isolated Docker container
- Containers communicate back via filesystem-based IPC
- Memory persists in `CLAUDE.md` files per group

## Development

```bash
npm run dev      # Run with hot reload
npm run build    # Compile TypeScript
npm run typecheck # Type check without emitting
```

## License

MIT
