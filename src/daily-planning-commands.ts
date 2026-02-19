/**
 * Daily Planning Admin Command Handlers
 *
 * Implements admin commands for the daily planning workflow.
 * These commands are invoked via the /dotclaw command interface.
 */

import { logger } from './logger.js';
import { DATA_DIR, TIMEZONE } from './config.js';
import { getDailyTaskById, getActiveDailyTasks, updateDailyTask, getLatestDailyJournal, getDailyJournalByDate } from './db.js';
import { getRecapTrigger } from './recap-trigger.js';
import fs from 'fs';
import path from 'path';

/**
 * Workflow configuration structure
 */
interface WorkflowConfig {
  groups: Record<string, {
    recap_time: string;
    forum_channel_id: string;
    journal_forum_channel_id: string;
    auto_archive_hours: number;
    timezone: string;
  }>;
}

const WORKFLOW_CONFIG_PATH = path.join(DATA_DIR, 'workflow-config.json');

/**
 * Load workflow configuration
 */
export function loadWorkflowConfig(): WorkflowConfig {
  try {
    if (fs.existsSync(WORKFLOW_CONFIG_PATH)) {
      const content = fs.readFileSync(WORKFLOW_CONFIG_PATH, 'utf-8');
      return JSON.parse(content) as WorkflowConfig;
    }
  } catch (err) {
    logger.error({ err }, 'Error loading workflow config');
  }
  return { groups: {} };
}

/**
 * Save workflow configuration
 */
export function saveWorkflowConfig(config: WorkflowConfig): void {
  try {
    const dir = path.dirname(WORKFLOW_CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(WORKFLOW_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    logger.error({ err }, 'Error saving workflow config');
    throw err;
  }
}

/**
 * Handle /dotclaw schedule-recap <HH:MM> [timezone] command
 */
export async function handleScheduleRecap(args: string[], groupFolder: string): Promise<string> {
  const time = args[0];
  const timezone = args[1] || TIMEZONE;

  if (!time) {
    return 'Usage: /dotclaw schedule-recap <HH:MM> [timezone]\nExample: /dotclaw schedule-recap 22:00 America/New_York';
  }

  // Get forum channel ID from workflow config or require it
  const config = loadWorkflowConfig();
  const groupConfig = config.groups[groupFolder];
  const forumChannelId = groupConfig?.forum_channel_id;

  if (!forumChannelId) {
    return 'Error: forum_channel_id not configured. Use /dotclaw configure-workflow first.';
  }

  try {
    const recapTrigger = getRecapTrigger();
    const scheduled = recapTrigger.scheduleRecap({
      group_folder: groupFolder,
      timezone,
      recap_time: time,
      channel_id: forumChannelId,
      enabled: true,
    });

    return `✅ Scheduled nightly recap for ${time} ${timezone}\nNext run: ${scheduled.next_run}`;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return `❌ Error scheduling recap: ${errorMsg}`;
  }
}

/**
 * Handle /dotclaw show-schedule command
 */
export function handleShowSchedule(groupFolder: string): string {
  try {
    const recapTrigger = getRecapTrigger();
    const scheduled = recapTrigger.getScheduledRecap(groupFolder);

    if (!scheduled) {
      return 'No nightly recap is scheduled for this group.\nUse /dotclaw schedule-recap <HH:MM> to set one up.';
    }

    const config = loadWorkflowConfig();
    const groupConfig = config.groups[groupFolder];

    return `📅 Nightly Recap Schedule
Time: ${scheduled.recap_time} ${scheduled.timezone}
Next run: ${scheduled.next_run}
Status: Active

Forum Channel: ${groupConfig?.forum_channel_id || 'Not configured'}
Auto-archive: ${groupConfig?.auto_archive_hours || 24} hours`;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return `❌ Error: ${errorMsg}`;
  }
}

/**
 * Handle /dotclaw planning-status command
 */
export function handlePlanningStatus(groupFolder: string): string {
  try {
    const tasks = getActiveDailyTasks(groupFolder);
    const latestJournal = getLatestDailyJournal(groupFolder);

    const pending = tasks.filter(t => t.status === 'pending').length;
    const inProgress = tasks.filter(t => t.status === 'in_progress').length;
    const completed = tasks.filter(t => t.status === 'completed').length;

    let output = `📊 Daily Planning Status

**Tasks:**
⏳ Pending: ${pending}
🔄 In Progress: ${inProgress}
✅ Completed: ${completed}

`;

    if (tasks.length > 0) {
      output += '**Active Tasks:**\n';
      tasks.slice(0, 5).forEach(task => {
        const statusEmoji = task.status === 'completed' ? '✅' : task.status === 'in_progress' ? '🔄' : '⏳';
        output += `${statusEmoji} ${task.title}\n`;
      });
      if (tasks.length > 5) {
        output += `... and ${tasks.length - 5} more\n`;
      }
    }

    if (latestJournal) {
      output += `\n**Last Journal:** ${latestJournal.date}\n`;
      output += `Sentiment: ${latestJournal.sentiment}\n`;
      if (latestJournal.focus_tomorrow) {
        output += `Focus: ${latestJournal.focus_tomorrow}\n`;
      }
    } else {
      output += '\nNo journal entries yet.';
    }

    return output;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return `❌ Error: ${errorMsg}`;
  }
}

/**
 * Handle /dotclaw complete-task <id> command
 */
export async function handleCompleteTask(args: string[]): Promise<string> {
  const taskId = args[0];

  if (!taskId) {
    return 'Usage: /dotclaw complete-task <task_id>\nUse /dotclaw task-list to see task IDs.';
  }

  try {
    const task = getDailyTaskById(taskId);
    if (!task) {
      return `❌ Task not found: ${taskId}`;
    }

    if (task.status === 'completed') {
      return `✅ Task "${task.title}" is already complete.`;
    }

    updateDailyTask(taskId, { status: 'completed' });

    return `✅ Marked task as complete: ${task.title}`;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return `❌ Error: ${errorMsg}`;
  }
}

/**
 * Handle /dotclaw archive-task <id> command
 */
export async function handleArchiveTask(args: string[]): Promise<string> {
  const taskId = args[0];

  if (!taskId) {
    return 'Usage: /dotclaw archive-task <task_id>';
  }

  try {
    const task = getDailyTaskById(taskId);
    if (!task) {
      return `❌ Task not found: ${taskId}`;
    }

    updateDailyTask(taskId, { status: 'archived', archived_at: new Date().toISOString() });

    return `📦 Archived task: ${task.title}`;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return `❌ Error: ${errorMsg}`;
  }
}

/**
 * Handle /dotclaw show-journal [date] command
 */
export function handleShowJournal(args: string[], groupFolder: string): string {
  const dateArg = args[0];
  const date = dateArg || new Date().toISOString().split('T')[0];

  try {
    const journal = getDailyJournalByDate(groupFolder, date);

    if (!journal) {
      return `No journal entry found for ${date}.\nUse /dotclaw journal-list to see available dates.`;
    }

    const tasksCompleted = journal.tasks_completed ? JSON.parse(journal.tasks_completed) : [];
    const tasksInProgress = journal.tasks_in_progress ? JSON.parse(journal.tasks_in_progress) : [];

    let output = `📔 Journal Entry - ${journal.date}

**Sentiment:** ${journal.sentiment}
`;

    if (tasksCompleted.length > 0) {
      output += '\n✅ **Completed:**\n';
      tasksCompleted.forEach((t: string) => output += `  • ${t}\n`);
    }

    if (tasksInProgress.length > 0) {
      output += '\n🔄 **In Progress:**\n';
      tasksInProgress.forEach((t: string) => output += `  • ${t}\n`);
    }

    if (journal.biggest_success) {
      output += `\n🏆 **Biggest Success:**\n${journal.biggest_success}\n`;
    }

    if (journal.biggest_error) {
      output += `\n🐛 **Biggest Challenge:**\n${journal.biggest_error}\n`;
    }

    if (journal.focus_tomorrow) {
      output += `\n🎯 **Focus for Tomorrow:**\n${journal.focus_tomorrow}\n`;
    }

    if (journal.diary_entry) {
      output += `\n📝 **Notes:**\n${journal.diary_entry}\n`;
    }

    return output;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return `❌ Error: ${errorMsg}`;
  }
}

/**
 * Handle /dotclaw configure-workflow command
 */
export async function handleConfigureWorkflow(args: string[], groupFolder: string): Promise<string> {
  const subCommand = args[0]?.toLowerCase();

  const config = loadWorkflowConfig();
  if (!config.groups[groupFolder]) {
    config.groups[groupFolder] = {
      recap_time: '22:00',
      forum_channel_id: '',
      journal_forum_channel_id: '',
      auto_archive_hours: 24,
      timezone: TIMEZONE,
    };
  }

  switch (subCommand) {
    case 'forum': {
      const channelId = args[1];
      if (!channelId) {
        return 'Usage: /dotclaw configure-workflow forum <channel_id>\nSets the TO-DO forum channel for task threads.';
      }
      config.groups[groupFolder].forum_channel_id = channelId;
      saveWorkflowConfig(config);
      return `✅ Set TO-DO forum channel to: ${channelId}`;
    }

    case 'journal-forum': {
      const channelId = args[1];
      if (!channelId) {
        return 'Usage: /dotclaw configure-workflow journal-forum <channel_id>\nSets the Journal forum channel for daily journal entries.';
      }
      config.groups[groupFolder].journal_forum_channel_id = channelId;
      saveWorkflowConfig(config);
      return `✅ Set Journal forum channel to: ${channelId}`;
    }

    case 'recap-time': {
      const time = args[1];
      if (!time || !/^\d{1,2}:\d{2}$/.test(time)) {
        return 'Usage: /dotclaw configure-workflow recap-time <HH:MM>\nExample: /dotclaw configure-workflow recap-time 22:00';
      }
      config.groups[groupFolder].recap_time = time;
      saveWorkflowConfig(config);
      return `✅ Set recap time to: ${time}`;
    }

    case 'timezone': {
      const tz = args[1];
      if (!tz) {
        return 'Usage: /dotclaw configure-workflow timezone <timezone>\nExample: /dotclaw configure-workflow timezone America/New_York';
      }
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
      } catch {
        return `❌ Invalid timezone: ${tz}`;
      }
      config.groups[groupFolder].timezone = tz;
      saveWorkflowConfig(config);
      return `✅ Set timezone to: ${tz}`;
    }

    case 'auto-archive': {
      const hours = parseInt(args[1], 10);
      if (isNaN(hours) || hours < 1) {
        return 'Usage: /dotclaw configure-workflow auto-archive <hours>\nExample: /dotclaw configure-workflow auto-archive 24';
      }
      config.groups[groupFolder].auto_archive_hours = hours;
      saveWorkflowConfig(config);
      return `✅ Set auto-archive to: ${hours} hours`;
    }

    case 'show': {
      const groupConfig = config.groups[groupFolder];
      return `**Workflow Configuration for ${groupFolder}:**

TO-DO Forum Channel: ${groupConfig?.forum_channel_id || 'Not set'}
Journal Forum Channel: ${groupConfig?.journal_forum_channel_id || 'Not set'}
Recap Time: ${groupConfig?.recap_time || '22:00'}
Timezone: ${groupConfig?.timezone || TIMEZONE}
Auto-archive: ${groupConfig?.auto_archive_hours || 24} hours

To update:
/dotclaw configure-workflow forum <channel_id>
/dotclaw configure-workflow journal-forum <channel_id>
/dotclaw configure-workflow recap-time <HH:MM>
/dotclaw configure-workflow timezone <timezone>
/dotclaw configure-workflow auto-archive <hours>`;
    }

    default:
      return `**Workflow Configuration Commands:**

/dotclaw configure-workflow forum <channel_id>  - Set TO-DO forum channel
/dotclaw configure-workflow recap-time <HH:MM>  - Set nightly recap time
/dotclaw configure-workflow timezone <timezone>    - Set timezone
/dotclaw configure-workflow auto-archive <hours> - Set auto-archive delay
/dotclaw configure-workflow show                 - Show current config`;
  }
}

/**
 * Get all admin command handlers for daily planning
 */
export function getDailyPlanningCommandHandlers() {
  return {
    'schedule-recap': handleScheduleRecap,
    'show-schedule': handleShowSchedule,
    'planning-status': handlePlanningStatus,
    'complete-task': handleCompleteTask,
    'archive-task': handleArchiveTask,
    'show-journal': handleShowJournal,
    'configure-workflow': handleConfigureWorkflow,
    // Note: 'daily-plan' is handled directly in index.ts, not via command handlers
  };
}
