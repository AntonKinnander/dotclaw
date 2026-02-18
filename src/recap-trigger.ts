/**
 * Recap Trigger Module
 *
 * Manages nightly recap triggers using the task scheduler.
 * Schedules automated recap conversations for daily planning workflow.
 */

import { logger } from './logger.js';
import { createTask, getTaskById, updateTask } from './db.js';
import { generateId } from './id.js';
import { TIMEZONE } from './config.js';

/**
 * Recap configuration for a group
 */
export interface RecapConfig {
  group_folder: string;
  timezone: string;
  recap_time: string;  // HH:MM format (24-hour)
  channel_id: string;  // Discord channel ID for recap messages
  enabled: boolean;
}

/**
 * Scheduled recap info
 */
export interface ScheduledRecap {
  task_id: string;
  group_folder: string;
  timezone: string;
  recap_time: string;
  channel_id: string;
  next_run: string;
}

/**
 * Parse HH:MM time and convert to cron expression
 */
function timeToCron(time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`Invalid time format: ${time}. Use HH:MM (24-hour format).`);
  }
  return `${minutes} ${hours} * * *`;
}

/**
 * Validate timezone string
 */
function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Calculate next run time from cron expression
 */
function calculateNextRun(cronExpr: string, timezone: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CronExpressionParser } = require('cron-parser');
    const interval = CronExpressionParser.parse(cronExpr, { tz: timezone });
    return interval.next().toISOString();
  } catch (err) {
    throw new Error(`Invalid cron expression or timezone: ${err}`);
  }
}

/**
 * Recap Trigger class
 */
export class RecapTrigger {
  /**
   * Schedule a nightly recap for a group.
   * Uses the existing task scheduler infrastructure.
   *
   * @param config - Recap configuration
   * @returns Scheduled recap info
   */
  scheduleRecap(config: RecapConfig): ScheduledRecap {
    const {
      group_folder,
      timezone = TIMEZONE,
      recap_time,
      channel_id,
      enabled = true,
    } = config;

    // Validate inputs
    if (!isValidTimezone(timezone)) {
      throw new Error(`Invalid timezone: ${timezone}`);
    }

    const cronExpr = timeToCron(recap_time);

    // Check if recap task already exists for this group
    const existingTaskId = this.getRecapTaskId(group_folder);
    if (existingTaskId) {
      const existing = getTaskById(existingTaskId);
      if (existing) {
        // Update existing task
        updateTask(existingTaskId, {
          schedule_value: cronExpr,
          timezone,
          status: enabled ? 'active' : 'paused',
        });
        logger.info({ group_folder, recap_time }, 'Updated existing recap schedule');

        return {
          task_id: existingTaskId,
          group_folder,
          timezone,
          recap_time,
          channel_id,
          next_run: existing.next_run || calculateNextRun(cronExpr, timezone),
        };
      }
    }

    // Calculate next run time
    const nextRun = calculateNextRun(cronExpr, timezone);

    // Create new scheduled task
    const taskId = generateId('recap');
    const chatJid = `discord:${channel_id}`;

    createTask({
      id: taskId,
      group_folder,
      chat_jid: chatJid,
      prompt: `/recap ${group_folder}`,
      schedule_type: 'cron',
      schedule_value: cronExpr,
      timezone,
      context_mode: 'group',
      next_run: nextRun,
      status: enabled ? 'active' : 'paused',
      created_at: new Date().toISOString(),
    });

    logger.info({
      group_folder,
      recap_time,
      timezone,
      next_run: nextRun
    }, 'Scheduled nightly recap');

    return {
      task_id: taskId,
      group_folder,
      timezone,
      recap_time,
      channel_id,
      next_run: nextRun,
    };
  }

  /**
   * Trigger a recap immediately (for testing or manual trigger)
   *
   * @param groupFolder - Group folder
   */
  async triggerRecap(groupFolder: string): Promise<void> {
    logger.info({ group_folder: groupFolder }, 'Triggering manual recap');

    // The actual recap will be handled by the agent via the /recap skill
    // This method just logs the trigger - the actual work happens in the skill
  }

  /**
   * Pause recap for a group
   *
   * @param groupFolder - Group folder
   * @returns True if paused successfully
   */
  pauseRecap(groupFolder: string): boolean {
    const taskId = this.getRecapTaskId(groupFolder);
    if (!taskId) {
      logger.warn({ group_folder: groupFolder }, 'No recap task found to pause');
      return false;
    }

    updateTask(taskId, { status: 'paused' });
    logger.info({ group_folder: groupFolder, task_id: taskId }, 'Paused nightly recap');
    return true;
  }

  /**
   * Resume recap for a group
   *
   * @param groupFolder - Group folder
   * @returns True if resumed successfully
   */
  resumeRecap(groupFolder: string): boolean {
    const taskId = this.getRecapTaskId(groupFolder);
    if (!taskId) {
      logger.warn({ group_folder: groupFolder }, 'No recap task found to resume');
      return false;
    }

    updateTask(taskId, { status: 'active' });
    logger.info({ group_folder: groupFolder, task_id: taskId }, 'Resumed nightly recap');
    return true;
  }

  /**
   * Remove recap schedule for a group
   *
   * @param groupFolder - Group folder
   * @returns True if removed successfully
   */
  removeRecap(groupFolder: string): boolean {
    const taskId = this.getRecapTaskId(groupFolder);
    if (!taskId) {
      return false;
    }

    // Delete the task using db function
    const { deleteTask } = require('./db.js');
    deleteTask(taskId);

    logger.info({ group_folder: groupFolder, task_id: taskId }, 'Removed nightly recap');
    return true;
  }

  /**
   * Get the task ID for a group's recap
   *
   * @param groupFolder - Group folder
   * @returns Task ID or null
   */
  getRecapTaskId(groupFolder: string): string | null {
    // Get all tasks and find the recap task
    const { getAllTasks } = require('./db.js');
    const tasks = getAllTasks();
    const recapTask = tasks.find((t: { group_folder: string; prompt?: string; schedule_type: string }) =>
      t.group_folder === groupFolder &&
      t.prompt?.startsWith('/recap') &&
      t.schedule_type === 'cron'
    );
    return recapTask?.id || null;
  }

  /**
   * Get scheduled recap info for a group
   *
   * @param groupFolder - Group folder
   * @returns Scheduled recap info or null
   */
  getScheduledRecap(groupFolder: string): ScheduledRecap | null {
    const taskId = this.getRecapTaskId(groupFolder);
    if (!taskId) {
      return null;
    }

    const task = getTaskById(taskId);
    if (!task) {
      return null;
    }

    // Extract time from cron expression (format: "MM HH * * *")
    const cronMatch = task.schedule_value?.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+\*\*$/);
    let recapTime = '22:00';  // Default
    if (cronMatch) {
      const [, minutes, hours] = cronMatch;
      recapTime = `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
    }

    // Extract channel ID from chat_jid (format: "discord:CHANNEL_ID")
    const channelId = task.chat_jid?.replace('discord:', '') || '';

    return {
      task_id: task.id,
      group_folder: task.group_folder,
      timezone: task.timezone || TIMEZONE,
      recap_time: recapTime,
      channel_id: channelId,
      next_run: task.next_run || '',
    };
  }

  /**
   * List all scheduled recaps
   *
   * @returns Array of scheduled recap info
   */
  listScheduledRecaps(): ScheduledRecap[] {
    const { getAllTasks } = require('./db.js');
    const tasks = getAllTasks();

    return tasks
      .filter((t: { prompt?: string; schedule_type: string }) => t.prompt?.startsWith('/recap') && t.schedule_type === 'cron')
      .map((task: { id: string; group_folder: string; schedule_value?: string; timezone?: string | null; chat_jid?: string; next_run?: string | null }) => {
        // Extract time from cron expression
        const cronMatch = task.schedule_value?.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+\*\*$/);
        let recapTime = '22:00';
        if (cronMatch) {
          const [, minutes, hours] = cronMatch;
          recapTime = `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
        }

        const channelId = task.chat_jid?.replace('discord:', '') || '';

        return {
          task_id: task.id,
          group_folder: task.group_folder,
          timezone: task.timezone || TIMEZONE,
          recap_time: recapTime,
          channel_id: channelId,
          next_run: task.next_run || '',
        };
      });
  }
}

/**
 * Singleton instance
 */
let recapTriggerInstance: RecapTrigger | null = null;

/**
 * Get the recap trigger singleton
 */
export function getRecapTrigger(): RecapTrigger {
  if (!recapTriggerInstance) {
    recapTriggerInstance = new RecapTrigger();
  }
  return recapTriggerInstance;
}
