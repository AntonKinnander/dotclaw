import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { CronExpressionParser } from 'cron-parser';
import { getDueTasks, updateTaskAfterRun, logTaskRun, getTaskById, getAllTasks, updateTask, setGroupSession, logToolCalls } from './db.js';
import { ScheduledTask, RegisteredGroup } from './types.js';
import { GROUPS_DIR, SCHEDULER_POLL_INTERVAL, MAIN_GROUP_FOLDER, TIMEZONE } from './config.js';
import { runContainerAgent, writeTasksSnapshot } from './container-runner.js';
import { writeTrace } from './trace-writer.js';
import { withGroupLock } from './locks.js';
import { buildMemoryRecall, getMemoryStats } from './memory-store.js';
import { loadBehaviorConfig } from './behavior-config.js';
import { getEffectiveToolPolicy } from './tool-policy.js';
import { resolveModel } from './model-registry.js';
import { recordTaskRun, recordToolCall, recordLatency, recordError, recordMessage } from './metrics.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

export interface SchedulerDependencies {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  setSession: (groupFolder: string, sessionId: string) => void;
}

async function runTask(task: ScheduledTask, deps: SchedulerDependencies): Promise<void> {
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info({ taskId: task.id, group: task.group_folder }, 'Running scheduled task');
  recordMessage('scheduler');

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(g => g.folder === task.group_folder);

  if (!group) {
    logger.error({ taskId: task.id, groupFolder: task.group_folder }, 'Group not found for task');
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = task.group_folder === MAIN_GROUP_FOLDER;
  const tasks = getAllTasks();
  writeTasksSnapshot(task.group_folder, isMain, tasks.map(t => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run
  })));

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId = task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  const traceId = `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const traceTimestamp = new Date().toISOString();

  try {
    const memoryRecall = buildMemoryRecall({
      groupFolder: task.group_folder,
      userId: null,
      query: task.prompt,
      maxResults: 6,
      maxTokens: 800
    });
    const memoryStats = getMemoryStats({ groupFolder: task.group_folder, userId: null });
    const behaviorConfig = loadBehaviorConfig();
    const toolPolicy = getEffectiveToolPolicy({ groupFolder: task.group_folder, userId: null });
    const defaultModel = process.env.OPENROUTER_MODEL || 'moonshotai/kimi-k2.5';
    const resolvedModel = resolveModel({
      groupFolder: task.group_folder,
      userId: null,
      defaultModel
    });

    const output = await withGroupLock(task.group_folder, () =>
      runContainerAgent(group, {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        memoryRecall,
        userProfile: null,
        memoryStats,
        behaviorConfig: behaviorConfig as unknown as Record<string, unknown>,
        toolPolicy: toolPolicy as Record<string, unknown>,
        modelOverride: resolvedModel.model,
        modelContextTokens: resolvedModel.override?.context_window,
        modelMaxOutputTokens: resolvedModel.override?.max_output_tokens,
        modelTemperature: resolvedModel.override?.temperature
      })
    );

    if (output.newSessionId && task.context_mode === 'group') {
      deps.setSession(task.group_folder, output.newSessionId);
      setGroupSession(task.group_folder, output.newSessionId);
    }

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
      recordError('scheduler');
    } else {
      result = output.result;
    }

    if (output.latency_ms) {
      recordLatency(output.latency_ms);
    }

    writeTrace({
      trace_id: traceId,
      timestamp: traceTimestamp,
      created_at: Date.now(),
      chat_id: task.chat_jid,
      group_folder: task.group_folder,
      input_text: task.prompt,
      output_text: output.result ?? null,
      model_id: output.model || 'unknown',
      prompt_pack_versions: output.prompt_pack_versions,
      memory_summary: output.memory_summary,
      memory_facts: output.memory_facts,
      tool_calls: output.tool_calls,
      latency_ms: output.latency_ms,
      error_code: output.status === 'error' ? output.error : undefined,
      source: 'dotclaw-scheduler'
    });

    if (output.tool_calls && output.tool_calls.length > 0) {
      logToolCalls({
        traceId,
        chatJid: task.chat_jid,
        groupFolder: task.group_folder,
        toolCalls: output.tool_calls,
        source: 'scheduler'
      });
      for (const call of output.tool_calls) {
        recordToolCall(call.name, call.ok);
      }
    }

    logger.info({ taskId: task.id, durationMs: Date.now() - startTime }, 'Task completed');
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
    recordError('scheduler');

    writeTrace({
      trace_id: traceId,
      timestamp: traceTimestamp,
      created_at: Date.now(),
      chat_id: task.chat_jid,
      group_folder: task.group_folder,
      input_text: task.prompt,
      output_text: null,
      model_id: 'unknown',
      error_code: error,
      source: 'dotclaw-scheduler'
    });
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error
  });
  recordTaskRun(error ? 'error' : 'success');

  let nextRun: string | null = null;
  let scheduleError: string | null = null;
  if (task.schedule_type === 'cron') {
    try {
      const interval = CronExpressionParser.parse(task.schedule_value, { tz: TIMEZONE });
      nextRun = interval.next().toISOString();
    } catch (err) {
      scheduleError = `Invalid cron expression: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (isNaN(ms) || ms <= 0) {
      scheduleError = `Invalid interval: "${task.schedule_value}"`;
    } else {
      nextRun = new Date(Date.now() + ms).toISOString();
    }
  }
  // 'once' tasks have no next run

  if (scheduleError) {
    error = error ? `${error}; ${scheduleError}` : scheduleError;
  }

  const resultSummary = error ? `Error: ${error}` : (result ? result.slice(0, 200) : 'Completed');
  updateTaskAfterRun(task.id, nextRun, resultSummary);

  if (scheduleError) {
    updateTask(task.id, { status: 'paused', next_run: null });
  }
}

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        await runTask(currentTask, deps);
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}
