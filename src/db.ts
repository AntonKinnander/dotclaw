import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import {
  NewMessage,
  MessageAttachment,
  ScheduledTask,
  TaskRunLog,
  QueuedMessage
} from './types.js';
import { STORE_DIR } from './config.js';
import { generateId } from './id.js';

let dbInstance: Database.Database | null = null;
let dbInitialized = false;

function getDb(): Database.Database {
  if (!dbInitialized || !dbInstance) {
    initDatabase();
  }
  if (!dbInstance) {
    throw new Error('Database is not initialized');
  }
  return dbInstance;
}

const db: Database.Database = new Proxy({} as Database.Database, {
  get(_target, prop) {
    const instance = getDb() as unknown as Record<string, unknown>;
    const value = instance[prop as keyof typeof instance];
    if (typeof value === 'function') {
      return (value as (...args: unknown[]) => unknown).bind(instance);
    }
    return value;
  }
});

export function closeDatabase(): void {
  if (!dbInstance || !dbInitialized) return;
  dbInstance.close();
  dbInstance = null;
  dbInitialized = false;
}

export function initDatabase(): void {
  if (dbInitialized && dbInstance) return;
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const database = new Database(dbPath);
  dbInstance = database;
  dbInitialized = true;
  try {
    database.pragma('journal_mode = WAL');
    database.pragma('busy_timeout = 3000');
    database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      attachments_json TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      timezone TEXT,
      context_mode TEXT DEFAULT 'isolated',
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      state_json TEXT,
      retry_count INTEGER DEFAULT 0,
      last_error TEXT,
      running_since TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS background_jobs (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      context_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      timeout_ms INTEGER,
      max_tool_steps INTEGER,
      tool_policy_json TEXT,
      model_override TEXT,
      priority INTEGER DEFAULT 0,
      tags TEXT,
      parent_trace_id TEXT,
      parent_message_id TEXT,
      result_summary TEXT,
      output_path TEXT,
      output_truncated INTEGER DEFAULT 0,
      last_error TEXT,
      lease_expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_background_jobs_status ON background_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_background_jobs_group ON background_jobs(group_folder, created_at);

    CREATE TABLE IF NOT EXISTS background_job_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result_summary TEXT,
      error TEXT,
      FOREIGN KEY (job_id) REFERENCES background_jobs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_background_job_runs ON background_job_runs(job_id, run_at);

    CREATE TABLE IF NOT EXISTS background_job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      data_json TEXT,
      FOREIGN KEY (job_id) REFERENCES background_jobs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_background_job_events ON background_job_events(job_id, created_at);

    CREATE TABLE IF NOT EXISTS chat_state (
      chat_jid TEXT PRIMARY KEY,
      last_agent_timestamp TEXT,
      last_agent_message_id TEXT
    );

    CREATE TABLE IF NOT EXISTS group_sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT,
      chat_jid TEXT,
      group_folder TEXT,
      user_id TEXT,
      tool_name TEXT NOT NULL,
      ok INTEGER NOT NULL,
      duration_ms INTEGER,
      error TEXT,
      created_at TEXT NOT NULL,
      source TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tool_audit_trace ON tool_audit(trace_id);
    CREATE INDEX IF NOT EXISTS idx_tool_audit_group ON tool_audit(group_folder, created_at);

    CREATE TABLE IF NOT EXISTS user_feedback (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      message_id TEXT,
      chat_jid TEXT,
      feedback_type TEXT NOT NULL,
      user_id TEXT,
      reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_trace ON user_feedback(trace_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_chat ON user_feedback(chat_jid, created_at);

    CREATE TABLE IF NOT EXISTS message_traces (
      message_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (message_id, chat_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_message_traces ON message_traces(trace_id);

    CREATE TABLE IF NOT EXISTS message_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      is_group INTEGER NOT NULL DEFAULT 0,
      chat_type TEXT NOT NULL DEFAULT 'private',
      message_thread_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_mq_chat_status ON message_queue(chat_jid, status);
  `);

    // Chat JID prefix migration: add 'telegram:' prefix to all existing unprefixed IDs
    migrateChatJidPrefixes();

    // Channel context migration: add columns for Discord channel context
    migrateChannelContext();

    // Daily planning system migration: add tables for journals, tasks, and briefings
    migrateDailyPlanning();
  } catch (err) {
    dbInitialized = false;
    if (dbInstance) {
      try { dbInstance.close(); } catch { /* ignore */ }
    }
    dbInstance = null;
    throw err;
  }
}

function migrateChatJidPrefixes(): void {
  // Create migration metadata table if needed
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (key TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);

  const row = db.prepare(`SELECT key FROM _migrations WHERE key = 'chat_jid_prefix_v1'`).get();
  if (row) return; // Already migrated

  // Check if there are any unprefixed chat IDs (IDs that don't contain ':')
  const unprefixed = db.prepare(`SELECT COUNT(*) as cnt FROM chats WHERE jid NOT LIKE '%:%'`).get() as { cnt: number };
  if (unprefixed.cnt === 0) {
    // No unprefixed IDs — mark as done and skip
    db.prepare(`INSERT INTO _migrations (key, applied_at) VALUES (?, ?)`).run('chat_jid_prefix_v1', new Date().toISOString());
    return;
  }

  // Disable FK checks during migration — we're updating both parent (chats.jid)
  // and child (messages.chat_jid) tables, and SQLite enforces FKs per-statement.
  db.pragma('foreign_keys = OFF');
  const migrate = db.transaction(() => {
    // Prefix all tables with chat_jid / jid columns
    db.exec(`UPDATE chats SET jid = 'telegram:' || jid WHERE jid NOT LIKE '%:%'`);
    db.exec(`UPDATE messages SET chat_jid = 'telegram:' || chat_jid WHERE chat_jid NOT LIKE '%:%'`);
    db.exec(`UPDATE chat_state SET chat_jid = 'telegram:' || chat_jid WHERE chat_jid NOT LIKE '%:%'`);
    db.exec(`UPDATE message_queue SET chat_jid = 'telegram:' || chat_jid WHERE chat_jid NOT LIKE '%:%'`);
    db.exec(`UPDATE scheduled_tasks SET chat_jid = 'telegram:' || chat_jid WHERE chat_jid NOT LIKE '%:%'`);
    db.exec(`UPDATE background_jobs SET chat_jid = 'telegram:' || chat_jid WHERE chat_jid NOT LIKE '%:%'`);
    db.exec(`UPDATE tool_audit SET chat_jid = 'telegram:' || chat_jid WHERE chat_jid IS NOT NULL AND chat_jid NOT LIKE '%:%'`);
    db.exec(`UPDATE user_feedback SET chat_jid = 'telegram:' || chat_jid WHERE chat_jid IS NOT NULL AND chat_jid NOT LIKE '%:%'`);
    db.exec(`UPDATE message_traces SET chat_jid = 'telegram:' || chat_jid WHERE chat_jid NOT LIKE '%:%'`);

    db.prepare(`INSERT INTO _migrations (key, applied_at) VALUES (?, ?)`).run('chat_jid_prefix_v1', new Date().toISOString());
  });

  try {
    migrate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function migrateChannelContext(): void {
  // Create migration metadata table if needed
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (key TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);

  const row = db.prepare(`SELECT key FROM _migrations WHERE key = 'channel_context_v1'`).get();
  if (row) return; // Already migrated

  // Add new columns to message_queue table for channel context
  // Using ALTER TABLE with IF NOT EXISTS logic (SQLite 3.35.0+)
  const columns = [
    'channel_name TEXT',
    'channel_description TEXT',
    'channel_config_type TEXT',
    'channel_type TEXT',
    'default_skill TEXT',
    'parent_id TEXT',
    'is_forum_thread INTEGER DEFAULT 0'
  ];

  // Get existing columns
  const existingColumns = db.prepare(`PRAGMA table_info(message_queue)`).all() as Array<{ name: string }>;
  const existingColumnNames = new Set(existingColumns.map(c => c.name));

  for (const column of columns) {
    const columnName = column.split(' ')[0];
    if (!existingColumnNames.has(columnName)) {
      try {
        db.exec(`ALTER TABLE message_queue ADD COLUMN ${column}`);
      } catch (err) {
        // Column might already exist or other error - log and continue
        const errMsg = err instanceof Error ? err.message : String(err);
        if (!errMsg.includes('duplicate column')) {
          // Only log non-duplicate errors
          console.warn(`Warning: Could not add column ${columnName}: ${errMsg}`);
        }
      }
    }
  }

  db.prepare(`INSERT INTO _migrations (key, applied_at) VALUES (?, ?)`).run('channel_context_v1', new Date().toISOString());
}

function migrateDailyPlanning(): void {
  // Create migration metadata table if needed
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (key TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);

  const row = db.prepare(`SELECT key FROM _migrations WHERE key = 'daily_planning_v1'`).get();
  if (row) return; // Already migrated

  // Create daily planning tables
  db.exec(`
    -- Daily journal entries
    CREATE TABLE IF NOT EXISTS daily_journals (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      date TEXT NOT NULL,
      tasks_completed TEXT,
      tasks_in_progress TEXT,
      sentiment TEXT,
      biggest_success TEXT,
      biggest_error TEXT,
      highlights TEXT,
      focus_tomorrow TEXT,
      diary_entry TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(group_folder, date)
    );
    CREATE INDEX IF NOT EXISTS idx_journals_date ON daily_journals(date DESC);

    -- Atomic daily tasks
    CREATE TABLE IF NOT EXISTS daily_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      journal_id TEXT,
      parent_task TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER DEFAULT 0,
      tags TEXT,
      metadata TEXT,
      discord_channel_id TEXT,
      discord_thread_id TEXT,
      discord_poll_id TEXT,
      poll_data TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      due_date TEXT,
      archived_at TEXT,
      FOREIGN KEY (journal_id) REFERENCES daily_journals(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON daily_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_date ON daily_tasks(created_at DESC);

    -- Generated daily briefings
    CREATE TABLE IF NOT EXISTS daily_briefings (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      date TEXT NOT NULL,
      briefing_text TEXT NOT NULL,
      sources TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(group_folder, date)
    );
    CREATE INDEX IF NOT EXISTS idx_briefings_date ON daily_briefings(date DESC);
  `);

  db.prepare(`INSERT INTO _migrations (key, applied_at) VALUES (?, ?)`).run('daily_planning_v1', new Date().toISOString());
}

/**
 * Store a message with full content (generic version).
 * Works with any messaging platform.
 */
export function storeMessage(
  msgId: string,
  chatId: string,
  senderId: string,
  senderName: string,
  content: string,
  timestamp: string,
  isFromMe: boolean,
  attachments?: MessageAttachment[]
): void {
  const attachmentsJson = attachments && attachments.length > 0 ? JSON.stringify(attachments) : null;
  db.prepare(`INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, attachments_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(msgId, chatId, senderId, senderName, content, timestamp, isFromMe ? 1 : 0, attachmentsJson);
}

export function upsertChat(params: { chatId: string; name?: string | null; lastMessageTime?: string | null }): void {
  const name = params.name?.trim() || null;
  const lastMessageTime = params.lastMessageTime ?? null;

  db.prepare(`INSERT OR IGNORE INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`)
    .run(params.chatId, name, lastMessageTime);

  db.prepare(`
    UPDATE chats
    SET
      name = COALESCE(?, name),
      last_message_time = CASE
        WHEN ? IS NULL THEN last_message_time
        WHEN last_message_time IS NULL OR last_message_time < ? THEN ?
        ELSE last_message_time
      END
    WHERE jid = ?
  `).run(name, lastMessageTime, lastMessageTime, lastMessageTime, params.chatId);
}

export function getMessagesSinceCursor(
  chatJid: string,
  sinceTimestamp: string | null,
  sinceMessageId: string | null
): NewMessage[] {
  const timestamp = sinceTimestamp || '1970-01-01T00:00:00.000Z';
  const messageId = sinceMessageId || '0';
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, attachments_json
    FROM messages
    WHERE chat_jid = ? AND is_from_me = 0 AND (
      timestamp > ? OR (timestamp = ? AND CAST(id AS INTEGER) > CAST(? AS INTEGER))
    )
    ORDER BY timestamp, CAST(id AS INTEGER)
  `;
  return db.prepare(sql).all(chatJid, timestamp, timestamp, messageId) as NewMessage[];
}

export interface ChatState {
  chat_jid: string;
  last_agent_timestamp: string | null;
  last_agent_message_id: string | null;
}

export function getChatState(chatJid: string): ChatState | null {
  const row = db.prepare(`
    SELECT chat_jid, last_agent_timestamp, last_agent_message_id
    FROM chat_state
    WHERE chat_jid = ?
  `).get(chatJid) as ChatState | undefined;
  return row || null;
}

export function updateChatState(chatJid: string, timestamp: string, messageId: string): void {
  db.prepare(`
    INSERT INTO chat_state (chat_jid, last_agent_timestamp, last_agent_message_id)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_jid) DO UPDATE SET
      last_agent_timestamp = excluded.last_agent_timestamp,
      last_agent_message_id = excluded.last_agent_message_id
  `).run(chatJid, timestamp, messageId);
}

export interface GroupSession {
  group_folder: string;
  session_id: string;
  updated_at: string;
}

export function getAllGroupSessions(): GroupSession[] {
  return db.prepare(`SELECT group_folder, session_id, updated_at FROM group_sessions`).all() as GroupSession[];
}

export function setGroupSession(groupFolder: string, sessionId: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO group_sessions (group_folder, session_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(group_folder) DO UPDATE SET
      session_id = excluded.session_id,
      updated_at = excluded.updated_at
  `).run(groupFolder, sessionId, now);
}

export function deleteGroupSession(groupFolder: string): void {
  db.prepare(`DELETE FROM group_sessions WHERE group_folder = ?`).run(groupFolder);
}

export function pauseTasksForGroup(groupFolder: string): number {
  const info = db.prepare(`
    UPDATE scheduled_tasks
    SET status = 'paused'
    WHERE group_folder = ? AND status != 'completed'
  `).run(groupFolder);
  return info.changes;
}

export function createTask(task: Omit<ScheduledTask, 'last_run' | 'last_result'>): void {
  db.prepare(`
    INSERT INTO scheduled_tasks (
      id, group_folder, chat_jid, prompt, schedule_type, schedule_value, timezone, context_mode,
      next_run, status, created_at, state_json, retry_count, last_error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.timezone ?? null,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
    task.state_json ?? null,
    task.retry_count ?? 0,
    task.last_error ?? null
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTask | undefined;
}

export function getAllTasks(): ScheduledTask[] {
  return db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as ScheduledTask[];
}

export function updateTask(id: string, updates: Partial<Pick<ScheduledTask, 'prompt' | 'schedule_type' | 'schedule_value' | 'timezone' | 'next_run' | 'status' | 'state_json' | 'retry_count' | 'last_error' | 'context_mode' | 'running_since'>>): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) { fields.push('prompt = ?'); values.push(updates.prompt); }
  if (updates.schedule_type !== undefined) { fields.push('schedule_type = ?'); values.push(updates.schedule_type); }
  if (updates.schedule_value !== undefined) { fields.push('schedule_value = ?'); values.push(updates.schedule_value); }
  if (updates.timezone !== undefined) { fields.push('timezone = ?'); values.push(updates.timezone); }
  if (updates.next_run !== undefined) { fields.push('next_run = ?'); values.push(updates.next_run); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (updates.context_mode !== undefined) { fields.push('context_mode = ?'); values.push(updates.context_mode); }
  if (updates.state_json !== undefined) { fields.push('state_json = ?'); values.push(updates.state_json); }
  if (updates.retry_count !== undefined) { fields.push('retry_count = ?'); values.push(updates.retry_count); }
  if (updates.last_error !== undefined) { fields.push('last_error = ?'); values.push(updates.last_error); }
  if (updates.running_since !== undefined) { fields.push('running_since = ?'); values.push(updates.running_since); }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteTask(id: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
    db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  })();
}

export function claimDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  const staleThreshold = new Date(Date.now() - 900_000).toISOString();
  const claim = db.transaction(() => {
    const tasks = db.prepare(`
      SELECT * FROM scheduled_tasks
      WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
        AND (running_since IS NULL OR running_since < ?)
      ORDER BY next_run
    `).all(now, staleThreshold) as ScheduledTask[];

    for (const task of tasks) {
      db.prepare(`UPDATE scheduled_tasks SET running_since = ? WHERE id = ?`).run(now, task.id);
    }
    return tasks;
  });
  return claim();
}

const VALID_TASK_TRANSITIONS: Record<string, string[]> = {
  active: ['paused', 'completed', 'deleted'],
  paused: ['active', 'deleted'],
  completed: ['active', 'deleted'],
  deleted: [],
};

export function transitionTaskStatus(id: string, newStatus: string): boolean {
  const task = db.prepare('SELECT status FROM scheduled_tasks WHERE id = ?').get(id) as { status: string } | undefined;
  if (!task) return false;
  const allowed = VALID_TASK_TRANSITIONS[task.status] || [];
  if (!allowed.includes(newStatus)) return false;
  db.prepare('UPDATE scheduled_tasks SET status = ?, running_since = NULL WHERE id = ?')
    .run(newStatus, id);
  return true;
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
  lastError: string | null,
  retryCount: number
): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, last_error = ?, retry_count = ?,
        status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END,
        running_since = NULL
    WHERE id = ?
  `).run(nextRun, now, lastResult, lastError, retryCount, nextRun, id);
}

export function updateTaskRunStatsOnly(
  id: string,
  lastResult: string,
  lastError: string | null
): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE scheduled_tasks
    SET last_run = ?, last_result = ?, last_error = ?
    WHERE id = ?
  `).run(now, lastResult, lastError, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(`
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(log.task_id, log.run_at, log.duration_ms, log.status, log.result, log.error);
}

export function logToolCalls(params: {
  traceId: string;
  chatJid: string;
  groupFolder: string;
  userId?: string | null;
  toolCalls: Array<{ name: string; ok: boolean; duration_ms?: number; error?: string; output_bytes?: number; output_truncated?: boolean }>;
  source: string;
}): void {
  if (!params.toolCalls || params.toolCalls.length === 0) return;
  if (!dbInitialized) {
    initDatabase();
  }
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO tool_audit (trace_id, chat_jid, group_folder, user_id, tool_name, ok, duration_ms, error, created_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const transaction = db.transaction((calls: typeof params.toolCalls) => {
    for (const call of calls) {
      stmt.run(
        params.traceId,
        params.chatJid,
        params.groupFolder,
        params.userId || null,
        call.name,
        call.ok ? 1 : 0,
        call.duration_ms ?? null,
        call.error ?? null,
        now,
        params.source
      );
    }
  });
  transaction(params.toolCalls);
}

export function getToolUsageCounts(params: {
  groupFolder: string;
  userId?: string | null;
  since: string;
}): Array<{ tool_name: string; count: number }> {
  if (!dbInitialized) {
    initDatabase();
  }
  const clauses = ['group_folder = ?', 'created_at >= ?'];
  const values: unknown[] = [params.groupFolder, params.since];
  if (params.userId) {
    clauses.push('user_id = ?');
    values.push(params.userId);
  }
  const rows = db.prepare(`
    SELECT tool_name, COUNT(*) as count
    FROM tool_audit
    WHERE ${clauses.join(' AND ')}
    GROUP BY tool_name
  `).all(...values) as Array<{ tool_name: string; count: number }>;
  return rows;
}

export function getToolReliability(params: {
  groupFolder: string;
  limit?: number;
}): Array<{ tool_name: string; total: number; ok_count: number; avg_duration_ms: number | null }> {
  const limit = params.limit && params.limit > 0 ? params.limit : 200;
  const rows = db.prepare(`
    SELECT tool_name,
           COUNT(*) as total,
           SUM(ok) as ok_count,
           AVG(duration_ms) as avg_duration_ms
    FROM (
      SELECT tool_name, ok, duration_ms
      FROM tool_audit
      WHERE group_folder = ?
      ORDER BY created_at DESC
      LIMIT ?
    )
    GROUP BY tool_name
  `).all(params.groupFolder, limit) as Array<{ tool_name: string; total: number; ok_count: number; avg_duration_ms: number | null }>;
  return rows;
}

// User feedback functions

export interface UserFeedback {
  id: string;
  trace_id: string;
  message_id?: string;
  chat_jid?: string;
  feedback_type: 'positive' | 'negative';
  user_id?: string;
  reason?: string;
  created_at: string;
}

/**
 * Link a message to its trace ID for feedback lookup
 */
export function linkMessageToTrace(messageId: string, chatJid: string, traceId: string): void {
  if (!dbInitialized) initDatabase();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO message_traces (message_id, chat_jid, trace_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(messageId, chatJid, traceId, now);
}

/**
 * Get trace ID for a message
 */
export function getTraceIdForMessage(messageId: string, chatJid: string): string | null {
  if (!dbInitialized) initDatabase();
  const row = db.prepare(`
    SELECT trace_id FROM message_traces
    WHERE message_id = ? AND chat_jid = ?
  `).get(messageId, chatJid) as { trace_id: string } | undefined;
  return row?.trace_id ?? null;
}

/**
 * Record user feedback (thumbs up/down reaction)
 */
export function recordUserFeedback(feedback: Omit<UserFeedback, 'id' | 'created_at'>): string {
  if (!dbInitialized) initDatabase();
  const id = generateId('fb');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO user_feedback (id, trace_id, message_id, chat_jid, feedback_type, user_id, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    feedback.trace_id,
    feedback.message_id ?? null,
    feedback.chat_jid ?? null,
    feedback.feedback_type,
    feedback.user_id ?? null,
    feedback.reason ?? null,
    now
  );
  return id;
}

// ── Message Queue Functions ──────────────────────────────────────────

export function enqueueMessageItem(item: {
  chat_jid: string;
  message_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_group: boolean;
  chat_type: string;
  message_thread_id?: number;
  // Channel context fields
  channel_name?: string | null;
  channel_description?: string | null;
  channel_config_type?: string | null;
  channel_type?: string | null;
  default_skill?: string | null;
  parent_id?: string | null;
  is_forum_thread?: boolean | null;
}): number {
  const now = new Date().toISOString();

  // Build dynamic SQL based on which optional fields are provided
  const columns = ['chat_jid', 'message_id', 'sender_id', 'sender_name', 'content', 'timestamp', 'is_group', 'chat_type', 'message_thread_id', 'status', 'created_at'];
  const placeholders = ['?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?'];
  const values = [
    item.chat_jid,
    item.message_id,
    item.sender_id,
    item.sender_name,
    item.content,
    item.timestamp,
    item.is_group ? 1 : 0,
    item.chat_type,
    item.message_thread_id ?? null,
    'pending',  // status
    now
  ];

  // Add optional channel context fields if provided
  if (item.channel_name !== undefined) {
    columns.push('channel_name');
    placeholders.push('?');
    values.push(item.channel_name);
  }
  if (item.channel_description !== undefined) {
    columns.push('channel_description');
    placeholders.push('?');
    values.push(item.channel_description);
  }
  if (item.channel_config_type !== undefined) {
    columns.push('channel_config_type');
    placeholders.push('?');
    values.push(item.channel_config_type);
  }
  if (item.channel_type !== undefined) {
    columns.push('channel_type');
    placeholders.push('?');
    values.push(item.channel_type);
  }
  if (item.default_skill !== undefined) {
    columns.push('default_skill');
    placeholders.push('?');
    values.push(item.default_skill);
  }
  if (item.parent_id !== undefined) {
    columns.push('parent_id');
    placeholders.push('?');
    values.push(item.parent_id);
  }
  if (item.is_forum_thread !== undefined) {
    columns.push('is_forum_thread');
    placeholders.push('?');
    values.push(item.is_forum_thread ? 1 : 0);
  }

  const sql = `INSERT INTO message_queue (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
  const info = db.prepare(sql).run(...values);
  return Number(info.lastInsertRowid);
}

export function claimBatchForChat(chatJid: string, windowMs: number, maxBatchSize: number = 50): QueuedMessage[] {
  const select = db.prepare(`
    SELECT * FROM message_queue
    WHERE chat_jid = ? AND status = 'pending'
    ORDER BY id ASC
    LIMIT 1
  `);
  const selectWindow = db.prepare(`
    SELECT * FROM message_queue
    WHERE chat_jid = ? AND status = 'pending' AND created_at <= ?
    ORDER BY id ASC
    LIMIT ?
  `);
  const update = db.prepare(`
    UPDATE message_queue
    SET status = 'processing', started_at = ?, attempt_count = COALESCE(attempt_count, 0) + 1
    WHERE id = ?
  `);

  const txn = db.transaction(() => {
    const oldest = select.get(chatJid) as QueuedMessage | undefined;
    if (!oldest) return [];
    const cutoff = new Date(new Date(oldest.created_at).getTime() + windowMs).toISOString();
    const batch = selectWindow.all(chatJid, cutoff, maxBatchSize) as QueuedMessage[];
    const now = new Date().toISOString();
    for (const row of batch) {
      update.run(now, row.id);
    }
    return batch;
  });

  return txn();
}

export function completeQueuedMessages(ids: number[]): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(`UPDATE message_queue SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'processing'`);
  const txn = db.transaction((idList: number[]) => {
    for (const id of idList) {
      stmt.run(now, id);
    }
  });
  txn(ids);
}

export function failQueuedMessages(ids: number[], error: string): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(`UPDATE message_queue SET status = 'failed', completed_at = ?, error = ? WHERE id = ? AND status = 'processing'`);
  const txn = db.transaction((idList: number[]) => {
    for (const id of idList) {
      stmt.run(now, error, id);
    }
  });
  txn(ids);
}

export function requeueQueuedMessages(ids: number[], error: string): void {
  if (ids.length === 0) return;
  const stmt = db.prepare(`
    UPDATE message_queue
    SET status = 'pending',
        started_at = NULL,
        completed_at = NULL,
        error = ?
    WHERE id = ? AND status = 'processing'
  `);
  const txn = db.transaction((idList: number[]) => {
    for (const id of idList) {
      stmt.run(error, id);
    }
  });
  txn(ids);
}

export function getChatsWithPendingMessages(): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT chat_jid FROM message_queue WHERE status = 'pending'
  `).all() as Array<{ chat_jid: string }>;
  return rows.map(r => r.chat_jid);
}

export function resetStalledMessages(olderThanMs: number = 300_000): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const info = db.prepare(`
    UPDATE message_queue SET status = 'pending', started_at = NULL
    WHERE status = 'processing' AND started_at < ?
  `).run(cutoff);
  return info.changes;
}

export function cleanupCompletedMessages(olderThanMs: number): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const info = db.prepare(`
    DELETE FROM message_queue
    WHERE status IN ('completed', 'failed') AND created_at < ?
  `).run(cutoff);
  return info.changes;
}

export function cleanupOldTaskRunLogs(olderThanMs: number): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const info = db.prepare('DELETE FROM task_run_logs WHERE run_at < ?').run(cutoff);
  return info.changes;
}

export function cleanupOldToolAudit(olderThanMs: number): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const info = db.prepare('DELETE FROM tool_audit WHERE created_at < ?').run(cutoff);
  return info.changes;
}

export function cleanupOldMessageTraces(olderThanMs: number): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const info = db.prepare('DELETE FROM message_traces WHERE created_at < ?').run(cutoff);
  return info.changes;
}

export function cleanupOldUserFeedback(olderThanMs: number): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const info = db.prepare('DELETE FROM user_feedback WHERE created_at < ?').run(cutoff);
  return info.changes;
}

export function getPendingMessageCount(): number {
  try {
    const row = db.prepare("SELECT COUNT(*) as count FROM message_queue WHERE status = 'pending'").get() as { count: number };
    return row.count;
  } catch { return 0; }
}

// ── Daily Planning & Briefing CRUD Functions ─────────────────────────────

// Re-import types for internal use
interface DailyJournalRow {
  id: string;
  group_folder: string;
  date: string;
  tasks_completed: string | null;
  tasks_in_progress: string | null;
  sentiment: string | null;
  biggest_success: string | null;
  biggest_error: string | null;
  highlights: string | null;
  focus_tomorrow: string | null;
  diary_entry: string | null;
  created_at: string;
  updated_at: string;
}

interface DailyTaskRow {
  id: string;
  group_folder: string;
  journal_id: string | null;
  parent_task: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  tags: string | null;
  metadata: string | null;
  discord_channel_id: string | null;
  discord_thread_id: string | null;
  discord_poll_id: string | null;
  poll_data: string | null;
  completed_at: string | null;
  created_at: string;
  due_date: string | null;
  archived_at: string | null;
}

interface DailyBriefingRow {
  id: string;
  group_folder: string;
  date: string;
  briefing_text: string;
  sources: string | null;
  delivered_at: string | null;
  created_at: string;
}

/**
 * Create a new journal entry
 */
export function createDailyJournal(input: {
  group_folder: string;
  date?: string;
  tasks_completed?: string[];
  tasks_in_progress?: string[];
  sentiment?: 'positive' | 'neutral' | 'negative';
  biggest_success?: string;
  biggest_error?: string;
  highlights?: { good: string[]; bad: string[] } | null;
  focus_tomorrow?: string;
  diary_entry?: string;
}): string {
  const id = generateId('journal');
  const date = input.date || new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO daily_journals (
      id, group_folder, date, tasks_completed, tasks_in_progress,
      sentiment, biggest_success, biggest_error, highlights,
      focus_tomorrow, diary_entry, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(group_folder, date) DO UPDATE SET
      tasks_completed = excluded.tasks_completed,
      tasks_in_progress = excluded.tasks_in_progress,
      sentiment = excluded.sentiment,
      biggest_success = excluded.biggest_success,
      biggest_error = excluded.biggest_error,
      highlights = excluded.highlights,
      focus_tomorrow = excluded.focus_tomorrow,
      diary_entry = excluded.diary_entry,
      updated_at = excluded.updated_at
  `).run(
    id,
    input.group_folder,
    date,
    input.tasks_completed ? JSON.stringify(input.tasks_completed) : null,
    input.tasks_in_progress ? JSON.stringify(input.tasks_in_progress) : null,
    input.sentiment || null,
    input.biggest_success || null,
    input.biggest_error || null,
    input.highlights ? JSON.stringify(input.highlights) : null,
    input.focus_tomorrow || null,
    input.diary_entry || null,
    now,
    now
  );

  return id;
}

/**
 * Get journal by group and date
 */
export function getDailyJournalByDate(groupFolder: string, date: string): DailyJournalRow | undefined {
  return db.prepare('SELECT * FROM daily_journals WHERE group_folder = ? AND date = ?')
    .get(groupFolder, date) as DailyJournalRow | undefined;
}

/**
 * Get latest journal for a group
 */
export function getLatestDailyJournal(groupFolder: string): DailyJournalRow | undefined {
  return db.prepare('SELECT * FROM daily_journals WHERE group_folder = ? ORDER BY date DESC LIMIT 1')
    .get(groupFolder) as DailyJournalRow | undefined;
}

/**
 * List journals for a group
 */
export function listDailyJournals(groupFolder: string, limit = 30): DailyJournalRow[] {
  return db.prepare('SELECT * FROM daily_journals WHERE group_folder = ? ORDER BY date DESC LIMIT ?')
    .all(groupFolder, limit) as DailyJournalRow[];
}

/**
 * Update a journal entry
 */
export function updateDailyJournal(id: string, updates: Partial<{
  tasks_completed: string[];
  tasks_in_progress: string[];
  sentiment: 'positive' | 'neutral' | 'negative';
  biggest_success: string;
  biggest_error: string;
  highlights: { good: string[]; bad: string[] };
  focus_tomorrow: string;
  diary_entry: string;
}>): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.tasks_completed !== undefined) {
    fields.push('tasks_completed = ?');
    values.push(JSON.stringify(updates.tasks_completed));
  }
  if (updates.tasks_in_progress !== undefined) {
    fields.push('tasks_in_progress = ?');
    values.push(JSON.stringify(updates.tasks_in_progress));
  }
  if (updates.sentiment !== undefined) {
    fields.push('sentiment = ?');
    values.push(updates.sentiment);
  }
  if (updates.biggest_success !== undefined) {
    fields.push('biggest_success = ?');
    values.push(updates.biggest_success);
  }
  if (updates.biggest_error !== undefined) {
    fields.push('biggest_error = ?');
    values.push(updates.biggest_error);
  }
  if (updates.highlights !== undefined) {
    fields.push('highlights = ?');
    values.push(JSON.stringify(updates.highlights));
  }
  if (updates.focus_tomorrow !== undefined) {
    fields.push('focus_tomorrow = ?');
    values.push(updates.focus_tomorrow);
  }
  if (updates.diary_entry !== undefined) {
    fields.push('diary_entry = ?');
    values.push(updates.diary_entry);
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE daily_journals SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

// ── Daily Task CRUD ───────────────────────────────────────────────────────

/**
 * Create a new daily task
 */
export function createDailyTask(input: {
  group_folder: string;
  journal_id?: string;
  parent_task?: string;
  title: string;
  description?: string;
  priority?: number;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
  due_date?: string;
}): string {
  const id = generateId('task');
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO daily_tasks (
      id, group_folder, journal_id, parent_task, title, description,
      status, priority, tags, metadata, created_at, due_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.group_folder,
    input.journal_id || null,
    input.parent_task || null,
    input.title,
    input.description || null,
    'pending',
    input.priority ?? 0,
    input.tags ? JSON.stringify(input.tags) : null,
    input.metadata ? JSON.stringify(input.metadata) : null,
    now,
    input.due_date || null
  );

  return id;
}

/**
 * Get task by ID
 */
export function getDailyTaskById(id: string): DailyTaskRow | undefined {
  return db.prepare('SELECT * FROM daily_tasks WHERE id = ?')
    .get(id) as DailyTaskRow | undefined;
}

/**
 * Get tasks for a journal
 */
export function getDailyTasksByJournal(journalId: string): DailyTaskRow[] {
  return db.prepare('SELECT * FROM daily_tasks WHERE journal_id = ? ORDER BY priority DESC, created_at ASC')
    .all(journalId) as DailyTaskRow[];
}

/**
 * Get tasks for a specific date (via journal lookup)
 */
export function getDailyTasksForDate(groupFolder: string, date: string): DailyTaskRow[] {
  return db.prepare(`
    SELECT t.* FROM daily_tasks t
    INNER JOIN daily_journals j ON t.journal_id = j.id
    WHERE j.group_folder = ? AND j.date = ?
    ORDER BY t.priority DESC, t.created_at ASC
  `).all(groupFolder, date) as DailyTaskRow[];
}

/**
 * Get all active (non-archived) tasks for a group
 */
export function getActiveDailyTasks(groupFolder: string): DailyTaskRow[] {
  return db.prepare(`
    SELECT * FROM daily_tasks
    WHERE group_folder = ? AND status != 'archived'
    ORDER BY priority DESC, created_at ASC
  `).all(groupFolder) as DailyTaskRow[];
}

/**
 * Update a task
 */
export function updateDailyTask(id: string, updates: Partial<{
  status: 'pending' | 'in_progress' | 'completed' | 'archived';
  title: string;
  description: string;
  priority: number;
  tags: string[];
  metadata: Record<string, unknown>;
  completed_at: string;
  archived_at: string;
}>): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
    // Auto-set completed_at if status is completed
    if (updates.status === 'completed' && !updates.completed_at) {
      fields.push('completed_at = ?');
      values.push(new Date().toISOString());
    }
  }
  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.priority !== undefined) {
    fields.push('priority = ?');
    values.push(updates.priority);
  }
  if (updates.tags !== undefined) {
    fields.push('tags = ?');
    values.push(JSON.stringify(updates.tags));
  }
  if (updates.metadata !== undefined) {
    fields.push('metadata = ?');
    values.push(JSON.stringify(updates.metadata));
  }
  if (updates.completed_at !== undefined) {
    fields.push('completed_at = ?');
    values.push(updates.completed_at);
  }
  if (updates.archived_at !== undefined) {
    fields.push('archived_at = ?');
    values.push(updates.archived_at);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE daily_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Set Discord references for a task
 */
export function setDailyTaskDiscordRefs(
  id: string,
  channelId: string | null,
  threadId: string | null,
  pollId: string | null
): void {
  db.prepare(`
    UPDATE daily_tasks
    SET discord_channel_id = ?, discord_thread_id = ?, discord_poll_id = ?
    WHERE id = ?
  `).run(channelId, threadId, pollId, id);
}

/**
 * Update poll data for a task
 */
export function updateDailyTaskPollData(
  id: string,
  pollData: {
    question: string;
    answers: Array<{ id: number; text: string; emoji?: string; checked: boolean }>;
  } | null
): void {
  db.prepare('UPDATE daily_tasks SET poll_data = ? WHERE id = ?')
    .run(pollData ? JSON.stringify(pollData) : null, id);
}

/**
 * Archive old tasks for a group
 */
export function archiveOldDailyTasks(groupFolder: string, olderThanDays = 30): number {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const info = db.prepare(`
    UPDATE daily_tasks
    SET archived_at = ?, status = 'archived'
    WHERE group_folder = ? AND created_at < ? AND status != 'archived'
  `).run(new Date().toISOString(), groupFolder, cutoff);
  return info.changes;
}

// ── Daily Briefing CRUD ───────────────────────────────────────────────────

/**
 * Create a daily briefing
 */
export function createDailyBriefing(input: {
  group_folder: string;
  date?: string;
  briefing_text: string;
  sources?: { journal_id?: string; tasks?: string[]; events?: Array<{title: string; time: string}> } | null;
}): string {
  const id = generateId('briefing');
  const date = input.date || new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO daily_briefings (id, group_folder, date, briefing_text, sources, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(group_folder, date) DO UPDATE SET
      briefing_text = excluded.briefing_text,
      sources = excluded.sources
  `).run(
    id,
    input.group_folder,
    date,
    input.briefing_text,
    input.sources ? JSON.stringify(input.sources) : null,
    now
  );

  return id;
}

/**
 * Get briefing by group and date
 */
export function getDailyBriefingByDate(groupFolder: string, date: string): DailyBriefingRow | undefined {
  return db.prepare('SELECT * FROM daily_briefings WHERE group_folder = ? AND date = ?')
    .get(groupFolder, date) as DailyBriefingRow | undefined;
}

/**
 * Get latest briefing for a group
 */
export function getLatestDailyBriefing(groupFolder: string): DailyBriefingRow | undefined {
  return db.prepare('SELECT * FROM daily_briefings WHERE group_folder = ? ORDER BY date DESC LIMIT 1')
    .get(groupFolder) as DailyBriefingRow | undefined;
}

/**
 * Mark briefing as delivered
 */
export function markBriefingDelivered(id: string): void {
  db.prepare('UPDATE daily_briefings SET delivered_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}
