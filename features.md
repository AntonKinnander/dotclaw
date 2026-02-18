# DotClaw - Comprehensive Feature Documentation

> **Table of Contents / Architecture Chart Hybrid**
> Focus: Discord User Capabilities & Use Cases
> Generated: 2026-02-18

---

## Overview

DotClaw is a personal OpenRouter-based AI assistant that integrates with Discord (and Telegram). Each request runs inside an isolated Docker container with long-term memory per chat group, scheduling, tool governance, and observability.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              DOTCLAW ARCHITECTURE                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Discord Provider ──► Message Queue ──► Agent Execution ──► Container       │
│       │                    │                   │                │           │
│       ▼                    ▼                   ▼                ▼           │
│  • DM/Channel          • SQLite            • Model          • Tools         │
│  • Reactions           • Batching          • Memory         • IPC           │
│  • Buttons             • Streaming         • Context        • Skills        │
│  • Attachments         • Retry             • Failover                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. DISCORD PROVIDER - Primary User Interface

> **Location:** `src/providers/discord/`
> **Access:** Automatic when `DISCORD_BOT_TOKEN` is set in `.env`

```
Discord Provider
├── Supported Channel Types
│   ├── DMs (Direct Messages) - Bot always responds
│   ├── Guild Text Channels
│   ├── Forum Channels (with thread filtering)
│   ├── Guild Voice Channels
│   ├── Announcement Channels
│   ├── Public Threads
│   ├── Private Threads
│   └── Announcement Threads
│
├── Supported Message Types
│   ├── Text Messages (up to 2000 chars, auto-chunked)
│   ├── File Attachments (up to 25MB)
│   ├── Voice Messages (sent as file attachments)
│   ├── Stickers (downloaded and processed)
│   ├── Native Polls (discord.js v14.15+)
│   ├── Inline Buttons with callback handling
│   └── Reactions (👍/👎 for feedback collection)
│
├── Messaging Features
│   ├── Message Replies (bot can reply to specific messages)
│   ├── Message Editing (for streaming delivery)
│   ├── Message Deletion
│   ├── Typing Indicators
│   ├── Reaction-based User Feedback (👍/👎)
│   ├── Button Interaction Handling (5-minute TTL)
│   ├── Channel Context Awareness (name, description, type)
│   └── Forum Thread Detection (skips initial posts, processes replies)
│
└── Configuration Options
    ├── host.discord.enabled - Enable/disable provider
    ├── host.discord.sendRetries - Retry attempts (default: 3)
    ├── host.discord.sendRetryDelayMs - Base delay (default: 1000ms)
    ├── DISCORD_BOT_TOKEN - Bot authentication
    ├── DISCORD_OWNER_ID - Owner bypass mode
    └── DISCORD_EXCLUDED_CHANNELS - Comma-separated channel IDs to ignore
```

### Discord Channel Registration

```json
{
  "discord:CHANNEL_ID": {
    "name": "channel-name",
    "folder": "folder-name",
    "added_at": "2026-01-01T00:00:00.000Z",
    "discord": {
      "channelId": "1234567890",
      "channelName": "general",
      "channelType": "text",
      "description": "General discussion",
      "defaultSkill": "skill-name"
    }
  }
}
```

---

## 2. MESSAGE PROCESSING - How Discord Messages Become Agent Responses

> **Location:** `src/message-pipeline.ts`
> **Access:** Automatic flow when messages are received

```
Message Pipeline
├── Message Queue Management (SQLite)
│   ├── Status Tracking (pending, processing, completed, failed)
│   ├── Batch Processing - Groups rapid messages within 2s window
│   ├── Configurable Batch Size (max 50 messages)
│   ├── Automatic Retry with Exponential Backoff
│   │   ├── maxRetries: 4
│   │   ├── retryBaseMs: 3000ms
│   │   └── retryMaxMs: 60000ms
│   └── Attachment Handling (downloads before agent run)
│
├── Message Processing Features
│   ├── Turn Hygiene - Removes malformed/duplicate/stale messages
│   ├── Prompt Budget Enforcement - 24000 char default limit
│   ├── Message Prioritization - Recent messages prioritized
│   ├── Voice Transcription - Automatic transcription of voice messages
│   ├── Thread Support - Respects thread IDs for context
│   └── Channel Context Injection - Name/description/type in system prompt
│
├── Interrupt-on-New-Message
│   ├── Enabled by default - New messages abort active agent runs
│   ├── Configurable via host.messageQueue.interruptOnNewMessage
│   ├── Cancel Phrases: "cancel", "stop", "abort"
│   └── AbortController Integration - Graceful interruption
│
├── Streaming Delivery (Real-time Response)
│   ├── IPC-based File Watching for Chunk Delivery
│   ├── Edit-in-Place - Single message edited progressively
│   ├── Rate-limited Edits - Prevents API limit hits
│   ├── chunkFlushIntervalMs: 50ms
│   ├── editIntervalMs: 1000ms
│   └── maxEditLength: 2000
│
└── Response Features
    ├── Reply-to Targeting - [[reply_to:...]] tags for specific messages
    ├── TTS for Voice - Text-to-speech when user sent voice message
    ├── Truncation Handling - User notification when response too large
    └── Fallback Messages - Graceful handling of empty/failed responses
```

---

## 3. WHEN BOT RESPONDS - Triggers and Processing Conditions

> **Location:** `docs/configuration/triggers.md`

```
Bot Processing Conditions
└── Bot Processes Message If ANY Condition Is True:
    ├── Private (DM) - Always processes
    ├── Mentioned - <@bot_id> in Discord
    ├── Replied To - Reply to bot message
    └── Triggered - Matches group's trigger regex

Trigger Configuration Examples
├── ".*" - Respond to ALL messages in channel
├── "(help|bug|issue)" - Keyword matching
├── "^!" - Commands starting with !
└── "(build|deploy|incident)" - Ops-related triggers
```

---

## 4. AGENT EXECUTION - What Happens Inside the Container

> **Location:** `src/agent-execution.ts`
> **Access:** Automatic via message pipeline or scheduled tasks

```
Agent Execution
├── Container Execution
│   ├── Docker Isolation - Each run in isolated container
│   ├── Daemon Mode - Long-lived containers, warm start
│   ├── Ephemeral Mode - Per-request containers
│   ├── Mount Security - Validated mount paths with allowlist
│   ├── Session Management - Persistent conversation state per group
│   └── Timeout Handling - Configurable per-request timeouts
│
├── Model Management
│   ├── Model Resolution Cascade (priority order):
│   │   ├── 1. routing.model from runtime.json
│   │   ├── 2. model.json global override
│   │   ├── 3. Per-group override
│   │   ├── 4. Per-user override
│   │   ├── 5. Routing rules (keyword matching)
│   │   └── 6. Allowlist enforcement
│   ├── Model Fallbacks - Automatic fallback on failures
│   ├── Failover Policy - Cooldown periods for failed models
│   └── Reasoning Effort - 'off' | 'low' | 'medium' | 'high'
│
├── Context Management
│   ├── Memory Recall - Hybrid FTS + vector similarity search
│   ├── Tool Policy - Allow/deny lists, per-run limits
│   ├── Attachments - File references passed to container
│   ├── Channel Context - Discord channel metadata
│   ├── Available Groups - Multi-group awareness for main group
│   └── Session Persistence - Conversation history maintained
│
└── Tool Execution
    ├── Max Tool Steps - Configurable (default: 200)
    ├── Tool Budgeting - Daily limits per tool type
    ├── Tool Summary - LLM-based summarization for long outputs
    ├── Progress Notifications - Real-time tool execution updates
    └── Loop Policy - Circuit breakers, completion guards
```

---

## 5. MEMORY SYSTEM - Long-term Knowledge Storage

> **Location:** `src/memory-store.ts`, `src/memory-recall.ts`
> **Access:** Automatic via agent, manual via admin commands

```
Memory System
├── Storage (SQLite with FTS5 + Embedding Vectors)
│   ├── Memory Scopes:
│   │   ├── user - Per-user memories
│   │   ├── group - Shared group memories
│   │   └── global - Cross-group memories
│   ├── Memory Types:
│   │   ├── identity - User identity info
│   │   ├── preference - User preferences
│   │   ├── fact - Factual information
│   │   ├── relationship - Relationship data
│   │   ├── project - Project tracking
│   │   ├── task - Task-related memories
│   │   ├── note - General notes
│   │   └── archive - Archived content
│   ├── Features:
│   │   ├── Conflict Resolution (conflict_key for upserts)
│   │   ├── TTL Support (automatic expiration)
│   │   ├── Importance Scoring (0.0-1.0 for ranking)
│   │   ├── Confidence Scoring (0.0-1.0 for quality)
│   │   ├── Tag System (flexible filtering)
│   │   └── Access Tracking (usage statistics)
│   └── Embeddings
│       ├── Transformers.js - Local generation (no API calls)
│       ├── Model: Xenova/all-MiniLM-L6-v2
│       └── Background Worker - Async embedding updates
│
└── Recall (Hybrid FTS + Vector Similarity)
    ├── Configurable Thresholds (minScore filtering)
    ├── Recall Policy (intent detection, query optimization)
    ├── Max Results/Tokens (budget-aware retrieval)
    └── User Preferences (personalized strictness levels)
```

### Memory Commands (via `/dotclaw` or `/dc`)

```
Memory Commands
├── /dotclaw remember <fact> - Store fact in memory
├── /dotclaw memory <strict|balanced|loose> - Set memory strictness
└── IPC Tools (accessible to agent):
    ├── mcp__dotclaw__memory_upsert
    ├── mcp__dotclaw__memory_forget
    ├── mcp__dotclaw__memory_search
    ├── mcp__dotclaw__memory_list
    └── mcp__dotclaw__memory_stats
```

---

## 6. TOOLS - Agent Capabilities

> **Location:** `container/agent-runner/src/tools.ts`
> **Access:** Automatic via agent, configured via `tool-policy.json`

```
Available Tools
├── File Operations
│   ├── read - Read file contents with size limits
│   ├── write - Write files with atomic operations
│   ├── edit - Line-based file editing
│   └── glob - File pattern matching
│
├── Command Execution
│   ├── bash - Shell command execution with timeout/output limits
│   ├── process - Long-running process management
│   └── python - Python code execution
│
├── Web Tools
│   ├── websearch - Brave Search API integration
│   ├── webfetch - HTTP GET with security controls
│   └── analyze_image - Vision API integration
│
├── Discord Messaging (IPC Tools)
│   ├── mcp__dotclaw__send_message - Send messages to any Discord channel
│   ├── mcp__dotclaw__edit_message - Edit sent messages
│   ├── mcp__dotclaw__delete_message - Delete messages
│   ├── sendfile - Send file attachments
│   ├── sendphoto - Send images
│   ├── sendvoice - Send voice messages
│   ├── sendaudio - Send audio files
│   └── sendpoll - Create polls
│
├── Memory & Configuration (IPC Tools)
│   ├── mcp__dotclaw__memory_upsert - Store memory items
│   ├── mcp__dotclaw__memory_forget - Delete memory
│   ├── mcp__dotclaw__memory_search - Search memory
│   ├── mcp__dotclaw__set_model - Change model configuration
│   ├── mcp__dotclaw__set_tool_policy - Update tool policy
│   ├── mcp__dotclaw__set_behavior - Update behavior config
│   └── mcp__dotclaw__get_config - Read configuration
│
├── Task Management (IPC Tools)
│   ├── mcp__dotclaw__schedule_task - Create scheduled tasks
│   ├── mcp__dotclaw__pause_task - Pause tasks
│   ├── mcp__dotclaw__resume_task - Resume tasks
│   ├── mcp__dotclaw__cancel_task - Cancel tasks
│   └── mcp__dotclaw__run_task - Run task immediately
│
├── Group Management (IPC Tools)
│   ├── mcp__dotclaw__register_group - Register new groups
│   ├── mcp__dotclaw__remove_group - Unregister groups
│   └── mcp__dotclaw__list_groups - List groups
│
├── Subagent Operations (IPC Tools)
│   ├── mcp__dotclaw__spawn_subagent - Launch subagent tasks
│   ├── mcp__dotclaw__subagent_status - Check subagent status
│   └── mcp__dotclaw__subagent_result - Get subagent results
│
├── Utility
│   ├── list_processes - Show running processes
│   └── kill_process - Terminate processes
│
└── Plugin Tools
    ├── HTTP Plugins - REST API tool generation
    ├── Bash Plugins - Shell command wrappers
    └── Plugin Discovery from group/plugins/ and global/plugins/
```

---

## 7. TASK SCHEDULER - Automated Actions

> **Location:** `src/task-scheduler.ts`
> **Access:** Automatic cron-based, agent-triggered via tools

```
Task Scheduler
├── Task Types
│   ├── Cron - Unix cron expressions (e.g., "0 9 * * 1" for 9am Monday)
│   ├── Interval - Millisecond intervals (e.g., "86400000" for daily)
│   └── Once - ISO 8601 timestamps for one-time tasks
│
├── Task Features
│   ├── Timezone Support (per-task or global)
│   ├── Context Modes:
│   │   ├── group - Runs in group's session context
│   │   └── isolated - Fresh context each run
│   ├── Target Groups - Main group can schedule for other groups
│   ├── State Persistence - state_json carries across runs
│   └── Failure Handling:
│       ├── Exponential backoff retry
│       ├── Circuit breaker at max retries
│       ├── Automatic pause on exhaustion
│       └── Notification on failure/completion
│
└── Configuration
    ├── host.scheduler.pollIntervalMs: 5000ms
    ├── host.scheduler.taskMaxRetries: 3
    ├── host.scheduler.taskRetryBaseMs: 3000ms
    ├── host.scheduler.taskRetryMaxMs: 60000ms
    └── host.scheduler.taskTimeoutMs: 300000ms
```

---

## 8. ADMIN COMMANDS - Discord Control Interface

> **Location:** `src/admin-commands.ts`
> **Access:** `/dotclaw` or `/dc` prefix, or `@botname` mention

```
Admin Commands
├── Command Formats
│   ├── /dotclaw <command> - Full prefix
│   ├── /dc <command> - Shorthand
│   └── @botname <command> - Mention-based
│
├── Help & Info
│   ├── /dotclaw help - Show command list
│   └── /dotclaw groups - List registered groups
│
├── Group Management (Main Only)
│   ├── /dotclaw add-group <chat_id> <name> [folder] [--type <type>] [--desc <desc>] [--skill <skill>]
│   └── /dotclaw remove-group <chat_id|name|folder>
│
├── Model Management (Main Only)
│   └── /dotclaw set-model <model> [global|group|user] [target_id]
│
├── Memory Management (Main Only)
│   └── /dotclaw remember <fact> - Store in memory
│
├── Skill Management (Main Only)
│   ├── /dotclaw skill install <url> [--global]
│   ├── /dotclaw skill remove <name> [--global]
│   ├── /dotclaw skill list [--global]
│   └── /dotclaw skill update <name> [--global]
│
└── Preferences (All Groups)
    ├── /dotclaw style <concise|balanced|detailed> - Response style
    ├── /dotclaw tools <conservative|balanced|proactive> - Tool usage
    ├── /dotclaw caution <low|balanced|high> - Caution level
    └── /dotclaw memory <strict|balanced|loose> - Memory strictness

Natural Language Aliases
├── "set model" vs "set-model"
├── "delete group" vs "remove-group"
├── /help - Alias for /dotclaw help
└── /groups - Alias for /dotclaw groups
```

---

## 9. SKILL SYSTEM - Extensible Agent Behaviors

> **Location:** `container/agent-runner/src/skill-loader.ts`
> **Access:** Automatic discovery from `group/skills/` and `global/skills/`

```
Skill System
├── Skill Formats
│   ├── Directory Form: skills/<name>/SKILL.md (with optional plugins/)
│   └── Single File: skills/<name>.md (with frontmatter)
│
├── Skill Frontmatter
│   ├── name - Skill identifier
│   ├── description - What the skill does
│   ├── license - License type
│   ├── compatibility - Version requirements
│   ├── metadata - Author, version, tags
│   └── plugins - Required plugins
│
└── Skill Features
    ├── Automatic Discovery - Loaded at runtime
    ├── System Prompt Injection - Name/description in prompt
    ├── Plugin References - Skill can require plugins
    ├── Scope - group or global
    └── Management
        ├── Install - Git repo or local file
        ├── Remove - Delete skill
        ├── List - Show all skills
        └── Update - Re-pull from source
```

---

## 10. MCP INTEGRATION - External Tool Connections

> **Location:** `container/agent-runner/src/mcp-*.ts`
> **Access:** Automatic via `mcp-config.json`, runtime tool discovery

```
MCP (Model Context Protocol) Integration
├── MCP Client
│   ├── Stdio Transport - JSON-RPC over stdio
│   ├── Tool Discovery - Automatic tool registration
│   ├── Timeout Handling - Configurable call timeouts
│   └── Env Expansion - ${ENV_VAR} substitution in config
│
├── MCP Registry
│   ├── Server Management - Start/stop servers
│   └── Tool Catalog - All MCP tools
│
└── Configuration (mcp-config.json)
    └── Servers:
        ├── command - Path to server executable
        ├── args - Command arguments
        ├── env - Environment variables
        └── timeoutMs - Call timeout duration
```

---

## 11. CONFIGURATION - Runtime Behavior

> **Location:** `~/.dotclaw/config/`
> **Files:** `.env`, `runtime.json`, `model.json`, `tool-policy.json`, etc.

```
Configuration Files
├── .env - Secrets (tokens, API keys)
├── runtime.json - Runtime overrides
├── model.json - Active model, allowlist, overrides
├── tool-policy.json - Tool allow/deny rules
├── tool-budgets.json - Daily tool limits
├── behavior.json - Autotune outputs
├── mcp-config.json - MCP server configuration
└── mount-allowlist.json - Allowed mount paths

Configuration Areas
├── Host
│   ├── Provider Settings (Discord, Telegram)
│   ├── Message Queue Behavior
│   ├── Streaming Delivery
│   ├── Metrics and Dashboard
│   ├── Webhook Server
│   ├── Timezone
│   └── Heartbeat Settings
│
├── Agent
│   ├── Model Selection and Fallbacks
│   ├── Reasoning Effort
│   ├── Tool Timeouts and Limits
│   ├── Web Search/Fetch Settings
│   ├── Plugin Directories
│   └── Prompt Packs
│
└── Routing
    ├── Model per Group/User
    ├── Routing Rules (keyword-based)
    └── Allowlist Enforcement
```

---

## 12. OBSERVABILITY - Monitoring & Debugging

> **Access:** HTTP endpoints on ports 3001-3002

```
Observability
├── Metrics (Port 3001 - /metrics)
│   └── Prometheus Format:
│       ├── Messages by provider
│       ├── Error rates
│       ├── Tool calls
│       ├── Token usage (prompt, completion, total)
│       ├── Cost tracking
│       ├── Latency histograms (p50, p95, p99)
│       ├── Memory recall/upsert
│       └── Task runs
│
├── Health Dashboard (Port 3002)
│   └── Status Indicators:
│       ├── Status: healthy | degraded | unhealthy
│       ├── Uptime (human-readable)
│       ├── Memory (heap usage)
│       ├── Database (message/task/memory counts)
│       ├── Container (mode and daemon count)
│       ├── Providers (connection status)
│       ├── OpenRouter (API health)
│       └── Queue Depth (pending messages)
│
└── Trace Logging
    ├── JSONL files in ~/.dotclaw/traces/
    ├── Trace Contents:
    │   ├── Request/response data
    │   ├── Tool calls with timing
    │   ├── Memory operations
    │   ├── Failover attempts
    │   └── Cost tracking
    └── Retention (TRACE_RETENTION_DAYS)
```

---

## 13. SPECIAL FEATURES - Unique Capabilities

```
Special Features
├── Wake Recovery
│   ├── Detects sleep/wake via clock drift
│   ├── Health check suppression (60s grace)
│   ├── Provider reconnection
│   ├── Stalled message reset
│   └── Queue re-drain
│
├── Heartbeat
│   ├── Scheduled runs (configurable interval)
│   ├── Main group only
│   ├── [HEARTBEAT] prefix in system prompt
│   ├── Task review
│   └── Silent by default
│
├── Personalization
│   ├── User preferences from memory
│   ├── Response style (concise/balanced/detailed)
│   ├── Tool usage (conservative/balanced/proactive)
│   ├── Caution level (low/balanced/high)
│   ├── Memory strictness (strict/balanced/loose)
│   └── Cached per user
│
├── Failover Policy
│   ├── Error Categories:
│   │   ├── auth - API key/credit issues
│   │   ├── rate_limit - 429 responses
│   │   ├── timeout - Request timeouts
│   │   ├── overloaded - 5xx errors
│   │   ├── transport - Network issues
│   │   ├── invalid_response - Malformed responses
│   │   ├── context_overflow - Token limit exceeded
│   │   ├── aborted - User cancellation
│   │   └── non_retryable - Permanent failures
│   ├── Cooldown Tracking:
│   │   ├── Rate limits: 60s
│   │   ├── Timeouts: 15min → 6hr (3x multiplier)
│   │   └── Persistent state in failover-cooldowns.json
│   ├── Model Fallback Chain
│   └── Reasoning Downgrade
│
├── Maintenance
│   ├── Trace cleanup
│   ├── IPC cleanup
│   ├── Database cleanup
│   ├── Memory cleanup
│   └── Inbox cleanup (14 days, 500MB limit)
│
├── Turn Hygiene
│   ├── Malformed message removal
│   ├── Duplicate filtering
│   ├── Stale partial removal
│   └── Tool envelope normalization
│
└── Webhook Server
    ├── HTTP POST to /webhook/:groupFolder
    ├── Bearer token auth
    ├── Group targeting via URL
    ├── Health check: GET /webhook/health
    └── Configurable port + 1MB body limit
```

---

## 14. CLI - Terminal Control

> **Access:** Command line `dotclaw` binary

```
CLI Commands
├── Instance Management
│   ├── dotclaw start [--foreground] - Start daemon
│   ├── dotclaw stop - Stop daemon
│   ├── dotclaw restart - Restart daemon
│   ├── dotclaw status - Show status
│   └── dotclaw logs [--follow] - View logs
│
├── Multi-Instance Support
│   ├── --id <instance> - Target specific instance
│   ├── --all - Apply to all instances
│   └── Separate homes: ~/.dotclaw, ~/.dotclaw-<id>
│
├── Development
│   ├── dotclaw build - Build TypeScript
│   └── dotclaw doctor - Health check
│
├── Setup
│   ├── dotclaw init - Initialize directories
│   ├── dotclaw bootstrap - First-time setup
│   ├── dotclaw configure - Interactive setup
│   ├── dotclaw autotune - Optimize settings
│   └── dotclaw add-instance <id> - Create instance
│
└── Testing
    ├── dotclaw canary - Run test suite
    └── dotclaw release:slo - Pre-release checks
```

---

## 15. IPC ACTIONS - Container-to-Host Communication

> **Location:** `src/ipc-dispatcher.ts`

```
IPC Actions (Container → Host)
├── Messages
│   ├── edit_message - Edit sent message
│   └── delete_message - Delete sent message
│
├── Tasks
│   ├── schedule_task - Create scheduled task
│   ├── pause_task - Pause task
│   ├── resume_task - Resume task
│   ├── cancel_task - Cancel task
│   └── run_task - Run task immediately
│
├── Requests/Responses
│   ├── set_model - Change model configuration
│   ├── get_config - Read configuration
│   ├── spawn_subagent - Launch subagent
│   ├── subagent_status - Check subagent
│   └── subagent_result - Get subagent results
│
├── Memory
│   ├── memory_upsert - Store memory items
│   ├── memory_forget - Delete memory items
│   ├── memory_search - Search memory
│   ├── memory_list - List memories
│   └── memory_stats - Memory statistics
│
├── Configuration
│   ├── set_tool_policy - Update tool policy
│   ├── set_behavior - Update behavior config
│   └── set_mcp_config - Configure MCP servers
│
└── Groups
    ├── register_group - Register new group
    ├── remove_group - Unregister group
    └── list_groups - List groups
```

---

## 16. SECURITY FEATURES

```
Security
├── Mount Security
│   ├── Path validation (strict group folder checking)
│   ├── Allowlist (mount-allowlist.json)
│   ├── Path traversal prevention (blocks .. attacks)
│   └── Container isolation (readonly mounts where possible)
│
├── Rate Limiting
│   ├── Per-user limits (20 messages/minute default)
│   ├── Provider-qualified (separate limits per provider)
│   └── Retry messages (user-friendly delay notification)
│
└── Input Validation
    ├── Safe group folder regex
    ├── Webhook body limits (1MB max)
    └── Tool argument sanitization (redacts sensitive fields)
```

---

## DISCORD USER JOURNEY MAP

```
First-Time User Experience
│
├── 1. Installation & Setup
│   ├── Clone repo
│   ├── Run dotclaw bootstrap
│   ├── Configure DISCORD_BOT_TOKEN in .env
│   ├── Create Discord application at https://discord.com/developers/applications
│   ├── Enable bot with necessary permissions
│   ├── Invite bot to server
│   └── Run dotclaw start
│
├── 2. Channel Registration
│   ├── Option A: Auto-register on first message (DM)
│   ├── Option B: Manual registration
│   │   ├── /dotclaw add-group discord:CHANNEL_ID channel-name
│   │   └── Configure trigger regex if desired
│   └── Option C: Configuration file editing
│
├── 3. First Interaction
│   ├── Mention bot: @botname help
│   ├── Or send DM: "Hello!"
│   ├── Bot responds with introduction
│   └── Conversation begins
│
├── 4. Customization (Optional)
│   ├── /dotclaw style concise - Set response style
│   ├── /dotclaw tools proactive - Enable more tool usage
│   ├── /dotclaw remember I prefer TypeScript - Store preference
│   └── /dotclaw skill install <url> - Add custom skills
│
└── 5. Advanced Features (Optional)
    ├── Set up scheduled tasks via agent
    ├── Configure custom model per channel
    ├── Add MCP integrations
    ├── Create custom skills
    └── Configure webhooks for external integrations
```

---

## FEATURE INTEGRATION POINTS - For Future Development

```
Where to Integrate New Features
│
├── Discord Provider Level (src/providers/discord/)
│   ├── New message types (add to message handlers)
│   ├── New Discord features (buttons, modals, etc.)
│   ├── Custom interaction handlers
│   └── Channel type extensions
│
├── Message Pipeline Level (src/message-pipeline.ts)
│   ├── New message processing stages
│   ├── Custom batching logic
│   ├── Additional retry strategies
│   └── Context injection points
│
├── Agent Execution Level (src/agent-execution.ts)
│   ├── New context sources
│   ├── Custom tool policies
│   ├── Additional model features
│   └── Execution lifecycle hooks
│
├── Tool Level (container/agent-runner/src/tools.ts)
│   ├── New tool definitions
│   ├── Tool policy extensions
│   └── Custom tool categories
│
├── Memory System Level (src/memory-*.ts)
│   ├── New memory types
│   ├── Custom recall strategies
│   └── Additional embedding models
│
├── Scheduler Level (src/task-scheduler.ts)
│   ├── New task types
│   ├── Custom scheduling strategies
│   └── Task lifecycle hooks
│
├── IPC Level (src/ipc-dispatcher.ts)
│   ├── New IPC actions
│   ├── Custom response handlers
│   └── Additional request types
│
├── Admin Command Level (src/admin-commands.ts)
│   ├── New slash commands
│   ├── Custom command parsers
│   └── Additional permission levels
│
├── Skill Level (container/agent-runner/src/skill-loader.ts)
│   ├── New skill formats
│   ├── Custom skill metadata
│   └── Skill dependency management
│
└── Configuration Level (~/.dotclaw/config/)
    ├── New config files
    ├── Additional runtime settings
    └── Custom validation schemas
```

---

## SUMMARY - Core Discord Capabilities

```
What DotClaw Can Do in Discord
│
├── Messaging
│   ├── Respond to DMs and channel messages
│   ├── Edit messages in real-time (streaming)
│   ├── Handle reactions for feedback
│   ├── Process button interactions
│   ├── Send files, images, audio, polls
│   └── Support all Discord channel types
│
├── Intelligence
│   ├── OpenRouter-based AI (any model)
│   ├── Long-term memory per channel
│   ├── Context-aware responses
│   ├── Multi-model fallback
│   └── Customizable per channel/user
│
├── Automation
│   ├── Scheduled tasks (cron/interval)
│   ├── Custom skills and plugins
│   ├── MCP server integrations
│   ├── Webhook triggers
│   └── Subagent spawning
│
├── Tools
│   ├── File operations (read, write, edit)
│   ├── Command execution (bash, python)
│   ├── Web access (search, fetch)
│   ├── Image analysis
│   └── Custom plugins
│
├── Operations
│   ├── Metrics and monitoring
│   ├── Health dashboard
│   ├── Trace logging
│   ├── CLI management
│   └── Multi-instance support
│
└── Extensibility
    ├── Custom skills
    ├── Tool plugins
    ├── MCP integrations
    ├── Admin commands
    └── Configuration overrides
```

---

## 17. DAILY PLANNING & BRIEFING WORKFLOW - Productivity Features

> **Location:** `src/journal-manager.ts`, `src/daily-planning.ts`, `src/poll-manager.ts`, `src/forum-thread-manager.ts`
> **Status:** [[planned]]

```
Daily Planning Workflow
├── Morning Routine
│   ├── [[Daily Briefing]] - Automated morning briefings
│   │   ├── Based on yesterday's journal
│   │   ├── Current goals and projects
│   │   ├── Pending/in-progress tasks
│   │   └── Calendar events (when integrated)
│   │
│   └── [[Daily Planning]] - Collaborative task planning
│       ├── User and bot agree on day's tasks
│       ├── Bot acts as accountability partner
│       ├── Pushes back on overcommitment
│       └── Helps prioritize focus areas
│
├── Task Management (TO-DO Forum)
│   ├── [[Task Breakdown]] - Subagent decomposes tasks
│   │   ├── Max 10 atomic subtasks
│   │   ├── Each subtask: "[Emoji] Title" (≤55 chars)
│   │   └── Context: repo, URL, calendar links
│   │
│   ├── [[Forum Threads]] - Each main task gets a thread
│   │   ├── Posted to TO-DO forum channel
│   │   ├── Auto-archive after 24 hours
│   │   └── Thread metadata for status tracking
│   │
│   └── [[Poll Checklists]] - Discord polls as checklists
│       ├── Multi-select poll (max 10 options)
│       ├── Each option = one subtask
│       ├── All checked = task complete
│       └── ✅ reaction on thread = override complete
│
├── Evening Routine
│   ├── [[Nightly Recap]] - Conversational reflection
│   │   ├── Gathers what bot doesn't know
│   │   ├── Sentiment, highs/lows, tomorrow's focus
│   │   ├── Natural flow, not interview script
│   │   └── Fills in gaps intelligently
│   │
│   └── [[Journal Entry]] - Structured daily journal
│       ├── Tasks completed/in-progress
│       ├── Sentiment (positive/neutral/negative)
│       ├── Biggest success and error
│       ├── Highlights (good/bad)
│       ├── Focus for tomorrow
│       └── First-person diary summary
│
└── Automation & State
    ├── [[Scheduled Triggers]]
    │   ├── Daily briefing at configured time
    │   └── Nightly recap at configured time
    │
    ├── [[State Manager]]
    │   ├── Poll completion detection
    │   ├── Task progress tracking
    │   ├── Thread lifecycle management
    │   └── Background sync with Discord API
    │
    └── [[Error Handling]]
        ├── Graceful failures
        ├── Retry logic for API issues
        └── User notifications
```

### Database Schema (Planned)

```sql
-- Daily journal entries
CREATE TABLE daily_journals (
  id TEXT PRIMARY KEY,
  group_folder TEXT NOT NULL,
  date TEXT NOT NULL,  -- YYYY-MM-DD
  tasks_completed TEXT,      -- JSON array
  tasks_in_progress TEXT,    -- JSON array
  sentiment TEXT,
  biggest_success TEXT,
  biggest_error TEXT,
  highlights TEXT,           -- JSON: {good: [], bad: []}
  focus_tomorrow TEXT,
  diary_entry TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(group_folder, date)
);

-- Atomic daily tasks
CREATE TABLE daily_tasks (
  id TEXT PRIMARY KEY,
  group_folder TEXT NOT NULL,
  journal_id TEXT,
  parent_task TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER DEFAULT 0,
  tags TEXT,           -- JSON array
  metadata TEXT,       -- JSON: {repo, url, calendar_link}
  discord_channel_id TEXT,
  discord_thread_id TEXT,
  discord_poll_id TEXT,
  poll_data TEXT,      -- JSON: poll options, answers
  completed_at TEXT,
  created_at TEXT NOT NULL,
  due_date TEXT,
  archived_at TEXT,
  FOREIGN KEY (journal_id) REFERENCES daily_journals(id)
);

-- Generated daily briefings
CREATE TABLE daily_briefings (
  id TEXT PRIMARY KEY,
  group_folder TEXT NOT NULL,
  date TEXT NOT NULL,
  briefing_text TEXT NOT NULL,
  sources TEXT,        -- JSON: {journal_id, tasks, events}
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(group_folder, date)
);
```

### Skills (Planned)

```
Skills
├── global/skills/daily-briefing/SKILL.md
│   └── Generates morning briefings from context
│
├── global/skills/nightly-recap/SKILL.md
│   └── Conducts reflective evening conversations
│
├── global/skills/daily-planning/SKILL.md
│   └── Collaborative planning with accountability
│
└── global/skills/task-breakdown/SKILL.md
    └── Decomposes tasks into atomic subtasks
```

### Admin Commands (Planned)

```
Planning & Task Commands
├── /dotclaw schedule-briefing <HH:MM> [timezone]
├── /dotclaw schedule-recap <HH:MM> [timezone]
├── /dotclaw show-schedule
├── /dotclaw remove-schedule <briefing|recap>
├── /dotclaw planning-status
├── /dotclaw reset-planning
├── /dotclaw list-tasks [date]
├── /dotclaw complete-task <id>
├── /dotclaw archive-task <id>
├── /dotclaw show-journal [date]
└── /dotclaw configure-workflow
    ├── briefing_time
    ├── recap_time
    ├── forum_channel_id
    └── auto_archive_hours
```

### Configuration (Planned)

```json
// ~/.dotclaw/workflow-config.json
{
  "group_folder": {
    "briefing_time": "09:00",
    "recap_time": "22:00",
    "forum_channel_id": "1234567890",
    "auto_archive_hours": 24,
    "timezone": "America/New_York"
  }
}
```

---

*Generated as architectural reference for DotClaw development*
*Focus: Discord user experience and capabilities*
*Use this document to plan feature integrations and understand system boundaries*
