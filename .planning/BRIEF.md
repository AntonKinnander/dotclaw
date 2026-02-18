# Brief: Daily Planning & Briefing Workflow

## Vision

Build a comprehensive personal productivity workflow for Discord that integrates:
1. **Daily Briefing** - Automated morning briefings based on journal, goals, calendar, and context
2. **Daily Planning** - Collaborative task prioritization with AI accountability
3. **TO-DO System** - Forum-based task threads with Discord polls as checklists
4. **Nightly Recap** - Reflective end-of-day review gathering missing data points
5. **Journal System** - Structured daily journal entries with sentiment and metrics

## Context

**Base Codebase:** DotClaw - Discord-based AI assistant (TypeScript, discord.js)

**Key Existing Capabilities:**
- Discord provider with poll support, buttons, reactions, threads
- Task scheduler (cron/interval/once tasks)
- Memory system (SQLite with FTS5 + embeddings)
- IPC actions for agent-to-host communication
- Subagent spawning capability

**Design Philosophy:**
- Agent should have **intuitive access** to all tools/data (not hardcoded "look at X then Y")
- Prompts should be **growable** - work with minimal integrations now, expand as tools added
- Bot should act as **accountability partner** (not just fold to user preferences)
- **Discord-native** UI - hijack polls as to-do items, use forum threads for organization

## User Story

Every night, the bot creates a daily briefing for the next morning based on:
- Yesterday's journal entry
- Current goals and active projects
- Calendar events (when integrated)
- Previous unfinished tasks

In the morning, user reads the briefing and collaboratively plans the day with the bot. The bot acts as a manager - keeping the user accountable to goals while listening to feedback.

When tasks are agreed upon, the bot breaks them into atomic subtasks (max 10) and creates forum threads with Discord polls as checklists. Each subtask is a poll option - multi-select poll tracks progress. Task is complete when all checked or ✅ reaction on thread.

At night, the bot conducts a reflective recap - gathering data it doesn't know (sentiment, highs/lows, tomorrow's focus) through conversation, not interview script.

Finally, it creates a structured journal entry - tasks completed, sentiment, biggest success/error, diary-style summary in first person.

## Key Challenges

1. **State Management** - Tracking poll completion, task progress, forum thread lifecycle
2. **Accountable Conversations** - Balancing helpfulness with goal-accountability
3. **Intuitive Data Access** - Agent needs context-aware tool discovery, not hardcoded steps
4. **Discord API Limitations** - Poll updates are limited, thread archiving needs manual handling
5. **Database Schema** - New tables needed for journal, tasks, daily briefs
