import dotenv from 'dotenv';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// IMPORTANT: Load .env before any other imports that read from process.env
// This ensures DISCORD_CHANNELS and other env vars are available to config.ts
const DOTCLAW_HOME = process.env.DOTCLAW_HOME || path.join(os.homedir(), '.dotclaw');
const ENV_PATH = path.join(DOTCLAW_HOME, '.env');
dotenv.config({ path: ENV_PATH, quiet: true } as Parameters<typeof dotenv.config>[0]);

import {
  DATA_DIR,
  MAIN_GROUP_FOLDER,
  GROUPS_DIR,
  CONTAINER_MODE,
  CONTAINER_PRIVILEGED,
  WARM_START_ENABLED,
} from './config.js';
import { RegisteredGroup, Session, MessageAttachment } from './types.js';
import {
  initDatabase,
  closeDatabase,
  storeMessage,
  upsertChat,
  getChatState,
  getAllGroupSessions,
  setGroupSession,
  deleteGroupSession,
  pauseTasksForGroup,
  getTraceIdForMessage,
  recordUserFeedback,
  getChatsWithPendingMessages,
  resetStalledMessages,
} from './db.js';
import { startSchedulerLoop, stopSchedulerLoop } from './task-scheduler.js';
import type { ContainerOutput } from './container-protocol.js';
import type { AgentContext } from './agent-context.js';
import { loadJson, saveJson, isSafeGroupFolder } from './utils.js';
import { writeTrace } from './trace-writer.js';
import {
  initMemoryStore,
  closeMemoryStore,
  cleanupExpiredMemories,
  upsertMemoryItems,
  MemoryItemInput
} from './memory-store.js';
import { startEmbeddingWorker, stopEmbeddingWorker } from './memory-embeddings.js';
import { parseAdminCommand } from './admin-commands.js';
import { loadModelRegistry, saveModelRegistry } from './model-registry.js';
import { startMetricsServer, stopMetricsServer, recordMessage } from './metrics.js';
import { startMaintenanceLoop, stopMaintenanceLoop } from './maintenance.js';
import { warmGroupContainer, startDaemonHealthCheckLoop, stopDaemonHealthCheckLoop, cleanupInstanceContainers, suppressHealthChecks, resetUnhealthyDaemons } from './container-runner.js';
import { startWakeDetector, stopWakeDetector } from './wake-detector.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { transcribeVoice } from './transcription.js';
import { emitHook } from './hooks.js';
import { invalidatePersonalizationCache } from './personalization.js';
import { installSkill, removeSkill, listSkills, updateSkill } from './skill-manager.js';
import { createTraceBase, executeAgentRun, recordAgentTelemetry, AgentExecutionError } from './agent-execution.js';
import { logger } from './logger.js';
import { startDashboard, stopDashboard, setTelegramConnected, setLastMessageTime } from './dashboard.js';
import { routeRequest } from './request-router.js';

// Provider system
import { ProviderRegistry } from './providers/registry.js';
import { createTelegramProvider } from './providers/telegram/index.js';
import type { IncomingMessage, MessagingProvider } from './providers/types.js';
import { createMessagePipeline, getActiveDrains, getActiveRuns, providerAttachmentToMessageAttachment } from './message-pipeline.js';
import { startIpcWatcher, stopIpcWatcher } from './ipc-dispatcher.js';
import { startWebhookServer, stopWebhookServer } from './webhook.js';
import { registerSlashCommands } from './providers/discord/discord-commands.js';

const runtime = loadRuntimeConfig();

// ───────────────────────── State ─────────────────────────

let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let discordBotId: string | null = null;  // Store Discord bot ID for command sync

// ───────────────────────── Helpers ─────────────────────────

function buildTriggerRegex(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

function buildAvailableGroupsSnapshot(): Array<{ jid: string; name: string; lastActivity: string; isRegistered: boolean }> {
  return Object.entries(registeredGroups).map(([jid, info]) => ({
    jid,
    name: info.name,
    lastActivity: getChatState(jid)?.last_agent_timestamp || info.added_at,
    isRegistered: true
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ───────────────────────── Rate Limiter ─────────────────────────

const RATE_LIMIT_MAX_MESSAGES = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const rateLimiter = new Map<string, RateLimitEntry>();

function checkRateLimit(userId: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const entry = rateLimiter.get(userId);

  if (!entry || now > entry.resetAt) {
    rateLimiter.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }

  if (entry.count >= RATE_LIMIT_MAX_MESSAGES) {
    return { allowed: false, retryAfterMs: entry.resetAt - now };
  }

  entry.count += 1;
  return { allowed: true };
}

function cleanupRateLimiter(): void {
  const now = Date.now();
  for (const [key, entry] of rateLimiter.entries()) {
    if (now > entry.resetAt) {
      rateLimiter.delete(key);
    }
  }
}

const rateLimiterInterval = setInterval(cleanupRateLimiter, 60_000);

// ───────────────────────── Config Constants ─────────────────────────

const HEARTBEAT_ENABLED = runtime.host.heartbeat.enabled;
const HEARTBEAT_INTERVAL_MS = runtime.host.heartbeat.intervalMs;
const HEARTBEAT_GROUP_FOLDER = (runtime.host.heartbeat.groupFolder || MAIN_GROUP_FOLDER).trim() || MAIN_GROUP_FOLDER;

// ───────────────────────── State Management ─────────────────────────

function loadState(): void {
  sessions = {};
  const groupsPath = path.join(DATA_DIR, 'registered_groups.json');
  logger.info({ groupsPath }, 'Loading registered groups from file');
  const rawGroups = loadJson(groupsPath, {}) as Record<string, RegisteredGroup>;
  logger.info({ rawGroupCount: Object.keys(rawGroups).length, rawKeys: Object.keys(rawGroups) }, 'Raw groups loaded from file');

  // Migrate: prefix unprefixed chat IDs with 'telegram:'
  let migrated = false;
  const loadedGroups: Record<string, RegisteredGroup> = {};
  for (const [chatId, group] of Object.entries(rawGroups)) {
    if (!chatId.includes(':')) {
      // Unprefixed — add telegram: prefix
      loadedGroups[ProviderRegistry.addPrefix('telegram', chatId)] = group;
      migrated = true;
    } else {
      loadedGroups[chatId] = group;
    }
  }
  if (migrated) {
    saveJson(path.join(DATA_DIR, 'registered_groups.json'), loadedGroups);
    logger.info('Migrated registered_groups.json chat IDs with telegram: prefix');
  }

  const sanitizedGroups: Record<string, RegisteredGroup> = {};
  let invalidCount = 0;

  for (const [chatId, group] of Object.entries(loadedGroups)) {
    if (!group || typeof group !== 'object') {
      logger.warn({ chatId }, 'Skipping registered group with invalid entry');
      invalidCount += 1;
      continue;
    }
    if (typeof group.name !== 'string' || group.name.trim() === '') {
      logger.warn({ chatId }, 'Skipping registered group with invalid name');
      invalidCount += 1;
      continue;
    }
    if (!isSafeGroupFolder(group.folder, GROUPS_DIR)) {
      logger.warn({ chatId, folder: group.folder }, 'Skipping registered group with invalid folder');
      invalidCount += 1;
      continue;
    }
    // Note: We ALLOW multiple channels to share the same folder
    // This enables all Discord channels to use the main workspace
    sanitizedGroups[chatId] = group;
  }

  registeredGroups = sanitizedGroups;
  if (invalidCount > 0) {
    logger.error({ invalidCount }, 'Registered groups contained invalid entries');
  }
  logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
  // Log all registered chat IDs for debugging
  logger.info({
    registeredChatIds: Object.keys(registeredGroups).sort(),
    registeredDetails: Object.entries(registeredGroups).map(([id, g]) => ({ id, name: g.name, folder: g.folder }))
  }, 'Registered groups details');
  const finalSessions = getAllGroupSessions();
  sessions = finalSessions.reduce<Session>((acc, row) => {
    acc[row.group_folder] = row.session_id;
    return acc;
  }, {});
}

function registerGroup(chatId: string, group: RegisteredGroup): void {
  if (!isSafeGroupFolder(group.folder, GROUPS_DIR)) {
    logger.warn({ chatId, folder: group.folder }, 'Refusing to register group with invalid folder');
    return;
  }
  // Note: We ALLOW multiple channels to share the same folder
  registeredGroups[chatId] = group;
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info({ chatId, name: group.name, folder: group.folder }, 'Group registered');

  if (CONTAINER_MODE === 'daemon' && WARM_START_ENABLED) {
    try {
      warmGroupContainer(group, group.folder === MAIN_GROUP_FOLDER);
      logger.info({ group: group.folder }, 'Warmed daemon container for new group');
    } catch (err) {
      logger.warn({ group: group.folder, err }, 'Failed to warm container for new group');
    }
  }
}

function listRegisteredGroups(): Array<{ chat_id: string; name: string; folder: string; trigger?: string; added_at: string }> {
  return Object.entries(registeredGroups).map(([chatId, group]) => ({
    chat_id: chatId,
    name: group.name,
    folder: group.folder,
    trigger: group.trigger,
    added_at: group.added_at
  }));
}

function resolveGroupIdentifier(identifier: string): string | null {
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase();
  for (const [chatId, group] of Object.entries(registeredGroups)) {
    if (chatId === trimmed) return chatId;
    if (group.name.toLowerCase() === normalized) return chatId;
    if (group.folder.toLowerCase() === normalized) return chatId;
  }
  return null;
}

function unregisterGroup(identifier: string): { ok: boolean; error?: string; group?: RegisteredGroup & { chat_id: string } } {
  const chatId = resolveGroupIdentifier(identifier);
  if (!chatId) {
    return { ok: false, error: 'Group not found' };
  }
  const group = registeredGroups[chatId];
  if (!group) {
    return { ok: false, error: 'Group not found' };
  }
  if (group.folder === MAIN_GROUP_FOLDER) {
    return { ok: false, error: 'Cannot remove main group' };
  }

  delete registeredGroups[chatId];
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  delete sessions[group.folder];
  deleteGroupSession(group.folder);
  pauseTasksForGroup(group.folder);

  logger.info({ chatId, name: group.name, folder: group.folder }, 'Group removed');

  return { ok: true, group: { ...group, chat_id: chatId } };
}

// ───────────────────────── Admin Commands ─────────────────────────

function formatGroups(groups: Array<{ chat_id: string; name: string; folder: string; trigger?: string; added_at: string }>): string {
  if (groups.length === 0) return 'No registered groups.';
  const lines = groups.map(group => {
    const trigger = group.trigger ? ` (trigger: ${group.trigger})` : '';
    return `- ${group.name} [${group.folder}] chat=${group.chat_id}${trigger}`;
  });
  return ['Registered groups:', ...lines].join('\n');
}

function applyModelOverride(params: { model: string; scope: 'global' | 'group' | 'user'; targetId?: string }): { ok: boolean; error?: string } {
  const defaultModel = runtime.host.defaultModel;
  const config = loadModelRegistry(defaultModel);
  const nextModel = params.model.trim();
  if (config.allowlist && config.allowlist.length > 0 && !config.allowlist.includes(nextModel)) {
    return { ok: false, error: 'Model not in allowlist' };
  }
  const scope = params.scope || 'global';
  const targetId = params.targetId;
  if (scope === 'user' && !targetId) {
    return { ok: false, error: 'Missing target_id for user scope' };
  }
  if (scope === 'group' && !targetId) {
    return { ok: false, error: 'Missing target_id for group scope' };
  }
  const nextConfig = { ...config };
  if (scope === 'global') {
    nextConfig.model = nextModel;
  } else if (scope === 'group') {
    nextConfig.per_group = nextConfig.per_group || {};
    nextConfig.per_group[targetId!] = { model: nextModel };
  } else if (scope === 'user') {
    nextConfig.per_user = nextConfig.per_user || {};
    nextConfig.per_user[targetId!] = { model: nextModel };
  }
  nextConfig.updated_at = new Date().toISOString();
  saveModelRegistry(nextConfig);
  return { ok: true };
}

async function handleAdminCommand(params: {
  chatId: string;
  senderId: string;
  senderName: string;
  content: string;
  botUsername?: string;
}, sendReply: (chatId: string, text: string) => Promise<void>): Promise<boolean> {
  const parsed = parseAdminCommand(params.content, params.botUsername);
  if (!parsed) return false;

  const reply = (text: string) => sendReply(params.chatId, text);

  const group = registeredGroups[params.chatId];
  if (!group) {
    await reply('This chat is not registered with DotClaw.');
    return true;
  }

  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const command = parsed.command;
  const args = parsed.args;

  const requireMain = (name: string): boolean => {
    if (isMain) return false;
    reply(`${name} is only available in the main group.`).catch(() => undefined);
    return true;
  };

  if (command === 'help') {
    await reply([
      'DotClaw admin commands:',
      '**General:**',
      '- `/dotclaw help` — show this help',
      '- `/dotclaw groups` — list registered groups (main only)',
      '- `/sync-commands` — sync Discord slash commands (instant for guild commands)',
      '',
      '**Daily Planning:**',
      '- `/briefing` — generate daily briefing',
      '- `/recap` — start nightly recap conversation',
      '- `/journal create [sentiment:] [success:] [error:]` — create journal entry',
      '- `/journal today` — show today\'s journal',
      '- `/journal list [--limit N]` — list recent journals',
      '- `/task create <title> [desc:]` — create new task',
      '- `/task list` — list active tasks',
      '- `/task status <task_id>` — show task status',
      '- `/task complete <task_id>` — mark task complete',
      '- `/breakdown <task description>` — break task into subtasks',
      '',
      '**Group Management (main only):**',
      '- `/dotclaw add-group <chat_id> <name> [folder]`',
      '- `/dotclaw remove-group <chat_id|name|folder>`',
      '',
      '**Model & Skills (main only):**',
      '- `/dotclaw set-model <model> [global|group|user] [target_id]`',
      '- `/dotclaw skill install <url> [--global]`',
      '- `/dotclaw skill remove <name> [--global]`',
      '- `/dotclaw skill list [--global]`',
      '',
      '**Preferences:**',
      '- `/dotclaw remember <fact>` — remember a fact (main only)',
      '- `/dotclaw style <concise|balanced|detailed>`',
      '- `/dotclaw tools <conservative|balanced|proactive>`',
      '- `/dotclaw caution <low|balanced|high>`',
      '- `/dotclaw memory <strict|balanced|loose>`'
    ].join('\n'));
    return true;
  }

  if (command === 'groups') {
    if (requireMain('Listing groups')) return true;
    await reply(formatGroups(listRegisteredGroups()));
    return true;
  }

  if (command === 'sync-commands') {
    // Special command that should never reach the AI - sync Discord slash commands
    if (!discordBotId) {
      await reply('Discord bot not connected. Cannot sync commands.');
      return true;
    }

    // Check if this is a Discord chat
    if (!params.chatId.startsWith('discord:')) {
      await reply('This command only works in Discord.');
      return true;
    }

    // Get the guild ID from the chat ID (for Discord channels)
    // For guild-specific commands, we'd need the guild ID from the channel
    // For now, we'll register globally (takes up to 1 hour) or use a configured guild
    const envGuildId = process.env.DISCORD_GUILD_ID;
    if (!envGuildId) {
      await reply(
        'Warning: No DISCORD_GUILD_ID set. Commands will be registered globally (may take up to 1 hour to propagate).\n' +
        'Set DISCORD_GUILD_ID in .env for instant guild-specific command sync.\n' +
        'Syncing global commands...'
      );
    }

    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      await reply('Error: DISCORD_BOT_TOKEN not set.');
      return true;
    }

    await reply('Syncing Discord slash commands...');

    const result = await registerSlashCommands({
      token,
      clientId: discordBotId,
      guildId: envGuildId, // Optional: if set, guild commands (instant); otherwise global (1hr)
    });

    if (result.success) {
      const scope = result.guildCommands ? 'guild' : 'global';
      const timing = result.guildCommands ? 'instant' : 'up to 1 hour';
      await reply(`✅ Successfully registered ${result.count} commands (${scope}, ${timing})`);
      logger.info({ count: result.count, scope }, 'Discord slash commands synced via /sync-commands');
    } else {
      await reply(`❌ Failed to sync commands: ${result.error || 'Unknown error'}`);
      logger.error({ error: result.error }, 'Failed to sync Discord slash commands via /sync-commands');
    }

    return true;
  }

  if (command === 'add-group') {
    if (requireMain('Adding groups')) return true;
    if (args.length < 2) {
      await reply('Usage: /dotclaw add-group <chat_id> <name> [folder] [--type <text|voice|forum>] [--desc <description>] [--skill <skillname>]');
      return true;
    }
    const newChatId = args[0];
    const name = args[1];

    // Parse optional flags
    const flags = {
      type: undefined as string | undefined,
      desc: undefined as string | undefined,
      skill: undefined as string | undefined,
    };

    // Find positional folder arg (first arg that doesn't start with --)
    let folder: string | undefined = args[2];
    const remainingArgs = args.slice(3);
    let i = 0;
    while (i < remainingArgs.length) {
      const arg = remainingArgs[i];
      if (arg === '--type' && i + 1 < remainingArgs.length) {
        flags.type = remainingArgs[i + 1];
        i += 2;
      } else if (arg === '--desc' && i + 1 < remainingArgs.length) {
        flags.desc = remainingArgs[i + 1];
        i += 2;
      } else if (arg === '--skill' && i + 1 < remainingArgs.length) {
        flags.skill = remainingArgs[i + 1];
        i += 2;
      } else {
        i++;
      }
    }

    // If folder starts with --, it's actually a flag, use default folder
    if (folder && folder.startsWith('--')) {
      folder = undefined;
    }

    const resolvedFolder = folder || name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 50);
    if (!isSafeGroupFolder(resolvedFolder, GROUPS_DIR)) {
      await reply(`Invalid folder name: "${resolvedFolder}"`);
      return true;
    }
    if (registeredGroups[newChatId]) {
      await reply(`Chat ${newChatId} is already registered.`);
      return true;
    }

    const newGroup: RegisteredGroup = {
      name,
      folder: resolvedFolder,
      added_at: new Date().toISOString()
    };

    // Add Discord metadata if provider is Discord and flags provided
    if (newChatId.startsWith('discord:') && (flags.type || flags.desc || flags.skill)) {
      const rawChannelId = ProviderRegistry.stripPrefix(newChatId);
      newGroup.discord = {
        channelId: rawChannelId,
        channelName: name,
        channelType: (flags.type === 'text' || flags.type === 'voice' || flags.type === 'forum') ? flags.type : 'text',
        description: flags.desc,
        defaultSkill: flags.skill,
      };
    }

    registerGroup(newChatId, newGroup);
    const metadataInfo = newGroup.discord
      ? ` (Discord: ${newGroup.discord.channelType}${newGroup.discord.defaultSkill ? `, skill: ${newGroup.discord.defaultSkill}` : ''})`
      : '';
    await reply(`Group "${name}" registered (folder: ${resolvedFolder})${metadataInfo}.`);
    return true;
  }

  if (command === 'remove-group') {
    if (requireMain('Removing groups')) return true;
    if (args.length < 1) {
      await reply('Usage: /dotclaw remove-group <chat_id|name|folder>');
      return true;
    }
    const result = unregisterGroup(args[0]);
    if (!result.ok) {
      await reply(`Failed to remove group: ${result.error}`);
      return true;
    }
    await reply(`Group "${result.group!.name}" removed.`);
    return true;
  }

  if (command === 'set-model') {
    if (requireMain('Setting models')) return true;
    if (args.length < 1) {
      await reply('Usage: /dotclaw set-model <model> [global|group|user] [target_id]');
      return true;
    }
    const model = args[0];
    const scopeCandidate = (args[1] || '').toLowerCase();
    const scope = (scopeCandidate === 'global' || scopeCandidate === 'group' || scopeCandidate === 'user')
      ? (scopeCandidate as 'global' | 'group' | 'user')
      : 'global';
    const targetId = args[2] || (scope === 'group' ? group.folder : scope === 'user' ? params.senderId : undefined);
    const result = applyModelOverride({ model, scope, targetId });
    if (!result.ok) {
      await reply(`Failed to set model: ${result.error || 'unknown error'}`);
      return true;
    }
    await reply(`Model set to ${model} (${scope}${targetId ? `:${targetId}` : ''}).`);
    return true;
  }

  if (command === 'remember') {
    if (requireMain('Remembering facts')) return true;
    const fact = args.join(' ').trim();
    if (!fact) {
      await reply('Usage: /dotclaw remember <fact>');
      return true;
    }
    const items: MemoryItemInput[] = [{
      scope: 'global',
      type: 'fact',
      content: fact,
      importance: 0.7,
      confidence: 0.8,
      tags: ['manual']
    }];
    upsertMemoryItems('global', items, 'admin-command');
    await reply(`Remembered: "${fact}"`);
    return true;
  }

  if (command === 'style') {
    const level = (args[0] || '').toLowerCase();
    const mapping: Record<string, string> = {
      concise: 'Prefers concise, short responses.',
      balanced: 'Prefers balanced-length responses.',
      detailed: 'Prefers detailed, thorough responses.'
    };
    if (!mapping[level]) {
      await reply('Usage: /dotclaw style <concise|balanced|detailed>');
      return true;
    }
    const items: MemoryItemInput[] = [{
      scope: 'user',
      subject_id: params.senderId,
      type: 'preference',
      conflict_key: 'response_style',
      content: mapping[level],
      importance: 0.6,
      confidence: 0.8,
      tags: [`response_style:${level}`]
    }];
    upsertMemoryItems(group.folder, items, 'admin-command');
    invalidatePersonalizationCache(group.folder, params.senderId);
    await reply(`Response style set to ${level}.`);
    return true;
  }

  if (command === 'tools') {
    const level = (args[0] || '').toLowerCase();
    const mapping: Record<string, string> = {
      conservative: 'Prefers conservative tool usage.',
      balanced: 'Prefers balanced tool usage.',
      proactive: 'Prefers proactive tool usage.'
    };
    if (!mapping[level]) {
      await reply('Usage: /dotclaw tools <conservative|balanced|proactive>');
      return true;
    }
    const items: MemoryItemInput[] = [{
      scope: 'user',
      subject_id: params.senderId,
      type: 'preference',
      conflict_key: 'tool_usage',
      content: mapping[level],
      importance: 0.6,
      confidence: 0.8,
      tags: [`tool_usage:${level}`]
    }];
    upsertMemoryItems(group.folder, items, 'admin-command');
    invalidatePersonalizationCache(group.folder, params.senderId);
    await reply(`Tool usage set to ${level}.`);
    return true;
  }

  if (command === 'caution') {
    const level = (args[0] || '').toLowerCase();
    const mapping: Record<string, string> = {
      low: 'Prefers low caution.',
      balanced: 'Prefers balanced caution.',
      high: 'Prefers high caution.'
    };
    if (!mapping[level]) {
      await reply('Usage: /dotclaw caution <low|balanced|high>');
      return true;
    }
    const items: MemoryItemInput[] = [{
      scope: 'user',
      subject_id: params.senderId,
      type: 'preference',
      conflict_key: 'caution_level',
      content: mapping[level],
      importance: 0.6,
      confidence: 0.8,
      tags: [`caution_level:${level}`]
    }];
    upsertMemoryItems(group.folder, items, 'admin-command');
    invalidatePersonalizationCache(group.folder, params.senderId);
    await reply(`Caution level set to ${level}.`);
    return true;
  }

  if (command === 'memory') {
    const level = (args[0] || '').toLowerCase();
    const threshold = level === 'strict' ? 0.7 : level === 'balanced' ? 0.55 : level === 'loose' ? 0.45 : null;
    if (threshold === null) {
      await reply('Usage: /dotclaw memory <strict|balanced|loose>');
      return true;
    }
    const items: MemoryItemInput[] = [{
      scope: 'user',
      subject_id: params.senderId,
      type: 'preference',
      conflict_key: 'memory_importance_threshold',
      content: `Prefers memory strictness ${level}.`,
      importance: 0.6,
      confidence: 0.8,
      tags: [`memory_importance_threshold:${threshold}`],
      metadata: { memory_importance_threshold: threshold, threshold }
    }];
    upsertMemoryItems(group.folder, items, 'admin-command');
    await reply(`Memory strictness set to ${level}.`);
    return true;
  }

  if (command === 'skill-help') {
    await reply([
      'Skill commands:',
      '- `/dotclaw skill install <url> [--global]` — install from git repo or URL',
      '- `/dotclaw skill remove <name> [--global]` — remove a skill',
      '- `/dotclaw skill list [--global]` — list installed skills',
      '- `/dotclaw skill update <name> [--global]` — re-pull from source'
    ].join('\n'));
    return true;
  }

  if (command === 'skill-install') {
    if (requireMain('Installing skills')) return true;
    if (!runtime.agent.skills.installEnabled) {
      await reply('Skill installation is disabled in runtime config (`agent.skills.installEnabled`).');
      return true;
    }
    const isGlobal = args.includes('--global');
    const source = args.filter(a => a !== '--global')[0];
    if (!source) {
      await reply('Usage: /dotclaw skill install <url> [--global]');
      return true;
    }
    const scope = isGlobal ? 'global' as const : 'group' as const;
    const targetDir = path.join(GROUPS_DIR, isGlobal ? 'global' : 'main', 'skills');
    await reply(`Installing skill from ${source}...`);
    const result = await installSkill({ source, targetDir, scope });
    if (!result.ok) {
      await reply(`Failed to install skill: ${result.error}`);
    } else {
      await reply(`Skill "${result.name}" installed (${scope}). Available on next agent run.`);
    }
    return true;
  }

  if (command === 'skill-remove') {
    if (requireMain('Removing skills')) return true;
    const isGlobal = args.includes('--global');
    const name = args.filter(a => a !== '--global')[0];
    if (!name) {
      await reply('Usage: /dotclaw skill remove <name> [--global]');
      return true;
    }
    const targetDir = path.join(GROUPS_DIR, isGlobal ? 'global' : 'main', 'skills');
    const result = removeSkill({ name, targetDir });
    if (!result.ok) {
      await reply(`Failed to remove skill: ${result.error}`);
    } else {
      await reply(`Skill "${name}" removed.`);
    }
    return true;
  }

  if (command === 'skill-list') {
    if (requireMain('Listing skills')) return true;
    const isGlobal = args.includes('--global');
    const scope = isGlobal ? 'global' as const : 'group' as const;
    const targetDir = path.join(GROUPS_DIR, isGlobal ? 'global' : 'main', 'skills');
    const skills = listSkills(targetDir, scope);
    if (skills.length === 0) {
      await reply(`No skills installed (${scope}).`);
    } else {
      const lines = skills.map(s =>
        `- ${s.name} (v${s.version}, source: ${s.source === 'local' ? 'local' : 'remote'})`
      );
      await reply(`Installed skills (${scope}):\n${lines.join('\n')}`);
    }
    return true;
  }

  if (command === 'skill-update') {
    if (requireMain('Updating skills')) return true;
    const isGlobal = args.includes('--global');
    const name = args.filter(a => a !== '--global')[0];
    if (!name) {
      await reply('Usage: /dotclaw skill update <name> [--global]');
      return true;
    }
    const scope = isGlobal ? 'global' as const : 'group' as const;
    const targetDir = path.join(GROUPS_DIR, isGlobal ? 'global' : 'main', 'skills');
    const result = await updateSkill({ name, targetDir, scope });
    if (!result.ok) {
      await reply(`Failed to update skill: ${result.error}`);
    } else {
      await reply(`Skill "${name}" updated.`);
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // Daily Planning Commands
  // ═══════════════════════════════════════════════════════════════════════════════

  if (command === 'briefing') {
    logger.info({ group: group.folder, userId: params.senderId }, '[/briefing] Daily briefing requested');
    // Generate daily briefing via agent
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const prompt = [
      '[DAILY BRIEFING]',
      `Generate a concise daily briefing for ${today}.`,
      '',
      'Use these tools to gather context:',
      '1. get_planning_context - for journal entries and recent activity',
      '2. get_daily_tasks - for active tasks',
      '',
      'OUTPUT FORMAT - Send as a message with title followed by separate embed cards:',
      '',
      'First, output the title as regular markdown text:',
      '# ☀️ Daily Briefing — ' + today,
      '',
      'Then create SEPARATE embed cards for each section (one embed per section):',
      '',
      '<embed title="📅 Yesterday" color="#5865F2">',
      '<field name="Outcomes" inline="false">List completed tasks and wins. Use emojis: ✅ complete, 🔴 blocked, ⏳ in progress.</field>',
      '</embed>',
      '',
      '<embed title="📋 Carry-Over Tasks" color="#FEE75C">',
      '<field name="Pending" inline="false">List incomplete tasks. Format each on a new line with priority emoji (🔴 high, 🟡 medium).</field>',
      '</embed>',
      '',
      '<embed title="🎯 Focus for Today" color="#57F287">',
      '<field name="Priorities" inline="false">Identify 2-3 key focus areas for today.</field>',
      '</embed>',
      '',
      'CRITICAL FORMATTING RULES:',
      '- Title goes FIRST as # markdown heading (NOT in an embed)',
      '- Each section gets its OWN <embed> block with title attribute',
      '- Do NOT use markdown tables (| pipes)',
      '- Use plain lists with emojis, one per line',
      '- Each embed has ONE field with the section content',
      '- Field values support: **bold**, *italic*, `code`, [links](url)',
      '',
      'Keep it concise and actionable. No subagents, no research.'
    ].join('\n');

    try {
      const traceBase = createTraceBase({
        chatId: params.chatId,
        groupFolder: group.folder,
        userId: params.senderId,
        inputText: prompt,
        source: 'daily-briefing'
      });
      const routingDecision = routeRequest();

      logger.info({ group: group.folder, model: routingDecision.model }, '[/briefing] Starting agent run');

      const execution = await executeAgentRun({
        group,
        prompt,
        chatJid: params.chatId,
        userId: params.senderId,
        userName: params.senderName,
        recallQuery: 'daily briefing journal tasks goals',
        recallMaxResults: routingDecision.recallMaxResults,
        recallMaxTokens: routingDecision.recallMaxTokens,
        sessionId: sessions[group.folder],
        onSessionUpdate: (sessionId) => { sessions[group.folder] = sessionId; },
        availableGroups: buildAvailableGroupsSnapshot(),
        modelMaxOutputTokens: routingDecision.maxOutputTokens,
        maxToolSteps: 20, // Limit tool steps to prevent getting stuck
        timeoutMs: 180_000, // 3 minute timeout
        lane: 'interactive',
      });

      const context = execution.context;
      const output = execution.output;
      const errorMessage = output.status === 'error' ? (output.error || 'Unknown error') : null;

      if (context) {
        recordAgentTelemetry({
          traceBase,
          output,
          context,
          toolAuditSource: 'daily-briefing',
          errorMessage: errorMessage ?? undefined,
        });
      }

      if (errorMessage) {
        logger.error({ group: group.folder, error: errorMessage }, '[/briefing] Agent run failed');
        await reply(`Briefing generation failed: ${errorMessage}`);
        return true;
      }

      logger.info({ group: group.folder, resultLength: output.result?.length || 0 }, '[/briefing] Agent run completed');

      // Send the briefing to the user
      if (output.result) {
        await reply(output.result);

        // Persist the briefing to database
        try {
          const { createDailyBriefing } = await import('./db.js');
          createDailyBriefing({
            group_folder: group.folder,
            date: new Date().toISOString().split('T')[0],
            briefing_text: output.result,
          });
          logger.info({ group: group.folder }, '[/briefing] Briefing persisted to database');
        } catch (dbErr) {
          logger.error({ err: dbErr, group: group.folder }, '[/briefing] Failed to persist briefing to database');
          // Don't fail the user request - just log it
        }
      }
    } catch (err) {
      logger.error({ err, group: group.folder }, '[/briefing] Briefing agent run failed');
      await reply(`Briefing generation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  if (command === 'recap') {
    logger.info({ group: group.folder, userId: params.senderId }, '[/recap] Nightly recap requested');
    // Start nightly recap conversation
    const prompt = [
      '[NIGHTLY RECAP]',
      'Initiate a conversational nightly review with the user.',
      '',
      'Your goal is to gather end-of-day reflections through natural dialogue, not an interview script.',
      'Gather naturally:',
      '- Overall sentiment for the day',
      '- Biggest wins and successes',
      '- Any mistakes or learning moments',
      "- Highlights and lowlights (don't force it if user doesn't want to share)",
      '- Focus for tomorrow',
      '',
      'As you learn things, create a structured journal entry using the daily_journal database table.',
      'Be conversational and empathetic - this is a reflection, not an interrogation.',
      '',
      'When summarizing at the end, you may use Discord embed cards for the summary:',
      '<embed title="🌙 Nightly Recap Summary" color="#9B59B6">',
      '<field name="📝 Overall Sentiment" inline="false">Summary of how the day felt overall</field>',
      '<field name="🏆 Wins" inline="false">Key accomplishments and successes</field>',
      '<field name="📚 Lessons" inline="false">Learning moments and insights</field>',
      '<field name="🎯 Tomorrow\'s Focus" inline="false">Key focus areas for tomorrow</field>',
      '</embed>',
      '',
      'EMBED FORMATTING: No markdown tables with | pipes. Use field blocks and plain lists with emojis instead.'
    ].join('\n');

    try {
      const traceBase = createTraceBase({
        chatId: params.chatId,
        groupFolder: group.folder,
        userId: params.senderId,
        inputText: prompt,
        source: 'nightly-recap'
      });
      const routingDecision = routeRequest();

      const execution = await executeAgentRun({
        group,
        prompt,
        chatJid: params.chatId,
        userId: params.senderId,
        userName: params.senderName,
        recallQuery: 'nightly recap journal daily reflection',
        recallMaxResults: Math.max(4, routingDecision.recallMaxResults - 2),
        recallMaxTokens: routingDecision.recallMaxTokens,
        sessionId: sessions[group.folder],
        onSessionUpdate: (sessionId) => { sessions[group.folder] = sessionId; },
        availableGroups: buildAvailableGroupsSnapshot(),
        modelMaxOutputTokens: routingDecision.maxOutputTokens,
        maxToolSteps: routingDecision.maxToolSteps,
        lane: 'interactive',
      });

      const context = execution.context;
      const output = execution.output;
      const errorMessage = output.status === 'error' ? (output.error || 'Unknown error') : null;

      if (context) {
        recordAgentTelemetry({
          traceBase,
          output,
          context,
          toolAuditSource: 'nightly-recap',
          errorMessage: errorMessage ?? undefined,
        });
      }

      if (errorMessage) {
        logger.error({ group: group.folder, error: errorMessage }, '[/recap] Agent run failed');
        await reply(`Recap failed: ${errorMessage}`);
      } else {
        logger.info({ group: group.folder }, '[/recap] Agent run completed');
      }
    } catch (err) {
      logger.error({ err, group: group.folder }, '[/recap] Agent run failed');
      await reply(`Recap failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  if (command === 'breakdown') {
    const taskDescription = args.join(' ').trim();
    if (!taskDescription) {
      await reply('Usage: /breakdown <task description>\nExample: /breakdown Build a Discord bot for daily planning');
      return true;
    }

    const prompt = [
      '[TASK BREAKDOWN]',
      `Break down the following task into atomic, actionable subtasks (3-10 max):`,
      '',
      `Task: ${taskDescription}`,
      '',
      'Requirements:',
      '- Each subtask should be independently completable',
      '- Order them logically (dependencies first)',
      '- Use emoji prefixes for visual clarity',
      '- Keep titles under 55 characters',
      '',
      'Return ONLY a JSON array of subtask strings, e.g.:',
      '["📋 Design system architecture", "🔧 Set up discord.js", "🧪 Write tests"]',
      '',
      'After generating, offer to create these as tasks with Discord forum threads and polls.'
    ].join('\n');

    try {
      const traceBase = createTraceBase({
        chatId: params.chatId,
        groupFolder: group.folder,
        userId: params.senderId,
        inputText: prompt,
        source: 'task-breakdown'
      });

      const execution = await executeAgentRun({
        group,
        prompt,
        chatJid: params.chatId,
        userId: params.senderId,
        userName: params.senderName,
        recallQuery: 'task breakdown planning subtasks',
        recallMaxResults: 4,
        recallMaxTokens: 400,
        sessionId: sessions[group.folder],
        onSessionUpdate: (sessionId) => { sessions[group.folder] = sessionId; },
        availableGroups: buildAvailableGroupsSnapshot(),
        modelMaxOutputTokens: 1000,
        maxToolSteps: 50,
        lane: 'interactive',
      });

      const context = execution.context;
      const output = execution.output;
      const errorMessage = output.status === 'error' ? (output.error || 'Unknown error') : null;

      if (context) {
        recordAgentTelemetry({
          traceBase,
          output,
          context,
          toolAuditSource: 'task-breakdown',
          errorMessage: errorMessage ?? undefined,
        });
      }

      if (errorMessage) {
        await reply(`Breakdown failed: ${errorMessage}`);
      } else if (output.result) {
        await reply(output.result);
      }
    } catch (err) {
      logger.error({ err }, 'Breakdown agent run failed');
      await reply(`Breakdown failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  if (command === 'journal-today' || command === 'journal-create' || command === 'journal-list' || command === 'journal-update') {
    // Journal commands - let agent handle with tool access
    const prompt = command === 'journal-today'
      ? '[JOURNAL TODAY]\nShow today\'s journal entry if it exists. Use getDailyJournalByDate with today\'s date. If no entry, say so and offer to create one.'
      : command === 'journal-create'
      ? '[JOURNAL CREATE]\nCreate a journal entry for today with: ' + (args.join(' ') || '(no additional details provided)') + '\nUse createDailyJournal tool. Gather any missing info through conversation.'
      : command === 'journal-list'
      ? '[JOURNAL LIST]\nList recent journal entries (limit: ' + (args[0] || '7') + '). Use listDailyJournals tool.'
      : '[JOURNAL UPDATE]\nUpdate today\'s journal with: ' + args.join(' ') + '\nUse updateDailyJournal tool.';

    try {
      const traceBase = createTraceBase({
        chatId: params.chatId,
        groupFolder: group.folder,
        userId: params.senderId,
        inputText: prompt,
        source: 'journal-command'
      });

      const execution = await executeAgentRun({
        group,
        prompt,
        chatJid: params.chatId,
        userId: params.senderId,
        userName: params.senderName,
        recallQuery: 'journal daily entry',
        recallMaxResults: 3,
        recallMaxTokens: 300,
        sessionId: sessions[group.folder],
        onSessionUpdate: (sessionId) => { sessions[group.folder] = sessionId; },
        availableGroups: buildAvailableGroupsSnapshot(),
        modelMaxOutputTokens: 1500,
        maxToolSteps: 30,
        lane: 'interactive',
      });

      const context = execution.context;
      const output = execution.output;
      const errorMessage = output.status === 'error' ? (output.error || 'Unknown error') : null;

      if (context) {
        recordAgentTelemetry({
          traceBase,
          output,
          context,
          toolAuditSource: 'journal-command',
          errorMessage: errorMessage ?? undefined,
        });
      }

      if (errorMessage) {
        await reply(`Journal command failed: ${errorMessage}`);
      } else if (output.result) {
        await reply(output.result);
      }
    } catch (err) {
      logger.error({ err }, 'Journal command failed');
      await reply(`Journal command failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  if (command.startsWith('task-')) {
    // Task commands - let agent handle with tool access
    const subCommand = command.replace('task-', '');
    const prompt = subCommand === 'list'
      ? '[TASK LIST]\nList all active (non-archived) tasks. Use getActiveDailyTasks tool. Show status, priority, and due dates.'
      : subCommand === 'status'
      ? '[TASK STATUS]\nShow status for task ID: ' + (args[0] || '(not provided)') + '\nUse getDailyTaskById tool. If no ID provided, ask for it.'
      : subCommand === 'complete'
      ? '[TASK COMPLETE]\nMark task as complete: ' + (args[0] || '(not provided)') + '\nUse updateDailyTask to set status to \"completed\".'
      : subCommand === 'create'
      ? '[TASK CREATE]\nCreate a new task: ' + (args.join(' ') || '(not provided)') + '\nUse createDailyTask tool. Ask for any missing required info.'
      : subCommand === 'archive'
      ? '[TASK ARCHIVE]\nArchive task: ' + (args[0] || '(not provided)') + '\nUse updateDailyTask to set status to \"archived\".'
      : '[TASK ' + subCommand.toUpperCase() + ']\n' + (args.join(' ') || '(no args provided)') + '\nUse appropriate daily task tools.';

    try {
      const traceBase = createTraceBase({
        chatId: params.chatId,
        groupFolder: group.folder,
        userId: params.senderId,
        inputText: prompt,
        source: 'task-command'
      });

      const execution = await executeAgentRun({
        group,
        prompt,
        chatJid: params.chatId,
        userId: params.senderId,
        userName: params.senderName,
        recallQuery: 'daily tasks',
        recallMaxResults: 3,
        recallMaxTokens: 300,
        sessionId: sessions[group.folder],
        onSessionUpdate: (sessionId) => { sessions[group.folder] = sessionId; },
        availableGroups: buildAvailableGroupsSnapshot(),
        modelMaxOutputTokens: 1500,
        maxToolSteps: 30,
        lane: 'interactive',
      });

      const context = execution.context;
      const output = execution.output;
      const errorMessage = output.status === 'error' ? (output.error || 'Unknown error') : null;

      if (context) {
        recordAgentTelemetry({
          traceBase,
          output,
          context,
          toolAuditSource: 'task-command',
          errorMessage: errorMessage ?? undefined,
        });
      }

      if (errorMessage) {
        await reply(`Task command failed: ${errorMessage}`);
      } else if (output.result) {
        await reply(output.result);
      }
    } catch (err) {
      logger.error({ err }, 'Task command failed');
      await reply(`Task command failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  if (command === 'daily-plan' || command === 'plan') {
    // Start daily planning conversation
    const extraContext = args.length > 0 ? '\nUser provided context: ' + args.join(' ') : '';
    const prompt = [
      '[DAILY PLANNING]',
      'Initiate a collaborative daily planning session with the user.',
      '',
      'Your role is to be a thoughtful accountability partner. Help the user plan their day with realistic goals.',
      '',
      'Process:',
      '1. Gather context - use get_planning_context to see yesterday\'s outcomes and active tasks',
      '2. Understand priorities - ask about deadlines, energy levels, focus areas',
      '3. For each main task, use breakdown_task to create subtasks (max 10)',
      '4. Push back on overcommitment - max 3-5 major tasks per day',
      '5. For finalized tasks, use create_task_thread to make forum threads with polls',
      '',
      'Be conversational and encouraging. Celebrate yesterday\'s wins. Ask clarifying questions.',
      'At the end, summarize the plan with all threads created.' + extraContext
    ].join('\n');

    try {
      const traceBase = createTraceBase({
        chatId: params.chatId,
        groupFolder: group.folder,
        userId: params.senderId,
        inputText: prompt,
        source: 'daily-planning'
      });
      const routingDecision = routeRequest();

      const execution = await executeAgentRun({
        group,
        prompt,
        chatJid: params.chatId,
        userId: params.senderId,
        userName: params.senderName,
        recallQuery: 'daily planning tasks goals yesterday',
        recallMaxResults: Math.max(5, routingDecision.recallMaxResults),
        recallMaxTokens: routingDecision.recallMaxTokens,
        sessionId: sessions[group.folder],
        onSessionUpdate: (sessionId) => { sessions[group.folder] = sessionId; },
        availableGroups: buildAvailableGroupsSnapshot(),
        modelMaxOutputTokens: routingDecision.maxOutputTokens,
        maxToolSteps: routingDecision.maxToolSteps,
        lane: 'interactive',
      });

      const context = execution.context;
      const output = execution.output;
      const errorMessage = output.status === 'error' ? (output.error || 'Unknown error') : null;

      if (context) {
        recordAgentTelemetry({
          traceBase,
          output,
          context,
          toolAuditSource: 'daily-planning',
          errorMessage: errorMessage ?? undefined,
        });
      }

      if (errorMessage) {
        await reply(`Daily planning failed: ${errorMessage}`);
      } else if (output.result) {
        await reply(output.result);
      }
    } catch (err) {
      logger.error({ err }, 'Daily planning agent run failed');
      await reply(`Daily planning failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // End Daily Planning Commands
  // ═══════════════════════════════════════════════════════════════════════════════

  await reply('Unknown command. Use `/dotclaw help` for options.');
  return true;
}

// ───────────────────────── Heartbeat ─────────────────────────

async function runHeartbeatOnce(): Promise<void> {
  const entry = Object.entries(registeredGroups).find(([, group]) => group.folder === HEARTBEAT_GROUP_FOLDER);
  if (!entry) {
    logger.warn({ group: HEARTBEAT_GROUP_FOLDER }, 'Heartbeat group not registered');
    return;
  }
  const [chatId, group] = entry;
  const prompt = [
    '[HEARTBEAT]',
    'You are running automatically. Review scheduled tasks, pending reminders, and long-running work.',
    'If you need to communicate, use mcp__dotclaw__send_message. Otherwise, take no user-visible action.'
  ].join('\n');

  const traceBase = createTraceBase({
    chatId,
    groupFolder: group.folder,
    userId: null,
    inputText: prompt,
    source: 'dotclaw-heartbeat'
  });
  const routingDecision = routeRequest();

  let output: ContainerOutput | null = null;
  let context: AgentContext | null = null;
  let errorMessage: string | null = null;

  try {
    const execution = await executeAgentRun({
      group,
      prompt,
      chatJid: chatId,
      userId: null,
      recallQuery: prompt,
      recallMaxResults: Math.max(4, routingDecision.recallMaxResults - 2),
      recallMaxTokens: Math.max(600, routingDecision.recallMaxTokens - 200),
      sessionId: sessions[group.folder],
      onSessionUpdate: (sessionId) => { sessions[group.folder] = sessionId; },
      isScheduledTask: true,
      availableGroups: buildAvailableGroupsSnapshot(),
      modelMaxOutputTokens: routingDecision.maxOutputTokens,
      maxToolSteps: routingDecision.maxToolSteps,
      lane: 'maintenance',
    });
    output = execution.output;
    context = execution.context;
    if (output.status === 'error') {
      errorMessage = output.error || 'Unknown error';
    }
  } catch (err) {
    if (err instanceof AgentExecutionError) {
      context = err.context;
      errorMessage = err.message;
    } else {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    logger.error({ err }, 'Heartbeat run failed');
  }

  if (context) {
    recordAgentTelemetry({
      traceBase,
      output,
      context,
      toolAuditSource: 'heartbeat',
      errorMessage: errorMessage ?? undefined,
    });
  } else if (errorMessage) {
    writeTrace({
      trace_id: traceBase.trace_id,
      timestamp: traceBase.timestamp,
      created_at: traceBase.created_at,
      chat_id: traceBase.chat_id,
      group_folder: traceBase.group_folder,
      user_id: traceBase.user_id,
      input_text: traceBase.input_text,
      output_text: null,
      model_id: 'unknown',
      memory_recall: [],
      error_code: errorMessage,
      source: traceBase.source
    });
  }
}

let heartbeatStopped = false;

function stopHeartbeatLoop(): void {
  heartbeatStopped = true;
}

function startHeartbeatLoop(): void {
  if (!HEARTBEAT_ENABLED) return;
  heartbeatStopped = false;
  const loop = async () => {
    if (heartbeatStopped) return;
    try {
      await runHeartbeatOnce();
    } catch (err) {
      logger.error({ err }, 'Heartbeat run failed');
    }
    if (!heartbeatStopped) {
      setTimeout(loop, HEARTBEAT_INTERVAL_MS);
    }
  };
  loop();
}

// ───────────────────────── Provider Event Handlers ─────────────────────────

function createProviderHandlers(
  registry: ProviderRegistry,
  pipeline: ReturnType<typeof createMessagePipeline>
) {
  return {
    onMessage(incoming: IncomingMessage): void {
      const chatId = incoming.chatId;
      const group = registeredGroups[chatId];
      const groupFolder = group?.folder;

      // Log & persist
      const chatName = (incoming.rawProviderData as Record<string, unknown>)?.chatName as string || incoming.senderName;
      try {
        upsertChat({ chatId, name: chatName, lastMessageTime: incoming.timestamp });
        const dbAttachments: MessageAttachment[] | undefined = incoming.attachments?.map(providerAttachmentToMessageAttachment);
        storeMessage(
          incoming.messageId,
          chatId,
          incoming.senderId,
          incoming.senderName,
          incoming.content,
          incoming.timestamp,
          false,
          dbAttachments
        );
      } catch (error) {
        logger.error({ error, chatId }, 'Failed to persist message');
      }

      setLastMessageTime(new Date().toISOString());
      recordMessage(ProviderRegistry.getPrefix(chatId));

      // Admin commands (async, fire-and-forget with early return)
      const providerName = ProviderRegistry.getPrefix(chatId);
      const provider = registry.get(providerName);
      const botUsername = provider && 'botUsername' in provider ? (provider as unknown as { botUsername: string }).botUsername : undefined;

      void (async () => {
        try {
          if (incoming.content) {
            const sendReply = async (cId: string, text: string) => {
              await registry.getProviderForChat(cId).sendMessage(cId, text);
            };
            const adminHandled = await handleAdminCommand({
              chatId,
              senderId: incoming.senderId,
              senderName: incoming.senderName,
              content: incoming.content,
              botUsername,
            }, sendReply);
            if (adminHandled) return;
          }

          // Check trigger/mention/reply
          const isPrivate = incoming.chatType === 'private' || incoming.chatType === 'dm';
          const isGroup = incoming.isGroup;
          const mentioned = provider ? provider.isBotMentioned(incoming) : false;
          const replied = provider ? provider.isBotReplied(incoming) : false;
          const triggerRegex = isGroup && group?.trigger ? buildTriggerRegex(group.trigger) : null;
          const triggered = Boolean(triggerRegex && incoming.content && triggerRegex.test(incoming.content));
          // Owner bypass: bot responds to any message from the Discord owner
          // Read directly from process.env since dotenv is loaded before this handler runs
          const discordOwnerId = process.env.DISCORD_OWNER_ID || '';
          const isOwner = discordOwnerId && incoming.senderId === discordOwnerId;
          // Check if channel is excluded (bot won't respond even to owner in excluded channels)
          const excludedChannels = (process.env.DISCORD_EXCLUDED_CHANNELS || '').split(',').map(id => id.trim()).filter(Boolean);
          const rawChannelId = ProviderRegistry.stripPrefix(chatId);
          const isExcludedChannel = excludedChannels.includes(rawChannelId);
          const shouldProcess = !isExcludedChannel && (isPrivate || mentioned || replied || triggered || isOwner);

          // Debug logging for message processing
          logger.debug({
            chatId,
            rawChannelId,
            senderId: incoming.senderId,
            discordOwnerId,
            isOwner,
            isPrivate,
            mentioned,
            replied,
            triggered,
            isExcludedChannel,
            shouldProcess,
            groupExists: !!group,
            groupName: group?.name
          }, 'Message processing check');

          if (!shouldProcess) return;

          // Rate limiting — qualify key by provider to avoid cross-provider collisions
          const rateKey = `${ProviderRegistry.getPrefix(chatId)}:${incoming.senderId}`;
          const rateCheck = checkRateLimit(rateKey);
          if (!rateCheck.allowed) {
            const retryAfterSec = Math.ceil((rateCheck.retryAfterMs || 60000) / 1000);
            logger.warn({ senderId: incoming.senderId, retryAfterSec }, 'Rate limit exceeded');
            await registry.getProviderForChat(chatId).sendMessage(
              chatId,
              `You're sending messages too quickly. Please wait ${retryAfterSec} seconds and try again.`,
              { threadId: incoming.threadId }
            );
            return;
          }

          // Download attachments
          const attachments: MessageAttachment[] = incoming.attachments?.map(providerAttachmentToMessageAttachment) ?? [];
          if (attachments.length > 0 && groupFolder) {
            let downloadedAny = false;
            const failedAttachments: Array<{ name: string; error: string }> = [];
            for (const attachment of attachments) {
              const fileRef = attachment.provider_file_ref;
              if (!fileRef) continue;
              const filename = attachment.file_name || `${attachment.type}_${incoming.messageId}`;
              const result = await provider!.downloadFile(fileRef, groupFolder, filename);
              if (result.path) {
                attachment.local_path = result.path;
                downloadedAny = true;
              } else if (result.error) {
                failedAttachments.push({ name: attachment.file_name || attachment.type, error: result.error });
              }
            }
            if (failedAttachments.length > 0) {
              const maxMB = Math.floor(provider!.capabilities.maxAttachmentBytes / (1024 * 1024));
              const messages = failedAttachments.map(f =>
                f.error === 'too_large'
                  ? `"${f.name}" is too large (over ${maxMB} MB). Try sending a smaller version.`
                  : `I couldn't download "${f.name}". Please try sending it again.`
              );
              void registry.getProviderForChat(chatId).sendMessage(chatId, messages.join('\n'), { threadId: incoming.threadId });
            }
            // Transcribe voice messages
            for (const attachment of attachments) {
              if (attachment.type === 'voice' && attachment.local_path) {
                try {
                  const transcript = await transcribeVoice(attachment.local_path);
                  if (transcript) {
                    attachment.transcript = transcript;
                  }
                } catch (err) {
                  logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Voice transcription failed');
                }
              }
            }

            if (downloadedAny) {
              try {
                storeMessage(
                  incoming.messageId,
                  chatId,
                  incoming.senderId,
                  incoming.senderName,
                  incoming.content,
                  incoming.timestamp,
                  false,
                  attachments
                );
              } catch (error) {
                logger.error({ error, chatId }, 'Failed to persist downloaded attachment paths');
              }
            }
          }

          void emitHook('message:received', {
            chat_id: chatId,
            message_id: incoming.messageId,
            sender_id: incoming.senderId,
            sender_name: incoming.senderName,
            content: incoming.content.slice(0, 500),
            is_group: isGroup,
            has_attachments: attachments.length > 0,
            has_transcript: attachments.some(a => !!a.transcript)
          });

          pipeline.enqueueMessage({
            chatId,
            messageId: incoming.messageId,
            senderId: incoming.senderId,
            senderName: incoming.senderName,
            content: incoming.content,
            timestamp: incoming.timestamp,
            isGroup,
            chatType: incoming.chatType,
            threadId: incoming.threadId,
            attachments: attachments.length > 0 ? attachments : undefined
          });
        } catch (err) {
          logger.error({ err, chatId }, 'Error processing incoming message');
        }
      })();
    },

    onReaction(chatId: string, messageId: string, userId: string | undefined, emoji: string): void {
      if (emoji !== '👍' && emoji !== '👎') return;
      const traceId = getTraceIdForMessage(messageId, chatId);
      if (!traceId) {
        logger.debug({ chatId, messageId }, 'No trace found for reacted message');
        return;
      }
      const feedbackType = emoji === '👍' ? 'positive' : 'negative';
      recordUserFeedback({
        trace_id: traceId,
        message_id: messageId,
        chat_jid: chatId,
        feedback_type: feedbackType,
        user_id: userId
      });
      logger.info({ chatId, messageId, feedbackType, traceId }, 'User feedback recorded');
    },

    onButtonClick(chatId: string, senderId: string, senderName: string, label: string, data: string, threadId?: string): void {
      const group = registeredGroups[chatId];
      if (!group) return;
      const chatType = 'private'; // Best guess for callback queries
      const isGroup = false;
      const timestamp = new Date().toISOString();
      const syntheticMessageId = String((Date.now() * 1000) + Math.floor(Math.random() * 1000));
      const syntheticContent = `[Button clicked: "${label}"] callback_data: ${data}`;

      upsertChat({ chatId, lastMessageTime: timestamp });
      storeMessage(syntheticMessageId, chatId, senderId, senderName, syntheticContent, timestamp, false);

      pipeline.enqueueMessage({
        chatId,
        messageId: syntheticMessageId,
        senderId,
        senderName,
        content: syntheticContent,
        timestamp,
        isGroup,
        chatType,
        threadId,
      });
    }
  };
}

// ───────────────────────── Wake Recovery ─────────────────────────

let providerRegistry: ProviderRegistry;
let messagePipeline: ReturnType<typeof createMessagePipeline>;

async function onWakeRecovery(sleepDurationMs: number): Promise<void> {
  logger.info({ sleepDurationMs }, 'Running wake recovery');

  // 1. Suppress daemon health check kills for 60s
  suppressHealthChecks(60_000);
  resetUnhealthyDaemons();

  // 2. Reconnect all providers (skip those that were never started)
  for (const provider of providerRegistry.getAllProviders()) {
    if (!provider.isConnected()) {
      logger.debug({ provider: provider.name }, 'Skipping wake reconnect for inactive provider');
      continue;
    }
    try {
      if (provider.name === 'telegram') setTelegramConnected(false);
      await provider.stop();
      await sleep(1_000);
      await provider.start(createProviderHandlers(providerRegistry, messagePipeline));
      if (provider.name === 'telegram') setTelegramConnected(true);
      logger.info({ provider: provider.name }, 'Provider reconnected after wake');
    } catch (err) {
      logger.error({ err, provider: provider.name }, 'Failed to reconnect provider after wake');
    }
  }

  // 3. Reset stalled messages
  try {
    const resetCount = resetStalledMessages(1_000);
    if (resetCount > 0) logger.info({ resetCount }, 'Reset stalled messages after wake');
  } catch (err) {
    logger.error({ err }, 'Failed to reset stalled messages after wake');
  }

  // 4. Re-drain pending message queues
  try {
    const pendingChats = getChatsWithPendingMessages();
    const activeDrains = getActiveDrains();
    for (const chatId of pendingChats) {
      if (registeredGroups[chatId] && !activeDrains.has(chatId)) {
        void messagePipeline.drainQueue(chatId);
      }
    }
  } catch (err) {
    logger.error({ err }, 'Failed to resume message drains after wake');
  }
}

// ───────────────────────── Docker Check ─────────────────────────

function ensureDockerRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    logger.debug('Docker daemon is running');
  } catch {
    logger.error('Docker daemon is not running');
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Docker is not running                                  ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without Docker. To fix:                     ║');
    console.error('║  macOS: Start Docker Desktop                                   ║');
    console.error('║  Linux: sudo systemctl start docker                            ║');
    console.error('║                                                                ║');
    console.error('║  Install from: https://docker.com/products/docker-desktop      ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Docker is required but not running');
  }
}

// ───────────────────────── Main ─────────────────────────

async function main(): Promise<void> {
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception');
    if (err instanceof RangeError || err instanceof TypeError) {
      logger.error('Fatal uncaught exception — exiting');
      process.exit(1);
    }
  });

  const { ensureDirectoryStructure } = await import('./paths.js');
  ensureDirectoryStructure();

  try {
    const envStat = fs.existsSync(ENV_PATH) ? fs.statSync(ENV_PATH) : null;
    if (!envStat || envStat.size === 0) {
      logger.warn({ envPath: ENV_PATH }, '.env is missing or empty; run "dotclaw configure" to set up provider tokens and API keys');
    }
  } catch (err) {
    logger.warn({ envPath: ENV_PATH, err }, 'Failed to check .env file');
  }

  ensureDockerRunning();
  // Clean up stale stream directories from crashed processes
  try {
    const ipcBase = path.join(DATA_DIR, 'ipc');
    if (fs.existsSync(ipcBase)) {
      const cutoff = Date.now() - 10 * 60 * 1000; // 10 minutes
      for (const groupDir of fs.readdirSync(ipcBase)) {
        const streamBase = path.join(ipcBase, groupDir, 'stream');
        if (!fs.existsSync(streamBase)) continue;
        try {
          for (const traceDir of fs.readdirSync(streamBase)) {
            const fullPath = path.join(streamBase, traceDir);
            try {
              const stat = fs.statSync(fullPath);
              if (stat.isDirectory() && stat.mtimeMs < cutoff) {
                fs.rmSync(fullPath, { recursive: true, force: true });
              }
            } catch { /* ignore individual dir errors */ }
          }
        } catch { /* ignore read errors */ }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up stale stream directories');
  }

  initDatabase();
  const resetCount = resetStalledMessages();
  if (resetCount > 0) {
    logger.info({ resetCount }, 'Reset stalled queue messages to pending');
  }
  initMemoryStore();
  startEmbeddingWorker();
  const expiredMemories = cleanupExpiredMemories();
  if (expiredMemories > 0) {
    logger.info({ expiredMemories }, 'Expired memories cleaned up');
  }
  logger.info('Database initialized');
  if (CONTAINER_PRIVILEGED) {
    logger.warn('Container privileged mode is enabled by default; agent containers run as root.');
  }
  startMetricsServer();
  loadState();

  // ──── Provider Registry ────
  providerRegistry = new ProviderRegistry();

  // Register Telegram provider (optional — only when enabled + token present)
  let telegramProvider: ReturnType<typeof createTelegramProvider> | null = null;
  if (runtime.host.telegram.enabled && process.env.TELEGRAM_BOT_TOKEN) {
    telegramProvider = createTelegramProvider(runtime, GROUPS_DIR);
    providerRegistry.register(telegramProvider);
    logger.info('Telegram provider registered');
  } else if (runtime.host.telegram.enabled && !process.env.TELEGRAM_BOT_TOKEN) {
    logger.warn('Telegram is enabled in config but TELEGRAM_BOT_TOKEN is not set — skipping');
  }

  // Register Discord provider (optional — only when enabled + token present)
  let discordProvider: MessagingProvider | null = null;
  if (runtime.host.discord.enabled && process.env.DISCORD_BOT_TOKEN) {
    const { createDiscordProvider } = await import('./providers/discord/index.js');
    discordProvider = createDiscordProvider(runtime, () => registeredGroups);
    providerRegistry.register(discordProvider);
    logger.info('Discord provider registered');
  } else if (runtime.host.discord.enabled && !process.env.DISCORD_BOT_TOKEN) {
    logger.warn('Discord is enabled in config but DISCORD_BOT_TOKEN is not set — skipping');
  }

  // ──── Message Pipeline ────
  messagePipeline = createMessagePipeline({
    registry: providerRegistry,
    registeredGroups: () => registeredGroups,
    sessions: () => sessions,
    setSession: (folder, id) => {
      sessions[folder] = id;
      setGroupSession(folder, id);
    },
    buildAvailableGroupsSnapshot,
  });

  // Warm containers
  if (CONTAINER_MODE === 'daemon' && WARM_START_ENABLED) {
    const groups = Object.values(registeredGroups);
    for (const group of groups) {
      try {
        warmGroupContainer(group, group.folder === MAIN_GROUP_FOLDER);
        logger.info({ group: group.folder }, 'Warmed daemon container');
      } catch (err) {
        logger.warn({ group: group.folder, err }, 'Failed to warm daemon container');
      }
    }
  }

  // Resume pending message queues from before restart
  const pendingChats = getChatsWithPendingMessages();
  for (const chatId of pendingChats) {
    if (registeredGroups[chatId]) {
      logger.info({ chatId }, 'Resuming message queue drain after restart');
      void messagePipeline.drainQueue(chatId);
    }
  }

  // Start dashboard
  startDashboard();

  // Start webhook server (optional)
  try {
    startWebhookServer(runtime.host.webhook, {
      registeredGroups: () => registeredGroups,
      sessions: () => sessions,
      setSession: (folder, id) => {
        sessions[folder] = id;
        setGroupSession(folder, id);
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start webhook server');
  }

  // ──── Start Providers ────
  const handlers = createProviderHandlers(providerRegistry, messagePipeline);

  try {
    if (telegramProvider) {
      await telegramProvider.start(handlers);
      setTelegramConnected(true);
      logger.info('Telegram bot started');
    }

    if (discordProvider) {
      await discordProvider.start(handlers);
      // Capture bot ID for command sync
      if (discordProvider.getBotId) {
        discordBotId = discordProvider.getBotId();
        logger.info({ botId: discordBotId }, 'Discord bot ID captured for command sync');

        // Auto-sync commands on startup if DISCORD_GUILD_ID is set (guild commands = instant)
        const guildId = process.env.DISCORD_GUILD_ID;
        if (guildId) {
          logger.info('Auto-syncing Discord slash commands on startup...');
          const syncResult = await registerSlashCommands({
            token: process.env.DISCORD_BOT_TOKEN!,
            clientId: discordBotId,
            guildId,
          });
          if (syncResult.success) {
            logger.info({ count: syncResult.count }, 'Discord slash commands synced on startup');
          } else {
            logger.warn({ error: syncResult.error }, 'Failed to sync Discord slash commands on startup');
          }
        }
      }
      logger.info('Discord bot started');
    }

    if (!telegramProvider && !discordProvider) {
      throw new Error('No messaging providers configured. Set TELEGRAM_BOT_TOKEN and/or DISCORD_BOT_TOKEN.');
    }

    // Graceful shutdown
    let shuttingDown = false;
    const gracefulShutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'Graceful shutdown initiated');

      // 1. Stop accepting new work (webhook + providers)
      stopWebhookServer();
      setTelegramConnected(false);
      for (const p of providerRegistry.getAllProviders()) {
        try { await p.stop(); } catch { /* ignore */ }
      }

      // 2. Stop all loops and watchers
      clearInterval(rateLimiterInterval);
      stopSchedulerLoop();
      stopIpcWatcher();
      stopMaintenanceLoop();
      stopHeartbeatLoop();
      stopDaemonHealthCheckLoop();
      stopWakeDetector();
      await stopEmbeddingWorker();

      // 3. Stop HTTP servers
      stopMetricsServer();
      stopDashboard();

      // 4. Abort active agent runs so drain loops can finish quickly
      const activeRuns = getActiveRuns();
      for (const [chatId, controller] of activeRuns.entries()) {
        logger.info({ chatId }, 'Aborting active agent run for shutdown');
        controller.abort();
      }

      // Wait for active drain loops to finish
      const activeDrains = getActiveDrains();
      const drainDeadline = Date.now() + 30_000;
      while (activeDrains.size > 0 && Date.now() < drainDeadline) {
        await new Promise(r => setTimeout(r, 200));
      }
      if (activeDrains.size > 0) {
        logger.warn({ count: activeDrains.size }, 'Force-closing with active drains');
      }

      // 5. Clean up Docker containers for this instance
      cleanupInstanceContainers();

      // 6. Close databases
      closeMemoryStore();
      closeDatabase();

      logger.info('Shutdown complete');
      process.exit(0);
    };
    process.once('SIGINT', () => void gracefulShutdown('SIGINT'));
    process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'));

    // ──── Start Services ────
    const sendMessageForScheduler = async (jid: string, text: string): Promise<void> => {
      const result = await providerRegistry.getProviderForChat(jid).sendMessage(jid, text);
      if (!result.success) {
        throw new Error(`Failed to send message to chat ${jid}`);
      }
    };
    startSchedulerLoop({
      sendMessage: sendMessageForScheduler,
      registeredGroups: () => registeredGroups,
      getSessions: () => sessions,
      setSession: (groupFolder, sessionId) => {
        sessions[groupFolder] = sessionId;
        setGroupSession(groupFolder, sessionId);
      }
    });
    startIpcWatcher({
      registry: providerRegistry,
      registeredGroups: () => registeredGroups,
      registerGroup,
      unregisterGroup,
      listRegisteredGroups,
      sessions: () => sessions,
      setSession: (folder, id) => {
        sessions[folder] = id;
        setGroupSession(folder, id);
      }
    });
    startMaintenanceLoop();
    startHeartbeatLoop();
    startDaemonHealthCheckLoop(() => registeredGroups, MAIN_GROUP_FOLDER);
    startWakeDetector((ms) => { void onWakeRecovery(ms); });

    const ownerConfigured = process.env.DISCORD_OWNER_ID ? '(owner mode enabled)' : '';
    logger.info(`DotClaw running (responds to DMs, group mentions/replies ${ownerConfigured})`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ err: error instanceof Error ? error : new Error(msg) }, 'Failed to start DotClaw');
    console.error(`[dotclaw] FATAL: ${msg}`);
    process.exit(1);
  }
}

main().catch(err => {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error({ err }, 'Failed to start DotClaw');
  console.error(`[dotclaw] FATAL: ${msg}`);
  process.exit(1);
});
