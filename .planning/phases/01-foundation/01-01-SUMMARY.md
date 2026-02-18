# SUMMARY 01-01: Database Schema & Core Types

## Completed

### Database Schema
- Added `migrateDailyPlanning()` function in `src/db.ts`
- Created three new tables:
  - `daily_journals` - journal entries with sentiment, highlights, diary
  - `daily_tasks` - atomic tasks with Discord references and poll data
  - `daily_briefings` - generated daily briefings with sources
- Migration tracked via `_migrations` table with key `daily_planning_v1`
- Indexes added for date and status queries

### TypeScript Types
- Added `DailyJournal` interface in `src/types.ts`
- Added `JournalInput` interface for creating/updating journals
- Added `DailyTask` interface with full Discord integration
- Added `TaskInput` interface for task creation
- Added `DailyBriefing` and `BriefingInput` interfaces

### CRUD Functions
- `createDailyJournal()` - Create or update journal entry
- `getDailyJournalByDate()` - Retrieve journal by date
- `getLatestDailyJournal()` - Get most recent journal
- `listDailyJournals()` - List journals with limit
- `updateDailyJournal()` - Update journal fields
- `createDailyTask()` - Create new task
- `getDailyTaskById()` - Get task by ID
- `getDailyTasksByJournal()` - Get tasks for a journal
- `getDailyTasksForDate()` - Get tasks for specific date
- `getActiveDailyTasks()` - Get non-archived tasks
- `updateDailyTask()` - Update task fields
- `setDailyTaskDiscordRefs()` - Set Discord channel/thread/poll IDs
- `updateDailyTaskPollData()` - Update poll vote data
- `archiveOldDailyTasks()` - Archive tasks older than N days
- `createDailyBriefing()` - Create or update briefing
- `getDailyBriefingByDate()` - Get briefing by date
- `getLatestDailyBriefing()` - Get most recent briefing
- `markBriefingDelivered()` - Mark briefing as delivered

## Deviations
- Used `DailyTaskRow`, `DailyJournalRow`, `DailyBriefingRow` internal types for DB rows instead of exporting separate row types
- Migration is called from `initDatabase()` automatically
- No separate `getTaskById` conflict - used `getDailyTaskById` to distinguish from scheduled task functions

## Files Modified
- `src/db.ts` - Added migration, tables, CRUD functions (~180 lines)
- `src/types.ts` - Added journal, task, briefing types (~90 lines)

## Verification
```bash
npm run build  # Success
npm run typecheck  # Success
```
