# Roadmap: Daily Planning & Briefing Workflow

## Milestone 1.0 - Core Foundation

| Plan | Focus | Status |
|-------|--------|--------|
| 01-01 | Database Schema & Core Types | `[[complete]]` |
| 01-02 | Channel Architecture | `[[complete]]` |
| 01-03 | Message Storage | `[[complete]]` |
| 01-04 | Event Processing | `[[complete]]` |

## Milestone 1.1 - TO-DO System

| Plan | Focus | Status |
|-------|--------|--------|
| 02-01 | Task Breakdown Subagent | `[[complete]]` |
| 02-02 | Forum Task Creation | `[[complete]]` |
| 02-03 | Poll Tracking | `[[pending]]` |
| 02-04 | Task Completion | `[[pending]]` |

## Milestone 1.2 - Scheduling & Automation

| Plan | Focus | Status |
|-------|--------|--------|
| 03-01 | Scheduled Triggers | `[[pending]]` |
| 03-02 | State Manager | `[[pending]]` |
| 03-03 | Integration & Polish | `[[pending]]` |

---

## Completed Work

### 01-01: Database Schema & Core Types ✅
- Created `daily_journals`, `daily_tasks`, `daily_briefings` tables
- Added TypeScript types for all entities
- Implemented CRUD functions for journals, tasks, and briefings
- Migration tracking in place

### 01-02: Channel Architecture ✅
- Forum channel detection (type 15)
- Text channel handling (type 0)
- Channel metadata extraction

### 01-03: Message Storage ✅
- Discord message storage to database
- Attachment handling
- Thread message linking

### 01-04: Event Processing ✅
- Discord event handlers
- Message queue integration
- Channel context preservation

### 02-01: Task Breakdown Subagent ✅
- Task breakdown skill (`global/skills/task-breakdown/SKILL.md`)
- Orchestrator module (`src/task-breakdown.ts`)
- IPC action `breakdown_task`
- Validates emoji prefix, max 55 chars, max 10 subtasks

### 02-02: Forum Task Creation ✅
- Forum thread manager (`src/forum-thread-manager.ts`)
- Thread state persistence to JSON file
- Auto-archive after 24 hours
- Create, archive, lock operations

## Remaining Work

### 02-03: Poll Tracking
- Discord poll creation
- Poll answer tracking
- Vote count updates

### 02-04: Task Completion
- Poll completion detection
- Reaction override (✅)
- Auto-archive completed tasks

### 03-01: Scheduled Triggers
- Briefing scheduler module
- Recap trigger module
- Admin commands for scheduling

### 03-02: State Manager
- Unified state tracking
- Discord API polling
- Background sync loop

### 03-03: Integration & Polish
- End-to-end workflow tests
- Error handling and recovery
- User control commands

---

## Notes

- Each plan is independently executable and verifiable
- `[[complete]]` marks fully implemented phases
- `[[pending]]` marks planned/unfinished work
