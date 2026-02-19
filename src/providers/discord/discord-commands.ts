/**
 * Discord Slash Commands
 *
 * Registers Discord native slash commands using the REST API.
 * Guild commands update instantly, global commands take up to 1 hour.
 *
 * Key insights from Discord.js documentation:
 * - Use SlashCommandBuilder to define commands
 * - Use REST.put() with Routes for registration
 * - Guild commands: instant updates, rate limit 200/day per guild
 * - Global commands: up to 1 hour propagation, rate limit 200/day
 * - Command names: lowercase, 1-32 chars, regex: ^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$
 * - Bot needs 'applications.commands' scope in invite URL
 */

import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { logger } from '../../logger.js';

export interface DiscordCommandConfig {
  token: string;
  clientId: string;
  guildId?: string; // If provided, register as guild commands (instant). If not, global (1hr).
}

export interface SlashCommandDefinition {
  name: string;
  description: string;
  options?: Array<{ name: string; description: string; required?: boolean; type: number }>;
}

/**
 * Convert a simple command definition to SlashCommandBuilder
 */
function buildCommand(def: SlashCommandDefinition): SlashCommandBuilder {
  const builder = new SlashCommandBuilder()
    .setName(def.name)
    .setDescription(def.description);

  if (def.options) {
    for (const opt of def.options) {
      // Discord.js option types: 1=SUB_COMMAND, 2=SUB_COMMAND_GROUP, 3=STRING, 4=INTEGER, 5=BOOLEAN, 6=USER, 7=CHANNEL, 8=ROLE, 9=MENTIONABLE, 10=NUMBER, 11=ATTACHMENT
      switch (opt.type) {
        case 3: // STRING
          builder.addStringOption(o =>
            o.setName(opt.name).setDescription(opt.description).setRequired(opt.required ?? false)
          );
          break;
        case 4: // INTEGER
          builder.addIntegerOption(o =>
            o.setName(opt.name).setDescription(opt.description).setRequired(opt.required ?? false)
          );
          break;
        case 5: // BOOLEAN
          builder.addBooleanOption(o =>
            o.setName(opt.name).setDescription(opt.description).setRequired(opt.required ?? false)
          );
          break;
        case 6: // USER
          builder.addUserOption(o =>
            o.setName(opt.name).setDescription(opt.description).setRequired(opt.required ?? false)
          );
          break;
        case 10: // NUMBER
          builder.addNumberOption(o =>
            o.setName(opt.name).setDescription(opt.description).setRequired(opt.required ?? false)
          );
          break;
      }
    }
  }

  return builder;
}

/**
 * All slash commands to register with Discord
 */
export const DOTCLAW_COMMANDS: SlashCommandDefinition[] = [
  // Core commands
  {
    name: 'help',
    description: 'Show available commands and help information',
  },
  {
    name: 'groups',
    description: 'List registered groups (main only)',
  },
  {
    name: 'ping',
    description: 'Check if the bot is responsive',
  },
  {
    name: 'sync-commands',
    description: 'Sync Discord slash commands',
  },

  // Daily Planning commands
  {
    name: 'briefing',
    description: 'Generate your daily briefing',
  },
  {
    name: 'recap',
    description: 'Start nightly recap conversation',
  },

  // Journal commands - use a subcommand pattern
  {
    name: 'journal',
    description: 'Manage your journal entries',
  },
  // Note: We'll use a simpler approach - separate commands for each action
  {
    name: 'journal-create',
    description: 'Create a new journal entry',
    options: [
      { name: 'sentiment', description: 'How are you feeling?', type: 3, required: false },
      { name: 'success', description: 'What went well today?', type: 3, required: false },
      { name: 'error', description: 'What challenges did you face?', type: 3, required: false },
    ],
  },
  {
    name: 'journal-today',
    description: 'Show today\'s journal entries',
  },
  {
    name: 'journal-list',
    description: 'List recent journal entries',
    options: [
      { name: 'limit', description: 'Number of entries to show', type: 4, required: false },
    ],
  },

  // Task commands
  {
    name: 'task-create',
    description: 'Create a new task',
    options: [
      { name: 'title', description: 'Task title', type: 3, required: true },
      { name: 'description', description: 'Task description', type: 3, required: false },
    ],
  },
  {
    name: 'task-list',
    description: 'List all active tasks',
  },
  {
    name: 'task-status',
    description: 'Show status of a specific task',
    options: [
      { name: 'task_id', description: 'The task ID', type: 3, required: true },
    ],
  },
  {
    name: 'task-complete',
    description: 'Mark a task as complete',
    options: [
      { name: 'task_id', description: 'The task ID to complete', type: 3, required: true },
    ],
  },
  {
    name: 'task-archive',
    description: 'Archive a task',
    options: [
      { name: 'task_id', description: 'The task ID to archive', type: 3, required: true },
    ],
  },
  {
    name: 'task-lock',
    description: 'Lock a task thread',
    options: [
      { name: 'task_id', description: 'The task ID to lock', type: 3, required: true },
    ],
  },

  // Breakdown command
  {
    name: 'breakdown',
    description: 'Break down a task into smaller subtasks',
    options: [
      { name: 'task', description: 'The task to break down', type: 3, required: true },
    ],
  },

  // Planning commands
  {
    name: 'daily-plan',
    description: 'Start your daily planning session',
  },

  // Scheduling commands
  {
    name: 'schedule-recap',
    description: 'Schedule a nightly recap',
  },
  {
    name: 'show-schedule',
    description: 'Show your scheduled recaps',
  },
  {
    name: 'planning-status',
    description: 'Show your planning workflow status',
  },
  {
    name: 'configure-workflow',
    description: 'Configure your daily planning workflow',
  },

  // Admin commands (main only)
  {
    name: 'add-group',
    description: 'Register a new group (main only)',
    options: [
      { name: 'chat_id', description: 'The chat ID', type: 3, required: true },
      { name: 'name', description: 'Group name', type: 3, required: true },
      { name: 'folder', description: 'Folder name (optional)', type: 3, required: false },
    ],
  },
  {
    name: 'remove-group',
    description: 'Remove a registered group (main only)',
    options: [
      { name: 'identifier', description: 'Chat ID, name, or folder', type: 3, required: true },
    ],
  },
  {
    name: 'set-model',
    description: 'Set the AI model (main only)',
    options: [
      { name: 'model', description: 'Model name', type: 3, required: true },
      { name: 'scope', description: 'global, group, or user', type: 3, required: false },
      { name: 'target', description: 'Target ID for group/user scope', type: 3, required: false },
    ],
  },

  // Preferences
  {
    name: 'remember',
    description: 'Remember a fact (main only)',
    options: [
      { name: 'fact', description: 'The fact to remember', type: 3, required: true },
    ],
  },
  {
    name: 'style',
    description: 'Set response style preference',
    options: [
      { name: 'style', description: 'concise, balanced, or detailed', type: 3, required: true },
    ],
  },
  {
    name: 'tools',
    description: 'Set tool usage preference',
    options: [
      { name: 'preference', description: 'conservative, balanced, or proactive', type: 3, required: true },
    ],
  },
  {
    name: 'caution',
    description: 'Set caution level preference',
    options: [
      { name: 'level', description: 'low, balanced, or high', type: 3, required: true },
    ],
  },
  {
    name: 'memory',
    description: 'Set memory retrieval preference',
    options: [
      { name: 'setting', description: 'strict, balanced, or loose', type: 3, required: true },
    ],
  },

  // Skill commands
  {
    name: 'skill-install',
    description: 'Install a skill from URL',
    options: [
      { name: 'url', description: 'Skill repository URL', type: 3, required: true },
      { name: 'global', description: 'Install globally (true/false)', type: 5, required: false },
    ],
  },
  {
    name: 'skill-remove',
    description: 'Remove an installed skill',
    options: [
      { name: 'name', description: 'Skill name', type: 3, required: true },
      { name: 'global', description: 'Remove from global (true/false)', type: 5, required: false },
    ],
  },
  {
    name: 'skill-list',
    description: 'List installed skills',
    options: [
      { name: 'global', description: 'Show global skills (true/false)', type: 5, required: false },
    ],
  },
];

/**
 * Register slash commands with Discord
 *
 * @param config - Command configuration with token, clientId, and optional guildId
 * @returns Result with count of registered commands
 */
export async function registerSlashCommands(
  config: DiscordCommandConfig
): Promise<{ success: boolean; count: number; error?: string; guildCommands?: boolean }> {
  const { token, clientId, guildId } = config;

  try {
    const rest = new REST().setToken(token);

    // Build command data
    const commandsData = DOTCLAW_COMMANDS.map(cmd => {
      const builder = buildCommand(cmd);
      return builder.toJSON();
    });

    // Determine route: guild commands (instant) vs global (1 hour)
    const route = guildId
      ? Routes.applicationGuildCommands(clientId, guildId)
      : Routes.applicationCommands(clientId);

    logger.info(
      { count: commandsData.length, guildId, global: !guildId },
      'Registering Discord slash commands'
    );

    // Register commands
    const data = await rest.put(
      route,
      { body: commandsData },
    ) as unknown as Array<{ name: string }>;

    logger.info(
      { count: data?.length || 0, guildId, global: !guildId },
      'Successfully registered Discord slash commands'
    );

    return {
      success: true,
      count: data?.length || 0,
      guildCommands: !!guildId,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error, guildId }, 'Failed to register Discord slash commands');

    // Check for common errors
    if (error.includes('Missing Access')) {
      return {
        success: false,
        count: 0,
        error: 'Missing "applications.commands" scope. Re-invite the bot with the correct scope.',
      };
    }
    if (error.includes('rate limit')) {
      return {
        success: false,
        count: 0,
        error: 'Rate limited. Discord allows 200 command registrations per day per guild.',
      };
    }

    return {
      success: false,
      count: 0,
      error,
    };
  }
}

/**
 * Clear all slash commands (useful for cleanup or testing)
 */
export async function clearSlashCommands(
  config: DiscordCommandConfig
): Promise<{ success: boolean; count: number; error?: string }> {
  const { token, clientId, guildId } = config;

  try {
    const rest = new REST().setToken(token);

    const route = guildId
      ? Routes.applicationGuildCommands(clientId, guildId)
      : Routes.applicationCommands(clientId);

    logger.info({ guildId, global: !guildId }, 'Clearing Discord slash commands');

    const data = await rest.put(route, { body: [] }) as unknown as unknown[];

    logger.info(
      { count: Array.isArray(data) ? data.length : 0 },
      'Successfully cleared Discord slash commands'
    );

    return {
      success: true,
      count: Array.isArray(data) ? data.length : 0,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error, guildId }, 'Failed to clear Discord slash commands');
    return {
      success: false,
      count: 0,
      error,
    };
  }
}

/**
 * List currently registered commands (useful for debugging)
 */
export async function listRegisteredCommands(
  config: DiscordCommandConfig
): Promise<{ success: boolean; commands: Array<{ name: string; id: string }>; error?: string }> {
  const { token, clientId, guildId } = config;

  try {
    const rest = new REST().setToken(token);

    const route = guildId
      ? Routes.applicationGuildCommands(clientId, guildId)
      : Routes.applicationCommands(clientId);

    const data = await rest.get(route) as unknown as Array<{ name: string; id: string }>;

    return {
      success: true,
      commands: data || [],
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error, guildId }, 'Failed to list Discord slash commands');
    return {
      success: false,
      commands: [],
      error,
    };
  }
}
