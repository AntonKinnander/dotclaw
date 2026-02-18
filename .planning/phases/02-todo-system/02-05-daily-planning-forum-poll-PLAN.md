# PLAN 02-05: Daily Planning Forum & Poll Orchestrator

## Objective

Create a `DailyPlanningOrchestrator` class that coordinates the daily planning workflow: task breakdown -> forum thread creation -> poll creation -> state management. This bridges the gap between the daily-planning skill (which calls `create_task_thread`) and the existing infrastructure (breakdown, forum manager, poll manager, task state manager).

## Context

@file:global/skills/daily-planning/SKILL.md - Daily planning skill that calls `create_task_thread`
@file:src/ipc-dispatcher.ts - Has `breakdown_task` and `create_task_thread` IPC actions
@file:src/forum-thread-manager.ts - Forum thread creation and state tracking
@file:src/poll-manager.ts - Poll creation and validation
@file:src/task-state-manager.ts - Task state sync and completion tracking
@file:src/task-breakdown.ts - Subtask parsing utilities

## Problem

The daily-planning skill describes the flow:
1. Use `breakdown_task` to decompose task into subtasks
2. Create forum thread with `create_task_thread`
3. Include the subtask poll

But the current `create_task_thread` IPC action requires `subtasks` to be passed in - it doesn't call `breakdown_task` itself. The skill has to manually coordinate two separate IPC calls, which is error-prone and doesn't match the skill's documented flow.

## Solution

Create an orchestrator that wraps the entire workflow:
- Accept main task title
- Call `breakdown_task` internally
- Create forum thread
- Create poll with subtasks
- Update task state

## Tasks

### Task 1: Create DailyPlanningOrchestrator class

**Type:** `task` | **Files:** `src/daily-planning-orchestrator.ts` (new)

**Action:**
Create an orchestrator class that coordinates the daily planning workflow:

```typescript
export interface PlanningSession {
  group_folder: string;
  forum_channel_id: string;
  tasks: Array<{
    title: string;
    description?: string;
    priority?: number;
    due_date?: string;
  }>;
}

export interface PlanningResult {
  success: boolean;
  tasks_created: Array<{
    task_id: string;
    thread_id: string;
    poll_id: string | null;
    subtask_count: number;
  }>;
  errors: string[];
}

export class DailyPlanningOrchestrator {
  constructor(
    private discordProvider: DiscordProvider,
    private registry: ProviderRegistry
  ) {}

  /**
   * Run a daily planning session:
   * 1. Break down each task into subtasks
   * 2. Create forum thread for each task
   * 3. Create poll with subtasks
   * 4. Update task state
   */
  async runPlanningSession(session: PlanningSession): Promise<PlanningResult>;

  /**
   * Create a single task with breakdown:
   * 1. Call breakdown_task via IPC
   * 2. Create forum thread
   * 3. Create poll
   * 4. Return task refs
   */
  async createTaskWithBreakdown(
    groupFolder: string,
    mainTask: string,
    forumChannelId: string,
    context?: Record<string, unknown>
  ): Promise<{
    task_id: string;
    thread_id: string;
    poll_id: string | null;
    subtasks: string[];
  } | null>;
}
```

**Verify:**
- Class compiles without errors
- Has clear separation of concerns
- Uses existing managers (forum, poll, task state)

**Done when:** Orchestrator class skeleton exists with type definitions

---

### Task 2: Wire breakdown -> forum creation -> poll creation

**Type:** `task` | **Files:** `src/daily-planning-orchestrator.ts`

**Action:**
Implement `createTaskWithBreakdown` method:

```typescript
async createTaskWithBreakdown(
  groupFolder: string,
  mainTask: string,
  forumChannelId: string,
  context?: Record<string, unknown>
): Promise<...> {
  // 1. Call breakdown_task IPC (or directly use executeAgentRun)
  const breakdownResult = await this.breakdownTask(mainTask, context);
  if (!breakdownResult || breakdownResult.subtasks.length === 0) {
    return null;
  }

  // 2. Create daily task in database
  const taskId = createDailyTask({
    group_folder: groupFolder,
    title: mainTask,
    status: 'pending',
  });

  // 3. Create forum thread via Discord provider
  const threadResult = await this.discordProvider.createForumThread(
    forumChannelId,
    mainTask,
    `Task thread with ${breakdownResult.subtasks.length} subtasks`
  );

  if (!threadResult.success) {
    return null;
  }

  // 4. Create poll with subtasks
  const pollManager = getPollManager();
  pollManager.setDiscordProvider(this.discordProvider);
  const pollResult = await pollManager.createTaskPoll(
    taskId,
    mainTask,
    breakdownResult.subtasks.map(s => s.title),
    forumChannelId,
    threadResult.threadId
  );

  // 5. Update Discord references
  setDailyTaskDiscordRefs(taskId, forumChannelId, threadResult.threadId, pollResult.pollId);

  return {
    task_id: taskId,
    thread_id: threadResult.threadId,
    poll_id: pollResult.pollId,
    subtasks: breakdownResult.subtasks.map(s => s.title),
  };
}
```

**Verify:**
- Method calls breakdown before forum creation
- Forum thread is created successfully
- Poll is created with subtasks
- Discord refs are stored

**Done when:** End-to-end single task creation works

---

### Task 3: Add IPC action for orchestrated planning

**Type:** `task` | **Files:** `src/ipc-dispatcher.ts`

**Action:**
Add new IPC action `create_planned_task` that uses the orchestrator:

```typescript
case 'create_planned_task': {
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const forumChannelId = typeof payload.forum_channel_id === 'string'
    ? payload.forum_channel_id
    : '';
  const context = payload.context as Record<string, unknown> | undefined;

  if (!title || !forumChannelId) {
    return { id: requestId, ok: false, error: 'title and forum_channel_id are required' };
  }

  // Get or create orchestrator
  const provider = deps.registry.getProviderForChat(`discord:${forumChannelId}`);
  if (!provider) {
    return { id: requestId, ok: false, error: 'Discord provider not available' };
  }

  const orchestrator = getDailyPlanningOrchestrator(provider, deps.registry);
  const result = await orchestrator.createTaskWithBreakdown(
    sourceGroup,
    title,
    forumChannelId,
    context
  );

  if (!result) {
    return { id: requestId, ok: false, error: 'Failed to create planned task' };
  }

  return {
    id: requestId,
    ok: true,
    result: {
      task_id: result.task_id,
      thread_id: result.thread_id,
      poll_id: result.poll_id,
      subtasks: result.subtasks,
    }
  };
}
```

**Verify:**
- IPC action is reachable from agent
- Returns task and thread IDs
- Error handling works

**Done when:** Agent can call `create_planned_task` to create full task with breakdown

---

### Task 4: Update daily-planning skill to use orchestrator

**Type:** `task` | **Files:** `global/skills/daily-planning/SKILL.md`

**Action:**
Update the daily-planning skill to use the new `create_planned_task` action:

```markdown
## Available Tools

- `create_planned_task` - Create task with automatic breakdown, forum thread, and poll
- `get_planning_context` - Get current tasks and yesterday's outcomes
- `get_daily_tasks` - List all active tasks
- `memory_upsert` - Save important context or decisions

## Task Creation Workflow

When user agrees on a task:

1. Call `create_planned_task` with:
   - `title`: Main task title
   - `forum_channel_id`: TO-DO forum channel ID
   - `context` (optional): repo, url, description

2. The orchestrator will:
   - Break down into subtasks automatically
   - Create forum thread
   - Create poll with subtasks
   - Return task/thread/poll IDs

No need to call `breakdown_task` separately - it's handled internally.
```

**Verify:**
- Skill documentation matches new flow
- Tools list is accurate
- Example usage is clear

**Done when:** Skill correctly describes orchestrated workflow

---

## Verification (Overall)

1. **Orchestrator Check:**
   ```bash
   npm run build
   ```
   Should compile with new orchestrator

2. **IPC Check:**
   - Agent can call `create_planned_task`
   - Returns structured result with IDs
   - Error messages are helpful

3. **End-to-End Check:**
   - Daily planning skill calls `create_planned_task`
   - Forum thread is created
   - Poll exists with subtasks
   - Task state is tracked

4. **Integration Check:**
   - Background sync updates poll completion
   - Task completion detection works
   - Forum archiving functions

## Success Criteria

- [ ] `DailyPlanningOrchestrator` class exists with workflow methods
- [ ] `createTaskWithBreakdown` creates task + thread + poll atomically
- [ ] IPC action `create_planned_task` works from agent
- [ ] Daily-planning skill documentation updated
- [ ] Full flow: breakdown -> forum -> poll -> state works

## Output

SUMMARY.md should contain:
- Orchestrator module created at `src/daily-planning-orchestrator.ts`
- IPC action `create_planned_task` added
- Daily-planning skill updated
- Example planning session output
