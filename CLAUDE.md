# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

DotClaw is a personal OpenRouter-based assistant for Telegram and Discord. A single Node.js host process connects to messaging providers, routes messages through a pipeline, and executes agent requests inside isolated Docker containers. Each group gets its own filesystem, memory, and session state.

## Development Commands

```bash
npm run build              # Compile host TypeScript (src/ → dist/)
npm run dev                # Run host with hot reload (tsx, no container rebuild)
npm run dev:up             # Full dev cycle: rebuild container + kill stale daemons + start dev
npm run dev:down           # Remove all running dotclaw agent containers
npm run lint               # ESLint (flat config, zero warnings allowed)
npm run typecheck          # Type-check without emitting
npm test                   # Build + run all tests (host + container agent-runner)
./container/build.sh       # Rebuild Docker image (run after container code changes)
```

Run a single host test:
```bash
npm run build && node --test test/memory-store.test.js
```

Run container agent-runner tests only:
```bash
npm run test:agent-runner
```

Other useful scripts:
```bash
npm run build:agent        # Build container agent-runner TypeScript only (no Docker rebuild)
npm run build:container    # Build agent-runner + rebuild Docker image
npm run build:all          # Build host + container
npm run doctor             # Diagnostic health check
npm run init               # Initialize new DotClaw installation
npm run bootstrap          # Bootstrap first-time setup
npm run configure          # Configure existing installation
npm run autotune           # Run autotune optimization
npm run canary             # Run canary test suite
npm run canary:live        # Run live canary tests
npm run release:slo        # Release SLO gate check
npm run bench:harness      # Benchmark harness
```

Service management (macOS):
```bash
launchctl load ~/Library/LaunchAgents/com.dotclaw.plist
launchctl unload ~/Library/LaunchAgents/com.dotclaw.plist
```

Run commands directly — don't tell the user to run them.

## Build System: What to Rebuild When

| Changed | Command | Why |
|---------|---------|-----|
| `src/` (host code) | `npm run build` | Recompiles to `dist/` |
| `container/agent-runner/src/` | `./container/build.sh` | Agent code is baked into Docker image |
| `container/Dockerfile` | `./container/build.sh` | Rebuilds image with new system deps |
| Both host + container | `npm run build:all` then `./container/build.sh` | Full rebuild |

**Critical**: Daemon containers cache old code. After rebuilding the image, run `npm run dev:down` to remove stale containers. The `dev:up` script does this automatically.

## Architecture

### Two-Process Model

```
Host process (Node.js)              Docker container (agent-runner)
─────────────────────               ──────────────────────────────
Providers (Telegram/Discord)        OpenRouter SDK calls
Message pipeline (SQLite queue)     Tool execution (bash, browser, MCP)
Request router                      Session management
Container runner                    Memory extraction
IPC dispatcher          ←──IPC──→   Skill loading
Telemetry + traces                  Streaming delivery
Lane-aware semaphore                Tool loop policy + circuit breakers
Failover policy + cooldowns         Context overflow recovery
Memory recall + embeddings          Prompt packs
```

**IPC modes:**
- **Daemon** (default): Long-lived container per group. Host writes request files to `~/.dotclaw/data/ipc/<group>/agent_requests/`, container polls and writes responses to `agent_responses/`. Heartbeat worker thread writes health every 1s.
- **Ephemeral**: Container spawns per request, reads JSON from stdin, writes to stdout between sentinel markers (`---DOTCLAW_OUTPUT_START---` / `---DOTCLAW_OUTPUT_END---`).

### Message Flow

1. Provider receives message → downloads attachments to `groups/<group>/inbox/`
2. `enqueueMessage()` → SQLite `message_queue` (status: pending)
3. `drainQueue()` → `claimBatchForChat()` groups rapid messages within `BATCH_WINDOW_MS` (2s)
4. `routeRequest()` applies flat routing config (model, token limits, max tool steps)
5. `LaneAwareSemaphore.acquire()` — interactive (priority 3) > scheduled (2) > maintenance (1), with starvation prevention
6. `executeAgentRun()` builds context (memory recall, tool policy) → `runContainerAgent()`
7. Container agent-runner calls OpenRouter with streaming, iterates tool calls up to `maxToolSteps` (default 200)
8. Streaming response delivered via edit-in-place → sent back through provider → telemetry recorded

Transient failures re-queue with exponential backoff (base 3s, max 60s, up to 4 retries).

### Model Resolution Cascade

Resolved in `model-registry.ts`, lowest-to-highest priority:
1. `routing.model` from runtime.json (base default)
2. `model.json` global override
3. Per-group override (`per_group[groupFolder].model`)
4. Per-user override (`per_user[userId].model`)
5. Routing rules — keyword matching (`{ task_type, model, keywords[], priority }`) — user rules checked before group rules
6. Allowlist enforcement at each level

### Host-Level Failover

`failover-policy.ts` classifies errors into categories (`auth`, `rate_limit`, `timeout`, `overloaded`, `transport`, `invalid_response`, `context_overflow`, `aborted`, `non_retryable`) and applies model cooldowns. Timeout cooldowns escalate exponentially (15m → 6hr, 3x multiplier). Cooldown state persists to `failover-cooldowns.json`.

### Memory System

- `memory-store.ts` — SQLite-backed long-term memory with FTS5 + embedding vectors (schema v4)
- `memory-embeddings.ts` — Embedding generation via Transformers.js (`local-embeddings.ts`)
- `memory-recall.ts` — Hybrid recall (FTS + vector similarity), `minScore` threshold filtering
- `recall-policy.ts` — Intent detection (explicit memory keywords), query optimization, low-signal turn filtering
- `personalization.ts` — Extracts user preferences from memory (response_style, biases) into behavior config

### Provider System

Chat IDs are prefixed: `telegram:123456`, `discord:789012`. The provider registry (`src/providers/registry.ts`) routes by prefix. Both providers implement a common interface with send/edit/delete operations and media support.

### Container Mounts

- Main group: `/workspace/project` (readonly, package root) + `/workspace/group` (RW) + `/workspace/global` (readonly)
- Other groups: `/workspace/group` (RW) + `/workspace/global` (readonly) — no project access
- Shared (readonly): `/workspace/prompts`, `/workspace/config`, `/workspace/env-dir`
- Per-group: `/workspace/session` (sessions), `/workspace/ipc` (IPC namespace)

### Container Environment

The Docker image includes: Chromium (headless browser), Python 3 with data science packages (pandas, numpy, matplotlib, etc.), GitHub CLI, ripgrep, ffmpeg, sqlite3, graphviz. Runs as non-root `node` user with passwordless sudo.

## Key Files

### Host (`src/`)

| File | Purpose |
|------|---------|
| `index.ts` | Main app: provider setup, admin commands, wake recovery |
| `cli.ts` | CLI entry point (`dotclaw` binary), multi-instance support |
| `message-pipeline.ts` | SQLite message queue, batching, agent invocation |
| `agent-execution.ts` | Context building, container invocation, telemetry |
| `agent-semaphore.ts` | Lane-aware concurrency (interactive/scheduled/maintenance priority) |
| `container-runner.ts` | Docker container lifecycle, mounts, daemon management |
| `container-protocol.ts` | `ContainerInput`/`ContainerOutput` interfaces (shared with container) |
| `ipc-dispatcher.ts` | File-watcher for container→host async IPC messages |
| `model-registry.ts` | Model config, resolution cascade, routing rules, allowlist |
| `failover-policy.ts` | Error classification, model cooldowns, cooldown persistence |
| `recall-policy.ts` | Memory recall optimization (intent detection, query optimization) |
| `memory-store.ts` | Long-term memory with FTS5 + embeddings |
| `memory-recall.ts` | Hybrid memory recall (FTS + vector similarity) |
| `runtime-config.ts` | Runtime config type definition and loader (with validation) |
| `streaming.ts` | Streaming delivery for real-time message updates |
| `request-router.ts` | Request routing configuration |
| `task-scheduler.ts` | Cron and one-off scheduled tasks |
| `db.ts` | SQLite schema and operations |
| `webhook.ts` | Optional HTTP webhook endpoint for programmatic agent invocation |
| `metrics.ts` | Prometheus metrics registry (port 3001) |
| `dashboard.ts` | HTTP health dashboard (port 3002) |
| `trace-writer.ts` | JSONL trace writing for telemetry |
| `transcription.ts` | Voice transcription (Whisper) |
| `personalization.ts` | User preference extraction from memory |
| `turn-hygiene.ts` | Turn filtering and validation |
| `mount-security.ts` | Container mount security validation |

### Container (`container/agent-runner/src/`)

| File | Purpose |
|------|---------|
| `index.ts` | Agent entry point (OpenRouter calls, tool loop, model fallbacks) |
| `daemon.ts` | Daemon mode: request polling, worker threads, heartbeat |
| `system-prompt.ts` | Structured system prompt builder (section-based, full/minimal modes) |
| `tools.ts` | Tool definitions and execution |
| `memory.ts` | Conversation compaction, multi-part summarization, token estimation |
| `tool-loop-policy.ts` | Tool execution loop policy (circuit breakers, completion guard) |
| `context-overflow-recovery.ts` | Context overflow recovery |
| `skill-loader.ts` | Skill discovery and catalog building |
| `prompt-packs.ts` | Prompt pack loading |
| `agent-config.ts` | Container-side config (reads mounted runtime.json) |
| `heartbeat-worker.ts` | Heartbeat worker thread (health every 1s) |
| `browser.ts` | Browser automation wrapper (Chromium) |
| `ipc.ts` | Container-side IPC (file-based async messages to host) |
| `mcp-client.ts` / `mcp-registry.ts` | MCP server connections |

## Configuration

All runtime data lives in `~/.dotclaw/` (override with `DOTCLAW_HOME`).

| File | Purpose |
|------|---------|
| `.env` | Secrets (API keys, bot tokens) |
| `config/runtime.json` | Host runtime overrides (timeouts, concurrency, routing) |
| `config/model.json` | Active model, allowlist, per-user/per-group overrides + routing rules |
| `config/behavior.json` | Autotune optimization outputs |
| `config/tool-policy.json` | Tool allow/deny lists |
| `config/tool-budgets.json` | Daily tool usage limits |
| `config/mount-allowlist.json` | Allowed mount paths for container security |
| `data/model-capabilities.json` | Cached model capabilities (24hr TTL) |
| `data/failover-cooldowns.json` | Persisted model cooldown state |
| `registered-groups.json` | Group registrations |

The container reads `runtime.json` via readonly mount at `/workspace/config/runtime.json`. Container-side config is in `agent-config.ts` which reads the `agent.*` fields.

## IPC Actions (Container → Host)

Key actions dispatched via `ipc-dispatcher.ts`: `set_model` (supports `action: 'set' | 'set_routing_rules' | 'clear_routing_rules'`), `memory_upsert`, `memory_forget`, `memory_search`, `memory_list`, `memory_stats`, `schedule_task`, `pause_task`, `resume_task`, `cancel_task`, `run_task`, `edit_message`, `delete_message`, `set_tool_policy`, `set_behavior`, `set_mcp_config`, `spawn_subagent`, `subagent_status`, `subagent_result`, `register_group`, `remove_group`, `list_groups`, `get_config`.

## Code Conventions

- **ESM only**: `"type": "module"` — use `import`/`export`, file extensions required in imports (e.g., `'./bar.js'`)
- **TypeScript**: Strict mode, ES2022 target, NodeNext module resolution. `noUnusedLocals` and `noUnusedParameters` are enforced.
- **Tests**: Node.js built-in test runner (`node:test` + `node:assert/strict`). Host tests import from `dist/` (build first). Test helpers: `withTempHome()`, `importFresh()` in `test/test-helpers.js`. 50 test files covering host; container tests run via `npm run test:agent-runner`.
- **Linting**: ESLint flat config with typescript-eslint recommended. Zero warnings threshold.
- **Node**: Requires Node.js >=20.

## Important Patterns

### Streaming Delivery
Real-time streaming uses IPC-based file watching: container writes chunks to `~/.dotclaw/data/ipc/<group>/stream/<trace_id>/`, host watches via `watchStreamChunks()` and delivers via provider's edit-in-place. Enabled by `runtime.host.streaming.enabled`.

### Turn Hygiene
`turn-hygiene.ts` filters messages before agent processing: removes malformed messages, drops duplicates (same message_id), discards stale partials, and normalizes tool envelope formats. Applied in message pipeline before prompt construction.

### Interrupt-on-New-Message
When `runtime.host.messageQueue.interruptOnNewMessage` is true (default), new messages abort active agent runs via `AbortController`. User can type "cancel" or "stop" to manually abort.

### Security: Group Folder Validation
Always validate group folders with `isSafeGroupFolder(folder, GROUPS_DIR)` before filesystem operations. Prevents path traversal and ensures folder is within allowed groups directory.

### Wake Recovery
System detects sleep/wake via `wake-detector.ts`, suppresses daemon health checks for 60s, reconnects providers, resets stalled messages, and re-drains queues.

### Hook System
`hooks.ts` emits lifecycle events: `message:received`, `message:processing`, `message:responded`, `agent:started`, `agent:completed`, `agent:failed`, `memory:upserted`, `task:*`.

## Observability

- **Prometheus metrics**: Port 3001 (`/metrics`) — messages, errors, tool calls, tokens, cost, latency histograms
- **Health dashboard**: Port 3002 — uptime, memory, DB status, container status, provider status, queue depth
- **Traces**: JSONL files in `~/.dotclaw/traces/` — tool calls with timing, memory operations, failover attempts, cost

## Skills

Skills are markdown files discovered at runtime from `/workspace/group/skills/` and `/workspace/global/skills/`. Two forms: `skills/<name>/SKILL.md` (directory with optional `plugins/`) or `skills/<name>.md` (single file). YAML frontmatter defines name, description, and plugin references.

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Discord Development Guidance

When working with Discord-related features in this codebase:

1. **NotebookLM Integration**: The `.claude/skills/notebooklm/` skill provides access to a Discord.js Expert Guide notebook with modern v14.25.1 documentation. This is the default notebook and contains:
   - Discord.js v14.25.1 API patterns and methods
   - Events, threads, polls, reactions, buttons, modals
   - TypeScript implementation examples
   - Best practices for Discord bot development

   Use the NotebookLM skill whenever you need Discord.js-specific guidance.

2. **Official Documentation**: When NotebookLM isn't available, refer to:
   - Discord.js docs: https://discord.js.org
   - Discord API docs: https://discord.com/developers/docs/intro

3. **Consult Before Sensitive Decisions**: When making decisions that could:
   - Break existing Discord integrations
   - Change channel/thread/poll management
   - Modify permission requirements
   - Affect data persistence or state management

   Always ask for confirmation first or explain the approach and wait for user approval.

4. **Key Discord Patterns in This Codebase**:
   - Forum threads for task organization (planned in daily planning workflow)
   - Native polls for checklists (multi-select, max 10 options)
   - Reactions for completion tracking (✅ override)
   - Channel type detection (text, forum, voice, announcement)
   - Message threading support

## Daily Planning & Briefing Workflow (Planned)

A comprehensive productivity workflow is planned for this codebase. See:
- `.planning/BRIEF.md` - Project vision and requirements
- `.planning/ROADMAP.md` - Phase breakdown (3 milestones, 11 phases)
- `.planning/phases/` - Detailed implementation plans for each phase

**Planned Features** (marked with `[[double brackets]]` in `features.md`):
- Daily morning briefings
- Collaborative daily planning with accountability
- Forum-based TO-DO system with poll checklists
- Nightly recap conversations
- Structured journal entries

Each phase is independently executable and scoped to 2-3 tasks for quality.
