import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { MAIN_GROUP_FOLDER, STORE_DIR } from './config.js';

export type MemoryScope = 'user' | 'group' | 'global';
export type MemoryType =
  | 'identity'
  | 'preference'
  | 'fact'
  | 'relationship'
  | 'project'
  | 'task'
  | 'note'
  | 'archive';

export interface MemoryItemInput {
  scope: MemoryScope;
  subject_id?: string | null;
  type: MemoryType;
  content: string;
  importance?: number;
  confidence?: number;
  tags?: string[];
  ttl_days?: number | null;
  source?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface MemoryItem extends MemoryItemInput {
  id: string;
  group_folder: string;
  normalized: string;
  importance: number;
  confidence: number;
  tags_text: string;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  expires_at: string | null;
}

export interface MemorySearchResult extends MemoryItem {
  bm25: number;
  score: number;
}

const MEMORY_DB_PATH = path.join(STORE_DIR, 'memory.db');
let memoryDb: Database.Database | null = null;

function getDb(): Database.Database {
  if (!memoryDb) {
    throw new Error('Memory store is not initialized');
  }
  return memoryDb;
}

export function initMemoryStore(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  memoryDb = new Database(MEMORY_DB_PATH);
  memoryDb.pragma('journal_mode = WAL');
  memoryDb.pragma('busy_timeout = 3000');

  memoryDb.exec(`
    CREATE TABLE IF NOT EXISTS memory_items (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      scope TEXT NOT NULL,
      subject_id TEXT,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      normalized TEXT NOT NULL,
      importance REAL NOT NULL,
      confidence REAL NOT NULL,
      tags_json TEXT,
      tags_text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_accessed_at TEXT,
      expires_at TEXT,
      source TEXT,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_group_scope ON memory_items(group_folder, scope, subject_id);
    CREATE INDEX IF NOT EXISTS idx_memory_updated_at ON memory_items(updated_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      id,
      content,
      tags,
      tokenize = 'porter'
    );

    CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
      INSERT INTO memory_fts (id, content, tags)
      VALUES (new.id, new.content, new.tags_text);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_items_au AFTER UPDATE ON memory_items BEGIN
      UPDATE memory_fts
      SET content = new.content, tags = new.tags_text
      WHERE id = new.id;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_items_ad AFTER DELETE ON memory_items BEGIN
      DELETE FROM memory_fts WHERE id = old.id;
    END;

    CREATE TABLE IF NOT EXISTS memory_sources (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_hash TEXT,
      indexed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_sources_group ON memory_sources(group_folder, source_type);
  `);
}

function normalizeContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function tagsToText(tags?: string[]): string {
  if (!tags || tags.length === 0) return '';
  return tags
    .map(tag => tag.trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function getExpiresAt(ttlDays?: number | null): string | null {
  if (!ttlDays || !Number.isFinite(ttlDays) || ttlDays <= 0) return null;
  const ms = ttlDays * 24 * 60 * 60 * 1000;
  return new Date(Date.now() + ms).toISOString();
}

function resolveScope(input: MemoryItemInput, groupFolder: string): MemoryScope {
  if (input.scope === 'global' && groupFolder !== MAIN_GROUP_FOLDER) {
    return 'group';
  }
  return input.scope;
}

export function upsertMemoryItems(groupFolder: string, items: MemoryItemInput[], source: string): MemoryItem[] {
  if (items.length === 0) return [];
  const db = getDb();
  const now = new Date().toISOString();
  const results: MemoryItem[] = [];

  const selectStmt = db.prepare(`
    SELECT id, content, importance, confidence, tags_json, tags_text
    FROM memory_items
    WHERE group_folder = ? AND scope = ? AND IFNULL(subject_id, '') = ? AND type = ? AND normalized = ?
  `);

  const insertStmt = db.prepare(`
    INSERT INTO memory_items (
      id, group_folder, scope, subject_id, type, content, normalized,
      importance, confidence, tags_json, tags_text, created_at, updated_at,
      last_accessed_at, expires_at, source, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateStmt = db.prepare(`
    UPDATE memory_items
    SET content = ?, importance = ?, confidence = ?, tags_json = ?, tags_text = ?,
        updated_at = ?, expires_at = ?, source = ?, metadata_json = ?
    WHERE id = ?
  `);

  const transaction = db.transaction((inputs: MemoryItemInput[]) => {
    for (const item of inputs) {
      if (!item.content || typeof item.content !== 'string') continue;
      const normalized = normalizeContent(item.content);
      if (!normalized) continue;
      const scope = resolveScope(item, groupFolder);
      const subjectId = scope === 'user' ? (item.subject_id || null) : null;
      const importance = clamp(item.importance ?? 0.5, 0, 1);
      const confidence = clamp(item.confidence ?? 0.6, 0, 1);
      const tagsJson = item.tags ? JSON.stringify(item.tags) : null;
      const tagsText = tagsToText(item.tags);
      const expiresAt = getExpiresAt(item.ttl_days ?? null);
      const metadataJson = item.metadata ? JSON.stringify(item.metadata) : null;

      const existing = selectStmt.get(
        groupFolder,
        scope,
        subjectId || '',
        item.type,
        normalized
      ) as { id: string; content: string; importance: number; confidence: number; tags_json: string | null; tags_text: string | null } | undefined;

      if (existing) {
        const mergedImportance = Math.max(existing.importance, importance);
        const mergedConfidence = Math.max(existing.confidence, confidence);
        const mergedContent = existing.content.length >= item.content.length ? existing.content : item.content;
        const mergedTags = Array.from(new Set([...(existing.tags_text || '').split(' ').filter(Boolean), ...tagsText.split(' ').filter(Boolean)])).join(' ');
        updateStmt.run(
          mergedContent,
          mergedImportance,
          mergedConfidence,
          tagsJson || existing.tags_json,
          mergedTags || existing.tags_text || '',
          now,
          expiresAt,
          item.source || source,
          metadataJson,
          existing.id
        );
        results.push({
          id: existing.id,
          group_folder: groupFolder,
          scope,
          subject_id: subjectId,
          type: item.type,
          content: mergedContent,
          normalized,
          importance: mergedImportance,
          confidence: mergedConfidence,
          tags: item.tags,
          tags_text: mergedTags || existing.tags_text || '',
          created_at: now,
          updated_at: now,
          last_accessed_at: null,
          expires_at: expiresAt,
          ttl_days: item.ttl_days,
          source: item.source || source,
          metadata: item.metadata
        });
        continue;
      }

      const id = `mem-${crypto.randomUUID()}`;
      insertStmt.run(
        id,
        groupFolder,
        scope,
        subjectId,
        item.type,
        item.content,
        normalized,
        importance,
        confidence,
        tagsJson,
        tagsText,
        now,
        now,
        null,
        expiresAt,
        item.source || source,
        metadataJson
      );

      results.push({
        id,
        group_folder: groupFolder,
        scope,
        subject_id: subjectId,
        type: item.type,
        content: item.content,
        normalized,
        importance,
        confidence,
        tags: item.tags,
        tags_text: tagsText,
        created_at: now,
        updated_at: now,
        last_accessed_at: null,
        expires_at: expiresAt,
        ttl_days: item.ttl_days,
        source: item.source || source,
        metadata: item.metadata
      });
    }
  });

  transaction(items);
  return results;
}

function buildFtsQuery(text: string): string | null {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  if (tokens.length === 0) return null;
  const unique = Array.from(new Set(tokens)).slice(0, 10);
  return unique.map(token => `${token}*`).join(' OR ');
}

export function searchMemories(params: {
  groupFolder: string;
  userId?: string | null;
  query: string;
  limit?: number;
}): MemorySearchResult[] {
  const db = getDb();
  const ftsQuery = buildFtsQuery(params.query);
  if (!ftsQuery) return [];

  const now = new Date().toISOString();
  const limit = Math.min(params.limit || 12, 50);

  const rows = db.prepare(`
    SELECT m.*, bm25(memory_fts) AS bm25
    FROM memory_fts
    JOIN memory_items m ON m.id = memory_fts.id
    WHERE memory_fts MATCH ?
      AND (m.group_folder = ? OR m.group_folder = 'global')
      AND (m.scope != 'user' OR m.subject_id = ?)
      AND (m.expires_at IS NULL OR m.expires_at > ?)
    ORDER BY bm25
    LIMIT ?
  `).all(ftsQuery, params.groupFolder, params.userId || '', now, limit) as Array<MemorySearchResult>;

  const scored = rows.map(row => {
    const ageDays = row.updated_at ? (Date.now() - new Date(row.updated_at).getTime()) / (1000 * 60 * 60 * 24) : 365;
    const recency = Math.exp(-ageDays / 30);
    const bm25Score = 1 / (1 + (row.bm25 || 0));
    const score = (bm25Score * 0.55) + (row.importance * 0.3) + (recency * 0.15);
    return { ...row, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export function listMemories(params: {
  groupFolder: string;
  scope?: MemoryScope;
  userId?: string | null;
  type?: MemoryType;
  limit?: number;
}): MemoryItem[] {
  const db = getDb();
  const clauses: string[] = ['group_folder = ?'];
  const values: unknown[] = [params.groupFolder];

  if (params.scope) {
    clauses.push('scope = ?');
    values.push(params.scope);
  }
  if (params.type) {
    clauses.push('type = ?');
    values.push(params.type);
  }
  if (params.scope === 'user') {
    clauses.push('subject_id = ?');
    values.push(params.userId || '');
  }

  const limit = Math.min(params.limit || 50, 200);
  const sql = `
    SELECT * FROM memory_items
    WHERE ${clauses.join(' AND ')}
    ORDER BY updated_at DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(...values, limit) as MemoryItem[];
}

export function forgetMemories(params: {
  groupFolder: string;
  ids?: string[];
  content?: string;
  scope?: MemoryScope;
  userId?: string | null;
}): number {
  const db = getDb();
  if (params.ids && params.ids.length > 0) {
    const placeholders = params.ids.map(() => '?').join(',');
    const stmt = db.prepare(`DELETE FROM memory_items WHERE group_folder = ? AND id IN (${placeholders})`);
    const info = stmt.run(params.groupFolder, ...params.ids);
    return info.changes;
  }

  if (params.content) {
    const normalized = normalizeContent(params.content);
    const clauses: string[] = ['group_folder = ?', 'normalized = ?'];
    const values: unknown[] = [params.groupFolder, normalized];
    if (params.scope) {
      clauses.push('scope = ?');
      values.push(params.scope);
    }
    if (params.scope === 'user') {
      clauses.push('subject_id = ?');
      values.push(params.userId || '');
    }
    const stmt = db.prepare(`DELETE FROM memory_items WHERE ${clauses.join(' AND ')}`);
    const info = stmt.run(...values);
    return info.changes;
  }

  return 0;
}

export function getMemoryStats(params: { groupFolder: string; userId?: string | null }) {
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) as count FROM memory_items WHERE group_folder = ? OR group_folder = 'global'`)
    .get(params.groupFolder) as { count: number };
  const user = db.prepare(`
    SELECT COUNT(*) as count FROM memory_items
    WHERE group_folder = ? AND scope = 'user' AND subject_id = ?
  `).get(params.groupFolder, params.userId || '') as { count: number };
  const group = db.prepare(`
    SELECT COUNT(*) as count FROM memory_items
    WHERE group_folder = ? AND scope = 'group'
  `).get(params.groupFolder) as { count: number };
  const global = db.prepare(`
    SELECT COUNT(*) as count FROM memory_items
    WHERE group_folder = 'global'
  `).get() as { count: number };

  return {
    total: total?.count || 0,
    user: user?.count || 0,
    group: group?.count || 0,
    global: global?.count || 0
  };
}

export function cleanupExpiredMemories(): number {
  const db = getDb();
  const now = new Date().toISOString();
  const info = db.prepare(`DELETE FROM memory_items WHERE expires_at IS NOT NULL AND expires_at <= ?`).run(now);
  return info.changes;
}

export function buildUserProfile(params: {
  groupFolder: string;
  userId?: string | null;
  limit?: number;
}): string | null {
  if (!params.userId) return null;
  const db = getDb();
  const limit = Math.min(params.limit || 8, 20);
  const rows = db.prepare(`
    SELECT content, type
    FROM memory_items
    WHERE group_folder = ? AND scope = 'user' AND subject_id = ?
      AND type IN ('identity', 'preference', 'relationship', 'project')
    ORDER BY importance DESC, updated_at DESC
    LIMIT ?
  `).all(params.groupFolder, params.userId, limit) as Array<{ content: string; type: string }>;
  if (rows.length === 0) return null;
  return rows.map(row => `- (${row.type}) ${row.content}`).join('\n');
}

export function buildMemoryRecall(params: {
  groupFolder: string;
  userId?: string | null;
  query: string;
  maxResults?: number;
  maxTokens?: number;
}): string[] {
  const results = searchMemories({
    groupFolder: params.groupFolder,
    userId: params.userId,
    query: params.query,
    limit: params.maxResults || 8
  });

  if (results.length === 0) return [];

  const maxTokens = params.maxTokens || 1200;
  const recall: string[] = [];
  let tokens = 0;

  for (const item of results) {
    const line = `(${item.type}) ${item.content}`;
    const estimate = Math.ceil(Buffer.byteLength(line, 'utf-8') / 4);
    if (tokens + estimate > maxTokens) break;
    recall.push(line);
    tokens += estimate;
  }

  return recall;
}
