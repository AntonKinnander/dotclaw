/**
 * Daily Planning Orchestrator
 *
 * Coordinates the daily planning workflow:
 * 1. Task breakdown via agent (breakdown_task IPC)
 * 2. Forum thread creation
 * 3. Poll creation with subtasks
 * 4. Task state management
 *
 * This bridges the gap between the daily-planning skill and the existing
 * infrastructure (breakdown, forum manager, poll manager, task state manager).
 */

import { logger } from './logger.js';
import type { DiscordProvider } from './providers/discord/discord-provider.js';
import {
  createDailyTask,
  setDailyTaskDiscordRefs,
} from './db.js';
import { getPollManager } from './poll-manager.js';
import type { Subtask } from './task-breakdown.js';
import { executeAgentRun } from './agent-execution.js';
import { parseSubtasks } from './task-breakdown.js';

/**
 * Input for a single task in a planning session
 */
export interface TaskInput {
  title: string;
  description?: string;
  priority?: number;
  due_date?: string;
  context?: {
    repo?: string;
    url?: string;
    calendar_link?: string;
    description?: string;
  };
}

/**
 * A daily planning session configuration
 */
export interface PlanningSession {
  group_folder: string;
  forum_channel_id: string;
  tasks: TaskInput[];
}

/**
 * Result of creating a single task
 */
export interface TaskCreationResult {
  task_id: string;
  thread_id: string;
  poll_id: string | null;
  subtask_count: number;
}

/**
 * Overall planning session result
 */
export interface PlanningResult {
  success: boolean;
  tasks_created: TaskCreationResult[];
  errors: string[];
}

/**
 * Result of task breakdown
 */
interface BreakdownOutput {
  main_task: string;
  subtasks: Subtask[];
}

/**
 * Dependencies for the orchestrator
 */
export interface OrchestratorDeps {
  registeredGroups: () => Record<string, import('./types.js').RegisteredGroup>;
  sessions: () => import('./types.js').Session;
  setSession: (folder: string, id: string) => void;
}

/**
 * Daily Planning Orchestrator class
 *
 * Orchestrates the creation of planned tasks with automatic breakdown,
 * forum thread creation, and poll creation.
 */
export class DailyPlanningOrchestrator {
  constructor(
    private readonly discordProvider: DiscordProvider,
    private readonly deps: OrchestratorDeps
  ) {}

  /**
   * Run a daily planning session for multiple tasks.
   *
   * @param session - Planning session configuration
   * @returns Planning result with created tasks and any errors
   */
  async runPlanningSession(session: PlanningSession): Promise<PlanningResult> {
    const result: PlanningResult = {
      success: true,
      tasks_created: [],
      errors: [],
    };

    for (const task of session.tasks) {
      try {
        const taskResult = await this.createTaskWithBreakdown(
          session.group_folder,
          task.title,
          session.forum_channel_id,
          {
            description: task.description,
            priority: task.priority,
            due_date: task.due_date,
            ...task.context,
          }
        );

        if (taskResult) {
          result.tasks_created.push({
            task_id: taskResult.task_id,
            thread_id: taskResult.thread_id,
            poll_id: taskResult.poll_id,
            subtask_count: taskResult.subtasks.length,
          });
        } else {
          result.success = false;
          result.errors.push(`Failed to create task: ${task.title}`);
        }
      } catch (err) {
        result.success = false;
        const errorMsg = err instanceof Error ? err.message : String(err);
        result.errors.push(`${task.title}: ${errorMsg}`);
        logger.error({ task: task.title, err }, 'Error in planning session');
      }
    }

    return result;
  }

  /**
   * Create a single task with automatic breakdown.
   *
   * Workflow:
   * 1. Call breakdown_task via IPC (or execute agent directly)
   * 2. Create daily task in database
   * 3. Create forum thread via Discord provider
   * 4. Create poll with subtasks
   * 5. Update Discord references
   *
   * @param groupFolder - Group folder for the task
   * @param mainTask - Main task title
   * @param forumChannelId - Discord forum channel ID
   * @param context - Optional context for task breakdown
   * @returns Task creation result or null if failed
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
  } | null> {
    try {
      // Step 1: Break down the task
      const breakdownResult = await this.breakdownTask(mainTask, context, groupFolder);
      if (!breakdownResult || breakdownResult.subtasks.length === 0) {
        logger.warn({ mainTask }, 'No subtasks generated for task');
        // Continue with empty subtasks - still create the thread
      }

      const subtaskTitles = breakdownResult?.subtasks.map(s => s.title) ?? [];

      // Step 2: Create daily task in database
      const taskId = createDailyTask({
        group_folder: groupFolder,
        title: mainTask,
        description: typeof context?.description === 'string' ? context.description : undefined,
        due_date: typeof context?.due_date === 'string' ? context.due_date : undefined,
        priority: typeof context?.priority === 'number' ? context.priority : 0,
      });

      logger.debug({ taskId, mainTask, subtaskCount: subtaskTitles.length }, 'Created daily task');

      // Step 3: Create forum thread via Discord provider
      const threadResult = await this.discordProvider.createForumThread(
        forumChannelId,
        mainTask,
        `Task thread with ${subtaskTitles.length} subtask${subtaskTitles.length !== 1 ? 's' : ''}`,
        []
      );

      if (!threadResult.success || !threadResult.threadId) {
        logger.error({ taskId, forumChannelId }, 'Failed to create forum thread');
        return null;
      }

      logger.info({ taskId, threadId: threadResult.threadId }, 'Created forum thread');

      // Step 4: Create poll with subtasks
      let pollId: string | null = null;
      if (subtaskTitles.length > 0) {
        const pollManager = getPollManager();
        pollManager.setDiscordProvider(this.discordProvider);

        const pollResult = await pollManager.createTaskPoll(
          taskId,
          mainTask,
          subtaskTitles,
          forumChannelId,
          threadResult.threadId,
          {
            duration: 24,
            allowMultiselect: true,
          }
        );

        pollId = pollResult.pollId ?? null;

        if (pollId) {
          logger.info({ taskId, pollId }, 'Created task poll');
        }
      }

      // Step 5: Update Discord references
      setDailyTaskDiscordRefs(taskId, forumChannelId, threadResult.threadId, pollId);

      return {
        task_id: taskId,
        thread_id: threadResult.threadId,
        poll_id: pollId,
        subtasks: subtaskTitles,
      };
    } catch (err) {
      logger.error({ mainTask, groupFolder, err }, 'Error creating task with breakdown');
      return null;
    }
  }

  /**
   * Break down a task into subtasks using the agent.
   *
   * @param mainTask - Main task title
   * @param context - Optional context for breakdown
   * @param groupFolder - Group folder to use for the agent run
   * @returns Breakdown result or null if failed
   */
  private async breakdownTask(
    mainTask: string,
    context?: Record<string, unknown>,
    groupFolder?: string
  ): Promise<BreakdownOutput | null> {
    try {
      // Build prompt for the agent
      let prompt = `Break down this task into atomic subtasks (max 10):\n\n"${mainTask}"`;

      const ctx = context as {
        repo?: string;
        url?: string;
        calendar_link?: string;
        description?: string;
      } | undefined;

      if (ctx?.description) {
        prompt += `\n\nContext: ${ctx.description}`;
      }
      if (ctx?.repo) {
        prompt += `\n\nRepository: ${ctx.repo}`;
      }
      if (ctx?.url) {
        prompt += `\n\nURL: ${ctx.url}`;
      }

      prompt += `\n\nReturn a JSON array of subtask strings. Each subtask should:
- Start with an emoji (🔧 for fix, ✨ for feature, 📝 for doc, etc.)
- Be max 55 characters
- Be atomic and actionable

Example format: ["🔍 Reproduce bug", "🐛 Find root cause", "💻 Write fix"]`;

      // Get the registered group for execution
      // Use the provided group folder or find the main group
      const registeredGroups = this.deps.registeredGroups();
      const groups = Object.entries(registeredGroups).map(([chatId, group]) => ({
        chatId,
        ...group,
      }));

      let targetGroup = groups.find(g => g.folder === groupFolder);
      if (!targetGroup) {
        targetGroup = groups.find(g => g.folder === 'main') ?? groups[0];
      }

      if (!targetGroup) {
        logger.warn('No registered group found for breakdown');
        return null;
      }

      // Execute agent run with task-breakdown skill
      const { output } = await executeAgentRun({
        group: {
          name: targetGroup.name,
          folder: targetGroup.folder,
          trigger: targetGroup.trigger,
          added_at: targetGroup.added_at,
          containerConfig: targetGroup.containerConfig,
        },
        prompt,
        chatJid: targetGroup.chatId,
        recallQuery: prompt,
        recallMaxResults: 4,
        recallMaxTokens: 1000,
        maxToolSteps: 20,
        timeoutMs: 120_000,
        useSemaphore: true,
        useGroupLock: false,
        persistSession: false,
        isScheduledTask: true,
        lane: 'scheduled',
        defaultSkill: 'task-breakdown',
      });

      // Parse the output
      const subtasks = parseSubtasks(output.result ?? '[]');

      if (subtasks.length === 0) {
        logger.warn({ mainTask, output: output.result }, 'No valid subtasks parsed');
        return null;
      }

      // Validate subtask count
      if (subtasks.length > 10) {
        logger.warn({ mainTask, count: subtasks.length }, 'Too many subtasks generated');
        // Truncate to 10
        subtasks.length = 10;
      }

      return {
        main_task: mainTask,
        subtasks,
      };
    } catch (err) {
      logger.error({ mainTask, err }, 'Error breaking down task');
      return null;
    }
  }
}

/**
 * Singleton instance
 */
let orchestratorInstance: DailyPlanningOrchestrator | null = null;

/**
 * Get or create the daily planning orchestrator singleton
 */
export function getDailyPlanningOrchestrator(
  discordProvider: DiscordProvider,
  deps: OrchestratorDeps
): DailyPlanningOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new DailyPlanningOrchestrator(discordProvider, deps);
  }
  return orchestratorInstance;
}

/**
 * Reset the orchestrator instance (for testing)
 */
export function resetDailyPlanningOrchestrator(): void {
  orchestratorInstance = null;
}
