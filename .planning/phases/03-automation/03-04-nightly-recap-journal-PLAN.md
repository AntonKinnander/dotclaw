# PLAN 03-04: Nightly Recap & Journal Integration

## Objective

Complete the nightly recap and journal workflow by adding container-side tools for daily planning operations. The nightly-recap skill references tools that need to be implemented for the agent to create and retrieve journal entries.

## Context

@file:global/skills/nightly-recap/SKILL.md - Nightly recap skill (references `get_daily_tasks`, `get_planning_context`, `create_journal`)
@file:global/skills/daily-planning/SKILL.md - Daily planning skill (references same tools)
@file:src/db.ts - Database has `daily_journals` table with CRUD functions
@file:src/ipc-dispatcher.ts - IPC actions `create_journal`, `get_daily_tasks`, `get_planning_context` exist on host
@file:container/agent-runner/src/ipc.ts - Container-side IPC (needs planning tools)
@file:src/recap-trigger.ts - Recap trigger module exists

## Current State

- **Database**: `daily_journals` table exists with `createDailyJournal`, `getDailyJournalByDate`, `getLatestDailyJournal`, `listDailyJournals`, `updateDailyJournal`
- **Host IPC**: `create_journal`, `get_daily_tasks`, `get_planning_context` actions implemented in `ipc-dispatcher.ts`
- **Skill**: `nightly-recap` skill exists and references the tools
- **Missing**: Container-side tools in `container/agent-runner/src/tools.ts` to call these IPC actions

## Dependencies

- None (database and IPC actions already exist)
- Phase 03-01 scheduled triggers (recap-trigger.ts) is complete

## Tasks

### Task 1: Add container-side daily planning tools

**Type:** `task` | **Files:** `container/agent-runner/src/tools.ts`

**Action:**
Add three new tools to the container's tools.ts for daily planning operations:

```typescript
// Tool 1: get_daily_tasks
tool({
  name: 'get_daily_tasks',
  description: 'Get all active daily tasks for the current group',
  inputSchema: z.object({}),
  execute: async (args, context) => {
    const ipc = createIpcHandlers(context.ipc, context.toolRuntime);
    const response = await ipc.requestResponse('get_daily_tasks', {});
    if (!response.ok) {
      throw new Error(response.error || 'Failed to get daily tasks');
    }
    return response.result;
  }
})

// Tool 2: get_planning_context
tool({
  name: 'get_planning_context',
  description: 'Get planning context including in-progress tasks and latest journal',
  inputSchema: z.object({}),
  execute: async (args, context) => {
    const ipc = createIpcHandlers(context.ipc, context.toolRuntime);
    const response = await ipc.requestResponse('get_planning_context', {});
    if (!response.ok) {
      throw new Error(response.error || 'Failed to get planning context');
    }
    return response.result;
  }
})

// Tool 3: create_journal
tool({
  name: 'create_journal',
  description: 'Create or update a daily journal entry with reflection data',
  inputSchema: z.object({
    date: z.string().optional().describe('Date in YYYY-MM-DD format (defaults to today)'),
    tasks_completed: z.array(z.string()).optional().describe('List of completed task IDs or titles'),
    tasks_in_progress: z.array(z.string()).optional().describe('List of in-progress task IDs or titles'),
    sentiment: z.enum(['positive', 'neutral', 'negative']).optional().describe('Overall sentiment for the day'),
    biggest_success: z.string().optional().describe('Key win or achievement'),
    biggest_error: z.string().optional().describe('Learning moment or mistake'),
    focus_tomorrow: z.string().optional().describe('One thing to prioritize tomorrow'),
    diary_entry: z.string().optional().describe('Free-form diary text'),
  }),
  execute: async (args, context) => {
    const ipc = createIpcHandlers(context.ipc, context.toolRuntime);
    const response = await ipc.requestResponse('create_journal', args);
    if (!response.ok) {
      throw new Error(response.error || 'Failed to create journal entry');
    }
    return response.result;
  }
})
```

**Implementation Notes:**
- Import `createIpcHandlers` and `IpcContext` from `./ipc.js`
- Tools use the `requestResponse` IPC pattern for synchronous requests
- The IPC actions are already implemented on the host side
- Add these tools near other database-related tools

**Verify:**
- Tools compile without errors
- Tools are registered in the tool catalog
- Each tool properly handles IPC responses

**Done when:** All three daily planning tools are added to container

---

### Task 2: Add IPC request handlers for daily planning

**Type:** `task` | **Files:** `container/agent-runner/src/ipc.ts`

**Action:**
Extend the IPC handlers interface to include the daily planning request methods:

```typescript
// Add to the return object of createIpcHandlers()
async getDailyTasks() {
  return requestResponse('get_daily_tasks', {}, this.config);
},

async getPlanningContext() {
  return requestResponse('get_planning_context', {}, this.config);
},

async createJournal(args: {
  date?: string;
  tasks_completed?: string[];
  tasks_in_progress?: string[];
  sentiment?: 'positive' | 'neutral' | 'negative';
  biggest_success?: string;
  biggest_error?: string;
  focus_tomorrow?: string;
  diary_entry?: string;
}) {
  return requestResponse('create_journal', args, this.config);
},
```

**Implementation Notes:**
- The `requestResponse` helper already exists
- Add these methods alongside other `requestResponse` calls like `getConfig`
- Ensure proper TypeScript types for parameters

**Verify:**
- IPC methods are callable from tools
- Proper error handling for timeout/failure

**Done when:** All three IPC methods are added to ipc.ts

---

### Task 3: Test nightly recap workflow end-to-end

**Type:** `test` | **Files:** `test/journal-workflow.test.js` (new)

**Action:**
Create integration test for the nightly recap workflow:

```javascript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempHome } from './test-helpers.js';

describe('Nightly Recap & Journal Workflow', () => {
  it('should create journal entry via IPC', async () => {
    await withTempHome(async ({ tempHome, dbPath }) => {
      // Setup: Import modules
      const { createDailyJournal, getDailyJournalByDate } = await('../src/db.js');
      const { processRequestIpc } = await('../src/ipc-dispatcher.js');

      // Test: Create journal via IPC
      const response = await processRequestIpc(
        { registeredGroups: () => ({}), sessions: () => ({}) },
        {
          id: 'test-req-1',
          type: 'create_journal',
          payload: {
            date: '2026-02-18',
            tasks_completed: ['task-1', 'task-2'],
            tasks_in_progress: ['task-3'],
            sentiment: 'positive',
            biggest_success: 'Fixed auth bug',
            focus_tomorrow: 'Write docs'
          }
        },
        'test-group',
        true
      );

      assert.equal(response.ok, true);
      assert.ok(response.result.journal_id);

      // Verify: Journal was created in DB
      const journal = getDailyJournalByDate('test-group', '2026-02-18');
      assert.ok(journal);
      assert.equal(journal.sentiment, 'positive');
    });
  });

  it('should get daily tasks via IPC', async () => {
    await withTempHome(async ({ tempHome }) => {
      const { createDailyTask } = await('../src/db.js');
      const { processRequestIpc } = await('../src/ipc-dispatcher.js');

      // Setup: Create test tasks
      createDailyTask({
        group_folder: 'test-group',
        title: 'Test Task 1',
        status: 'pending'
      });
      createDailyTask({
        group_folder: 'test-group',
        title: 'Test Task 2',
        status: 'in_progress'
      });

      // Test: Get tasks via IPC
      const response = await processRequestIpc(
        { registeredGroups: () => ({}), sessions: () => ({}) },
        {
          id: 'test-req-2',
          type: 'get_daily_tasks',
          payload: {}
        },
        'test-group',
        true
      );

      assert.equal(response.ok, true);
      assert.ok(Array.isArray(response.result.tasks));
      assert.equal(response.result.tasks.length, 2);
    });
  });

  it('should get planning context via IPC', async () => {
    await withTempHome(async ({ tempHome }) => {
      const { createDailyJournal, getLatestDailyJournal } = await('../src/db.js');
      const { processRequestIpc } = await('../src/ipc-dispatcher.js');

      // Setup: Create a journal entry
      createDailyJournal({
        group_folder: 'test-group',
        date: '2026-02-17',
        sentiment: 'neutral',
        focus_tomorrow: 'Test planning'
      });

      // Test: Get context via IPC
      const response = await processRequestIpc(
        { registeredGroups: () => ({}), sessions: () => ({}) },
        {
          id: 'test-req-3',
          type: 'get_planning_context',
          payload: {}
        },
        'test-group',
        true
      );

      assert.equal(response.ok, true);
      assert.ok(response.result.yesterday_outcomes);
      assert.equal(response.result.yesterday_outcomes.focus_tomorrow, 'Test planning');
    });
  });
});
```

**Verify:**
- All tests pass
- Journal entries persist correctly
- IPC communication works both ways
- Error handling is tested

**Done when:** Integration tests cover the full workflow

---

### Task 4: Add container build verification

**Type:** `task` | **Files:** `container/agent-runner/src/tools.ts`

**Action:**
After adding the tools, rebuild the container image and verify:

1. Run `./container/build.sh` to rebuild with new tools
2. Run `npm run dev:up` to restart with clean containers
3. Test the nightly-recap skill manually:
   - Type `/recap` in a Discord channel
   - Verify the agent can access `get_daily_tasks`
   - Verify the agent can access `get_planning_context`
   - Verify the agent can create a journal entry
   - Check the journal was persisted to database

**Manual Test Script:**
```bash
# Rebuild container
./container/build.sh

# Restart with clean containers
npm run dev:down
npm run dev:up

# In Discord, test the workflow:
# 1. /recap
# 2. Agent should show active tasks
# 3. Have a conversation about the day
# 4. Agent should create journal entry
# 5. /journal today — should show the entry
```

**Verify:**
- Container builds successfully
- No TypeScript errors
- Tools are available in agent
- Journal entries persist to database

**Done when:** Manual test confirms the full workflow

---

## Verification (Overall)

1. **Tool Integration:**
   - `get_daily_tasks` tool returns active tasks
   - `get_planning_context` tool returns yesterday's outcomes
   - `create_journal` tool persists entries to database

2. **Nightly Recap Skill:**
   - `/recap` command starts conversation
   - Agent retrieves tasks automatically
   - Agent creates journal at end of conversation
   - Journal is queryable via `/journal today`

3. **Database Persistence:**
   - Journal entries stored in `daily_journals` table
   - Date-based uniqueness enforced
   - Updates work for existing entries

## Success Criteria

- [ ] Three daily planning tools added to container
- [ ] IPC methods added to container ipc.ts
- [ ] Integration tests pass
- [ ] Container builds successfully
- [ ] `/recap` workflow works end-to-end
- [ ] Journal entries persist to database
- [ ] `/journal today` shows created entries

## Output

SUMMARY.md should contain:
- Daily planning tools added to `container/agent-runner/src/tools.ts`
- IPC methods added to `container/agent-runner/src/ipc.ts`
- Integration tests created at `test/journal-workflow.test.js`
- Container rebuilt with new tools
- Manual test of `/recap` workflow successful
- Example journal entry created

## Notes

- The database schema and host-side IPC are already complete
- This plan focuses on connecting the container agent to those existing features
- The nightly-recap skill is already written and just needs the tools to function
- Consider adding similar tools for `getDailyJournalByDate` and `listDailyJournals` for `/journal` commands
