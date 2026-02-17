import { loadRuntimeConfig } from './runtime-config.js';
import {
  CONFIG_DIR,
  DATA_DIR,
  GROUPS_DIR,
  STORE_DIR,
  LOGS_DIR,
  TRACES_DIR,
  PROMPTS_DIR,
  MODEL_CONFIG_PATH,
  MOUNT_ALLOWLIST_PATH,
  ENV_PATH,
} from './paths.js';

const runtime = loadRuntimeConfig();

// ── Discord Channel Configuration ────────────────────────────────────────

export interface DiscordChannelConfig {
  channelId: string;
  channelName: string;
  channelType: 'text' | 'voice' | 'forum';
  description: string;
  defaultSkill?: string;
}

let cachedChannelConfig: Map<string, DiscordChannelConfig> | null = null;

export function getDiscordChannelConfig(): Map<string, DiscordChannelConfig> {
  if (cachedChannelConfig) return cachedChannelConfig;

  const envValue = process.env.DISCORD_CHANNELS || '';
  const config = new Map<string, DiscordChannelConfig>();

  // Support both formats:
  // 1. Newline-separated entries (for multi-line .env with backslash continuations)
  // 2. Double-pipe (||) separated entries on a single line (for dotenv single-line format)

  // First, try splitting by newlines (handles shell script format)
  let entries: string[];
  if (envValue.includes('\n')) {
    entries = envValue.split('\n');
  } else {
    // Single-line format: split by double-pipe delimiter ||
    entries = envValue.split('||').filter(e => e.trim());
  }

  for (const entry of entries) {
    const trimmed = entry.trim();
    // Handle backslash line continuations
    const cleanLine = trimmed.endsWith('\\') ? trimmed.slice(0, -1).trim() : trimmed;
    if (!cleanLine) continue;

    const parts = cleanLine.split('|');
    if (parts.length < 3) continue;

    const [channelId, channelName, channelType, description, defaultSkill] = parts;

    if (channelId && channelName && channelType) {
      const validTypes = ['text', 'voice', 'forum'];
      const normalizedType = channelType.toLowerCase().trim();
      if (!validTypes.includes(normalizedType)) continue;

      config.set(channelId.trim(), {
        channelId: channelId.trim(),
        channelName: channelName.trim(),
        channelType: normalizedType as 'text' | 'voice' | 'forum',
        description: description?.trim() || '',
        defaultSkill: defaultSkill?.trim() || undefined,
      });
    }
  }

  cachedChannelConfig = config;
  return config;
}

export function getChannelConfig(channelId: string): DiscordChannelConfig | undefined {
  return getDiscordChannelConfig().get(channelId);
}

export function invalidateChannelConfigCache(): void {
  cachedChannelConfig = null;
}

// Re-export paths for convenience
export {
  CONFIG_DIR,
  DATA_DIR,
  GROUPS_DIR,
  STORE_DIR,
  LOGS_DIR,
  MOUNT_ALLOWLIST_PATH,
  ENV_PATH,
};

export const SCHEDULER_POLL_INTERVAL = runtime.host.scheduler.pollIntervalMs;

export const MAIN_GROUP_FOLDER = 'main';
export { MODEL_CONFIG_PATH };

// Use runtime config values with fallback to paths module defaults
export const PROMPT_PACKS_DIR = runtime.host.promptPacksDir || PROMPTS_DIR;
export const TRACE_DIR = runtime.host.trace.dir || TRACES_DIR;
export const TRACE_SAMPLE_RATE = runtime.host.trace.sampleRate;

export const CONTAINER_IMAGE = runtime.host.container.image;
export const CONTAINER_TIMEOUT = runtime.host.container.timeoutMs;
export const CONTAINER_MAX_OUTPUT_SIZE = runtime.host.container.maxOutputBytes;
export const IPC_POLL_INTERVAL = runtime.host.ipc.pollIntervalMs;
export const CONTAINER_MODE = runtime.host.container.mode;
export const CONTAINER_PRIVILEGED = runtime.host.container.privileged;
export const CONTAINER_DAEMON_POLL_MS = runtime.host.container.daemonPollMs;
export const CONTAINER_PIDS_LIMIT = runtime.host.container.pidsLimit;
export const CONTAINER_MEMORY = runtime.host.container.memory;
export const CONTAINER_CPUS = runtime.host.container.cpus;
export const CONTAINER_READONLY_ROOT = runtime.host.container.readOnlyRoot;
export const CONTAINER_TMPFS_SIZE = runtime.host.container.tmpfsSize;

export const CONTAINER_RUN_UID = runtime.host.container.runUid;
export const CONTAINER_RUN_GID = runtime.host.container.runGid;

// Discord owner ID (bot will respond to any message from this user)
export const DISCORD_OWNER_ID = runtime.host.discord.ownerId || process.env.DISCORD_OWNER_ID || '';

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE = runtime.host.timezone;

export const MAX_CONCURRENT_AGENTS = runtime.host.concurrency.maxAgents;
export const AGENT_QUEUE_TIMEOUT_MS = runtime.host.concurrency.queueTimeoutMs;
export const WARM_START_ENABLED = runtime.host.concurrency.warmStart;
export const AGENT_LANE_STARVATION_MS = runtime.host.concurrency.laneStarvationMs;
export const AGENT_MAX_CONSECUTIVE_INTERACTIVE = runtime.host.concurrency.maxConsecutiveInteractive;
export const TRACE_RETENTION_DAYS = runtime.host.trace.retentionDays;
export const MAINTENANCE_INTERVAL_MS = runtime.host.maintenance.intervalMs;
export const BATCH_WINDOW_MS = runtime.host.messageQueue.batchWindowMs;
export const MAX_BATCH_SIZE = runtime.host.messageQueue.maxBatchSize ?? 50;
export const TASK_LOG_RETENTION_MS = 2_592_000_000; // 30 days
