# Daily Planning & Briefing Workflow - Planning Summary

## Overview

This document summarizes the comprehensive plan for building a daily productivity workflow for Discord, integrated into DotClaw (TypeScript, discord.js).

## What Was Created

### Planning Structure

```
.planning/
├── BRIEF.md                     # Project vision and requirements
├── ROADMAP.md                   # Phase breakdown with milestones
└── phases/
    ├── 01-foundation/           # Milestone 1.0: Core Foundation
    │   ├── 01-01-PLAN.md        # Database schema & types
    │   ├── 01-02-PLAN.md        # Journal system
    │   ├── 01-03-PLAN.md        # Daily briefing skill
    │   └── 01-04-PLAN.md        # Nightly recap flow
    ├── 02-todo-system/          # Milestone 1.1: TO-DO System
    │   ├── 02-01-PLAN.md        # Task breakdown subagent
    │   ├── 02-02-PLAN.md        # Forum thread manager
    │   ├── 02-03-PLAN.md        # Poll-based checklists
    │   └── 02-04-PLAN.md        # Daily planning flow
    └── 03-automation/           # Milestone 1.2: Automation
        ├── 03-01-PLAN.md        # Scheduled triggers
        ├── 03-02-PLAN.md        # State manager
        └── 03-03-PLAN.md        # Integration & polish
```

### Files Modified

- `features.md` - Added Section 17: Daily Planning & Briefing Workflow with planned features marked with `[[planned]]` and `[[double brackets]]`

## Phase Summary

### Milestone 1.0 - Core Foundation (Phases 01-01 to 01-04)

**Focus:** Database, journal system, daily briefing, and nightly recap

| Plan | Description | Key Files |
|------|-------------|-----------|
| 01-01 | Database schema & TypeScript types | `src/db.ts`, `src/types.ts` |
| 01-02 | Journal system with memory integration | `src/journal-manager.ts` |
| 01-03 | Daily briefing agent skill | `global/skills/daily-briefing/SKILL.md` |
| 01-04 | Nightly recap conversational flow | `global/skills/nightly-recap/SKILL.md` |

### Milestone 1.1 - TO-DO System (Phases 02-01 to 02-04)

**Focus:** Task breakdown, forum threads, polls, collaborative planning

| Plan | Description | Key Files |
|------|-------------|-----------|
| 02-01 | Task breakdown subagent | `src/task-breakdown.ts`, `global/skills/task-breakdown/SKILL.md` |
| 02-02 | Forum thread management | `src/forum-thread-manager.ts` |
| 02-03 | Discord polls as checklists | `src/poll-manager.ts` |
| 02-04 | Collaborative daily planning | `src/daily-planning.ts`, `global/skills/daily-planning/SKILL.md` |

### Milestone 1.2 - Automation (Phases 03-01 to 03-03)

**Focus:** Scheduled triggers, state management, end-to-end integration

| Plan | Description | Key Files |
|------|-------------|-----------|
| 03-01 | Scheduled briefing/recap triggers | `src/briefing-scheduler.ts`, `src/recap-trigger.ts` |
| 03-02 | Unified state manager | `src/task-state-manager.ts` |
| 03-03 | Error handling & user controls | `src/task-workflow-errors.ts` |

## Design Principles

1. **Intuitive Data Access** - Agent has tools available, not hardcoded "look at X then Y" prompts
2. **Accountability Partner** - Bot doesn't fold; holds user accountable to goals
3. **Discord-Native** - Uses polls, threads, reactions - works within Discord's UI
4. **Growable System** - Works with minimal integrations now, expands as tools added
5. **Conversational** - Nightly recap feels natural, not an interview

## Key Technical Decisions

### Discord Polls as Checklists
- Multi-select polls track subtask completion
- Each poll option = one subtask with emoji prefix
- Max 10 options (Discord limit)
- All checked OR ✅ reaction = task complete

### Forum Thread Organization
- Each major task gets its own thread in TO-DO forum
- Thread contains description + poll checklist
- Auto-archive after 24 hours (configurable)
- State persists across bot restarts

### State Management
- Background sync with Discord API
- Hash-based change detection (reduces DB writes)
- File-based persistence for thread/poll mappings
- Automatic archival of old tasks

## Next Steps

1. **Review and approve** the plan structure
2. **Begin Phase 01-01** - Database schema and types
3. **Execute phases sequentially** - Each phase is independently verifiable
4. **Use `/run-plan`** for execution (more context-efficient than skill invocation)

## Execution Notes

- Each plan contains 2-3 tasks maximum (scope control)
- Plans include verification steps and success criteria
- Use `checkpoint:human-verify` for tasks requiring visual confirmation
- Deviations are handled automatically per embedded rules
- All work documented in phase SUMMARY.md files

---

*Plan created: 2026-02-18*
*Status: Ready for execution*
*Milestone: 1.0 Foundation → 1.1 TO-DO → 1.2 Automation*
