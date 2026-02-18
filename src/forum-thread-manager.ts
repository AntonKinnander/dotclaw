import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { DATA_DIR } from './config.js';

/**
 * Configuration for the forum thread manager
 */
export interface ForumThreadConfig {
  group_folder: string;
  forum_channel_id: string;  // The TO-DO forum channel
}

/**
 * Represents a task thread mapping
 */
export interface TaskThread {
  task_id: string;
  channel_id: string;
  thread_id: string;
  title: string;
  created_at: string;
  archived_at: string | null;
}

/**
 * Thread state persistence format
 */
interface ThreadState {
  threads: Record<string, TaskThread>;  // task_id -> TaskThread
  last_archived_check: string;
}

const STATE_FILE = path.join(DATA_DIR, 'task-threads.json');
const ARCHIVE_AFTER_HOURS = 24;

/**
 * Load thread state from disk
 */
export function loadThreadState(): ThreadState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const content = fs.readFileSync(STATE_FILE, 'utf-8');
      const state = JSON.parse(content) as ThreadState;
      // Validate structure
      if (!state.threads || typeof state.threads !== 'object') {
        logger.warn({ stateFile: STATE_FILE }, 'Invalid thread state format, resetting');
        return { threads: {}, last_archived_check: new Date().toISOString() };
      }
      return state;
    }
  } catch (err) {
    logger.error({ err, stateFile: STATE_FILE }, 'Error loading thread state');
  }
  // Return default state if file doesn't exist or is invalid
  return { threads: {}, last_archived_check: new Date().toISOString() };
}

/**
 * Save thread state to disk
 */
export function saveThreadState(state: ThreadState): void {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    logger.error({ err, stateFile: STATE_FILE }, 'Error saving thread state');
  }
}

/**
 * Update a single thread in the state
 */
export function updateThreadState(taskId: string, thread: TaskThread): void {
  const state = loadThreadState();
  state.threads[taskId] = thread;
  saveThreadState(state);
}

/**
 * Remove a thread from the state
 */
export function removeThreadState(taskId: string): void {
  const state = loadThreadState();
  delete state.threads[taskId];
  saveThreadState(state);
}

/**
 * Forum Thread Manager
 * Manages Discord forum threads for tasks, including creation, archival, and state tracking.
 */
export class ForumThreadManager {
  constructor(_config: ForumThreadConfig) {}

  /**
   * Create a new thread for a task
   * @param task - The task to create a thread for
   * @param forumChannelId - The ID of the forum channel
   * @param createThreadFn - Function to actually create the thread in Discord
   * @returns The created task thread
   */
  async createTaskThread(
    task: { id: string; title: string; content?: string },
    forumChannelId: string,
    createThreadFn: (title: string, content: string) => Promise<{ threadId: string } | null>
  ): Promise<TaskThread | null> {
    try {
      const title = task.title || `Task: ${task.id}`;
      const content = task.content || `Task thread for ${task.id}`;

      // Call the Discord provider to create the thread
      const result = await createThreadFn(title, content);
      if (!result) {
        logger.error({ taskId: task.id }, 'Failed to create forum thread');
        return null;
      }

      const thread: TaskThread = {
        task_id: task.id,
        channel_id: forumChannelId,
        thread_id: result.threadId,
        title,
        created_at: new Date().toISOString(),
        archived_at: null,
      };

      // Update state
      updateThreadState(task.id, thread);

      logger.info({ taskId: task.id, threadId: result.threadId }, 'Created forum thread for task');
      return thread;
    } catch (err) {
      logger.error({ err, taskId: task.id }, 'Error creating task thread');
      return null;
    }
  }

  /**
   * Archive a specific task thread
   * @param threadId - The ID of the thread to archive
   * @param archiveThreadFn - Function to actually archive the thread in Discord
   */
  async archiveThread(
    threadId: string,
    archiveThreadFn: (threadId: string) => Promise<void>
  ): Promise<void> {
    try {
      await archiveThreadFn(threadId);

      // Update state
      const state = loadThreadState();
      for (const [taskId, thread] of Object.entries(state.threads)) {
        if (thread.thread_id === threadId) {
          thread.archived_at = new Date().toISOString();
          state.threads[taskId] = thread;
          break;
        }
      }
      saveThreadState(state);

      logger.info({ threadId }, 'Archived forum thread');
    } catch (err) {
      logger.error({ err, threadId }, 'Error archiving thread');
    }
  }

  /**
   * Lock a specific task thread (prevent new replies)
   * @param threadId - The ID of the thread to lock
   * @param lockThreadFn - Function to actually lock the thread in Discord
   */
  async lockThread(
    threadId: string,
    lockThreadFn: (threadId: string) => Promise<void>
  ): Promise<void> {
    try {
      await lockThreadFn(threadId);
      logger.info({ threadId }, 'Locked forum thread');
    } catch (err) {
      logger.error({ err, threadId }, 'Error locking thread');
    }
  }

  /**
   * Archive threads older than 24 hours
   * @param archiveThreadFn - Function to actually archive the thread in Discord
   * @returns Number of threads archived
   */
  async archiveOldThreads(
    archiveThreadFn: (threadId: string) => Promise<void>
  ): Promise<number> {
    try {
      const state = loadThreadState();
      const cutoff = new Date(Date.now() - ARCHIVE_AFTER_HOURS * 60 * 60 * 1000);
      let archivedCount = 0;

      for (const [taskId, thread] of Object.entries(state.threads)) {
        // Skip already archived threads
        if (thread.archived_at !== null) {
          continue;
        }

        const createdAt = new Date(thread.created_at);
        if (createdAt < cutoff) {
          await archiveThreadFn(thread.thread_id);
          thread.archived_at = new Date().toISOString();
          state.threads[taskId] = thread;
          archivedCount++;
        }
      }

      // Update last archived check time
      state.last_archived_check = new Date().toISOString();
      saveThreadState(state);

      if (archivedCount > 0) {
        logger.info({ count: archivedCount }, 'Archived old forum threads');
      }

      return archivedCount;
    } catch (err) {
      logger.error({ err }, 'Error archiving old threads');
      return 0;
    }
  }

  /**
   * Get thread info for a specific task
   * @param taskId - The ID of the task
   * @returns The task thread or null if not found
   */
  getTaskThread(taskId: string): TaskThread | null {
    const state = loadThreadState();
    return state.threads[taskId] || null;
  }

  /**
   * Get all threads for a channel
   * @param channelId - The ID of the channel
   * @returns Array of task threads
   */
  getThreadsForChannel(channelId: string): TaskThread[] {
    const state = loadThreadState();
    return Object.values(state.threads).filter(t => t.channel_id === channelId);
  }

  /**
   * Get all active (non-archived) threads
   * @returns Array of active task threads
   */
  getActiveThreads(): TaskThread[] {
    const state = loadThreadState();
    return Object.values(state.threads).filter(t => t.archived_at === null);
  }

  /**
   * Update thread status
   * @param taskId - The ID of the task
   * @param status - The new status ('locked' or 'archived')
   * @param updateThreadFn - Function to actually update the thread in Discord
   */
  async updateThreadStatus(
    taskId: string,
    status: 'locked' | 'archived',
    updateThreadFn: (threadId: string, status: 'locked' | 'archived') => Promise<void>
  ): Promise<void> {
    try {
      const thread = this.getTaskThread(taskId);
      if (!thread) {
        logger.warn({ taskId }, 'Thread not found for status update');
        return;
      }

      await updateThreadFn(thread.thread_id, status);

      // Update state if archiving
      if (status === 'archived') {
        const state = loadThreadState();
        if (state.threads[taskId]) {
          state.threads[taskId].archived_at = new Date().toISOString();
          saveThreadState(state);
        }
      }

      logger.info({ taskId, status }, 'Updated thread status');
    } catch (err) {
      logger.error({ err, taskId, status }, 'Error updating thread status');
    }
  }

  /**
   * Delete a thread from state (doesn't delete from Discord)
   * @param taskId - The ID of the task
   */
  deleteThread(taskId: string): void {
    removeThreadState(taskId);
    logger.info({ taskId }, 'Deleted thread from state');
  }

  /**
   * Get the last archived check timestamp
   * @returns ISO timestamp of last check
   */
  getLastArchivedCheck(): string {
    const state = loadThreadState();
    return state.last_archived_check;
  }
}

/**
 * Create a forum thread manager instance
 */
export function createForumThreadManager(config: ForumThreadConfig): ForumThreadManager {
  return new ForumThreadManager(config);
}
