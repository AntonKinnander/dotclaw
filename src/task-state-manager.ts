/**
 * Task State Manager
 *
 * Unified state tracking and synchronization for daily tasks.
 * Manages background sync of Discord API state with the database.
 * Handles automatic task completion detection based on polls and reactions.
 */

import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { DATA_DIR } from './config.js';
import {
  getDailyTaskById,
  getActiveDailyTasks,
  updateDailyTask,
  updateDailyTaskPollData,
  archiveOldDailyTasks,
} from './db.js';
import type { PollChecklist } from './poll-manager.js';
import type { DiscordProvider } from './providers/discord/discord-provider.js';
import type { DailyTask } from './types.js';

/**
 * Task state snapshot stored on disk
 */
interface TaskStateSnapshot {
  version: 1;
  last_sync: string;
  tasks: Record<string, TaskStateEntry>;
}

/**
 * Individual task state entry
 */
interface TaskStateEntry {
  task_id: string;
  status: DailyTask['status'];
  poll_complete: boolean;
  last_sync: string;
  hash: string;  // Hash of poll data for change detection
}

/**
 * Result of syncing all active tasks
 */
export interface SyncAllResult {
  synced: number;
  completed: number;
  errors: string[];
}

/**
 * Tasks needing attention
 */
export interface TasksNeedingAttention {
  overdue: DailyTask[];
  readyToArchive: DailyTask[];
}

/**
 * Background sync configuration
 */
interface BackgroundSyncConfig {
  intervalMs: number;
  enabled: boolean;
}

const STATE_FILE = path.join(DATA_DIR, 'task-state-snapshot.json');
const DEFAULT_SYNC_INTERVAL = 60_000; // 1 minute
const ARCHIVE_AFTER_HOURS = 24;

/**
 * Compute a simple hash of an object for change detection
 */
function computeHash(obj: unknown): string {
  const str = JSON.stringify(obj);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Task State Manager class
 */
export class TaskStateManager {
  private discordProvider: DiscordProvider | null = null;
  private syncInterval: NodeJS.Timeout | null = null;
  private syncEnabled = false;
  private syncConfig: BackgroundSyncConfig = {
    intervalMs: DEFAULT_SYNC_INTERVAL,
    enabled: true,
  };

  constructor(discordProvider?: DiscordProvider) {
    this.discordProvider = discordProvider ?? null;
  }

  /**
   * Set or update the Discord provider reference
   */
  setDiscordProvider(provider: DiscordProvider | null): void {
    this.discordProvider = provider;
  }

  /**
   * Load the task state snapshot from disk
   */
  loadSnapshot(): TaskStateSnapshot {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const content = fs.readFileSync(STATE_FILE, 'utf-8');
        const snapshot = JSON.parse(content) as TaskStateSnapshot;
        // Validate structure
        if (snapshot.version === 1 && snapshot.tasks && typeof snapshot.tasks === 'object') {
          return snapshot;
        }
      }
    } catch (err) {
      logger.error({ err, stateFile: STATE_FILE }, 'Error loading task state snapshot');
    }
    // Return default snapshot
    return {
      version: 1,
      last_sync: new Date().toISOString(),
      tasks: {},
    };
  }

  /**
   * Save the task state snapshot to disk
   */
  private saveSnapshot(snapshot: TaskStateSnapshot): void {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify(snapshot, null, 2), 'utf-8');
    } catch (err) {
      logger.error({ err, stateFile: STATE_FILE }, 'Error saving task state snapshot');
    }
  }

  /**
   * Sync a single task from Discord API
   *
   * @param taskId - Task ID to sync
   * @returns Updated task state or null if task not found
   */
  async syncTaskState(taskId: string): Promise<TaskStateEntry | null> {
    const task = getDailyTaskById(taskId);
    if (!task) {
      logger.warn({ taskId }, 'Task not found for sync');
      return null;
    }

    // Skip tasks without Discord references
    if (!task.discord_channel_id || !task.discord_thread_id) {
      return {
        task_id: task.id,
        status: task.status as 'pending' | 'in_progress' | 'completed' | 'archived',
        poll_complete: false,
        last_sync: new Date().toISOString(),
        hash: computeHash(task.poll_data),
      };
    }

    try {
      let pollComplete = false;
      let updatedPollData: PollChecklist | null = null;

      // Fetch poll state if poll exists
      if (task.discord_poll_id && this.discordProvider) {
        const pollResults = await this.discordProvider.getPollResults(
          task.discord_thread_id,
          task.discord_poll_id
        );

        if (pollResults) {
          updatedPollData = {
            question: pollResults.question,
            answers: pollResults.answers.map(ans => ({
              id: ans.id,
              text: ans.text,
              checked: ans.voteCount > 0,
            })),
          };

          // Check if poll is complete (all answers have votes)
          pollComplete = pollResults.answers.every(ans => ans.voteCount > 0);
        }
      }

      // Check for completion reaction if poll not complete
      if (!pollComplete && this.discordProvider && task.discord_poll_id) {
        const reactions = await this.discordProvider.getReactions(
          task.discord_thread_id,
          task.discord_poll_id
        );
        const hasCheckmark = reactions.some(r => r.emoji === '✅' && r.count > 0);
        if (hasCheckmark) {
          pollComplete = true;
        }
      }

      // Update task status if poll is complete and task wasn't already complete
      if (pollComplete && task.status !== 'completed') {
        await this.markTaskComplete(taskId, 'poll');
      }

      // Update poll data in database if changed
      if (updatedPollData) {
        const newHash = computeHash(updatedPollData);
        const oldHash = computeHash(task.poll_data);
        if (newHash !== oldHash) {
          updateDailyTaskPollData(taskId, updatedPollData);
          logger.debug({ taskId, hash: newHash }, 'Updated poll data in database');
        }
      }

      const stateEntry: TaskStateEntry = {
        task_id: task.id,
        status: (pollComplete ? 'completed' : task.status) as 'pending' | 'in_progress' | 'completed' | 'archived',
        poll_complete: pollComplete,
        last_sync: new Date().toISOString(),
        hash: computeHash(updatedPollData || task.poll_data),
      };

      // Update snapshot
      this.updateSnapshotEntry(stateEntry);

      return stateEntry;
    } catch (err) {
      logger.error({ taskId, err }, 'Error syncing task state');
      return null;
    }
  }

  /**
   * Sync all active tasks (background job)
   *
   * @returns Sync result with counts and errors
   */
  async syncAllActiveTasks(): Promise<SyncAllResult> {
    const snapshot = this.loadSnapshot();
    const result: SyncAllResult = {
      synced: 0,
      completed: 0,
      errors: [],
    };

    try {
      // Get all active tasks (excluding archived)
      const allActiveTasks = getActiveDailyTasks('*');  // All groups
      logger.debug({ count: allActiveTasks.length }, 'Syncing all active tasks');

      for (const task of allActiveTasks) {
        try {
          // Skip tasks without Discord references
          if (!task.discord_channel_id || !task.discord_thread_id) {
            continue;
          }

          // Check if task needs sync (hash changed or not synced recently)
          const entry = snapshot.tasks[task.id];
          const currentHash = computeHash(task.poll_data);
          const needsSync = !entry ||
            entry.hash !== currentHash ||
            Date.now() - new Date(entry.last_sync).getTime() > this.syncConfig.intervalMs;

          if (!needsSync) {
            continue;
          }

          const synced = await this.syncTaskState(task.id);
          if (synced) {
            result.synced++;
            if (synced.status === 'completed' && task.status !== 'completed') {
              result.completed++;
            }
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          result.errors.push(`${task.id}: ${errorMsg}`);
        }
      }

      // Update snapshot timestamp
      snapshot.last_sync = new Date().toISOString();
      this.saveSnapshot(snapshot);

      if (result.synced > 0 || result.completed > 0 || result.errors.length > 0) {
        logger.info({
          synced: result.synced,
          completed: result.completed,
          errors: result.errors.length
        }, 'Task sync completed');
      }

      return result;
    } catch (err) {
      logger.error({ err }, 'Error in syncAllActiveTasks');
      return result;
    }
  }

  /**
   * Mark a task as complete
   *
   * @param taskId - Task ID to mark complete
   * @param source - Source of completion ('poll', 'reaction', or 'manual')
   */
  async markTaskComplete(taskId: string, source: 'poll' | 'reaction' | 'manual'): Promise<void> {
    try {
      const task = getDailyTaskById(taskId);
      if (!task) {
        logger.warn({ taskId }, 'Task not found for markTaskComplete');
        return;
      }

      if (task.status === 'completed') {
        return;  // Already complete
      }

      updateDailyTask(taskId, { status: 'completed' });

      logger.info({ taskId, source }, 'Marked task as complete');

      // Emit hook for task completion
      // TODO: Add hooks integration
    } catch (err) {
      logger.error({ taskId, source, err }, 'Error marking task complete');
    }
  }

  /**
   * Get tasks needing attention
   *
   * @param groupFolder - Group folder to filter by (optional)
   * @returns Tasks needing attention
   */
  async getTasksNeedingAttention(groupFolder?: string): Promise<TasksNeedingAttention> {
    const result: TasksNeedingAttention = {
      overdue: [],
      readyToArchive: [],
    };

    try {
      const now = new Date();
      const archiveCutoff = new Date(now.getTime() - ARCHIVE_AFTER_HOURS * 60 * 60 * 1000);

      const activeTasks = groupFolder
        ? getActiveDailyTasks(groupFolder)
        : getActiveDailyTasks('*');  // Get all if no folder specified

      for (const task of activeTasks) {
        if (groupFolder && task.group_folder !== groupFolder) {
          continue;
        }

        // Check if overdue (has due_date and it's past)
        if (task.due_date && new Date(task.due_date) < now) {
          result.overdue.push(task as DailyTask);
        }

        // Check if ready to archive (completed and older than cutoff)
        if (task.status === 'completed' && task.completed_at) {
          const completedAt = new Date(task.completed_at);
          if (completedAt < archiveCutoff) {
            result.readyToArchive.push(task as DailyTask);
          }
        }
      }

      return result;
    } catch (err) {
      logger.error({ groupFolder, err }, 'Error getting tasks needing attention');
      return result;
    }
  }

  /**
   * Update a single entry in the snapshot
   */
  private updateSnapshotEntry(entry: TaskStateEntry): void {
    const snapshot = this.loadSnapshot();
    snapshot.tasks[entry.task_id] = entry;
    snapshot.last_sync = new Date().toISOString();
    this.saveSnapshot(snapshot);
  }

  /**
   * Start the background sync loop
   *
   * @param intervalMs - Sync interval in milliseconds
   */
  startBackgroundSync(intervalMs?: number): void {
    if (this.syncInterval) {
      logger.warn('Background sync already running');
      return;
    }

    if (intervalMs) {
      this.syncConfig.intervalMs = intervalMs;
    }

    this.syncEnabled = true;

    const syncLoop = async () => {
      if (!this.syncEnabled) return;

      try {
        await this.syncAllActiveTasks();
      } catch (err) {
        logger.error({ err }, 'Error in background sync loop');
      }

      // Schedule next sync
      if (this.syncEnabled) {
        this.syncInterval = setTimeout(syncLoop, this.syncConfig.intervalMs);
      }
    };

    // Start the loop
    this.syncInterval = setTimeout(syncLoop, this.syncConfig.intervalMs);
    logger.info({ intervalMs: this.syncConfig.intervalMs }, 'Background sync started');
  }

  /**
   * Stop the background sync loop
   */
  stopBackgroundSync(): void {
    this.syncEnabled = false;
    if (this.syncInterval) {
      clearTimeout(this.syncInterval);
      this.syncInterval = null;
    }
    logger.info('Background sync stopped');
  }

  /**
   * Archive old tasks
   *
   * @param groupFolder - Group folder
   * @param olderThanDays - Age threshold in days (default: 30)
   */
  async archiveOldTasks(groupFolder: string, olderThanDays = 30): Promise<number> {
    try {
      const count = archiveOldDailyTasks(groupFolder, olderThanDays);
      logger.info({ groupFolder, olderThanDays, count }, 'Archived old tasks');
      return count;
    } catch (err) {
      logger.error({ groupFolder, olderThanDays, err }, 'Error archiving old tasks');
      return 0;
    }
  }
}

/**
 * Singleton instance
 */
let taskStateManagerInstance: TaskStateManager | null = null;

/**
 * Get the task state manager singleton
 */
export function getTaskStateManager(): TaskStateManager {
  if (!taskStateManagerInstance) {
    taskStateManagerInstance = new TaskStateManager();
  }
  return taskStateManagerInstance;
}

/**
 * Set the Discord provider for the task state manager
 */
export function setTaskStateManagerProvider(provider: DiscordProvider): void {
  getTaskStateManager().setDiscordProvider(provider);
}
