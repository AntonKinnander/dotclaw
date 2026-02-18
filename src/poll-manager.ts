/**
 * Poll Manager Module
 *
 * Manages Discord poll-based checklists for daily task subtasks.
 * Integrates with Discord.js Poll API and the daily task database.
 */

import { logger } from './logger.js';
import type { DiscordProvider } from './providers/discord/discord-provider.js';

/**
 * Poll checklist data structure
 * Matches the poll_data format in DailyTask
 */
export interface PollChecklist {
  question: string;  // Main task title
  answers: Array<{
    id: number;      // Discord answer ID
    text: string;    // "🔧 Fix authentication" (emoji prefix)
    emoji?: string;
    checked: boolean;
  }>;
}

/**
 * Options for creating a task poll
 */
export interface CreatePollOptions {
  duration?: number;  // Poll duration in hours (default: 24)
  allowMultiselect?: boolean;  // Allow multiple selections (default: true)
}

/**
 * Poll creation result
 */
export interface PollCreateResult {
  pollId: string | null;
  messageId: string | null;
  error?: string;
}

/**
 * Convert subtask titles to Discord poll answers format.
 * Each subtask should start with an emoji for visual clarity.
 *
 * @param subtasks - Array of subtask strings (e.g., ["🔧 Fix auth", "✨ Add feature"])
 * @returns Array of poll answer objects
 */
export function subtasksToPollAnswers(subtasks: string[]): Array<{ text: string }> {
  return subtasks.slice(0, 10).map(text => ({ text }));  // Discord polls max 10 answers
}

/**
 * Poll Manager class for managing Discord poll-based checklists
 */
export class PollManager {
  private discordProvider: DiscordProvider | null = null;

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
   * Create a poll in a Discord thread for task subtasks.
   * The poll represents a checklist of subtasks that users can vote on.
   *
   * @param taskId - Task ID (for reference)
   * @param mainTask - Main task title (used as poll question)
   * @param subtasks - Array of subtask strings (max 10)
   * @param channelId - Discord channel ID
   * @param threadId - Discord thread ID (optional, creates in channel if null)
   * @param options - Poll creation options
   * @returns Poll creation result with poll ID and message ID
   */
  async createTaskPoll(
    taskId: string,
    mainTask: string,
    subtasks: string[],
    channelId: string,
    threadId: string | null = null,
    options: CreatePollOptions = {}
  ): Promise<PollCreateResult> {
    if (!this.discordProvider) {
      return { pollId: null, messageId: null, error: 'Discord provider not available' };
    }

    // Limit to 10 subtasks (Discord poll limit)
    const limitedSubtasks = subtasks.slice(0, 10);
    if (limitedSubtasks.length === 0) {
      return { pollId: null, messageId: null, error: 'No subtasks provided' };
    }

    try {
      // Create poll using Discord provider's sendPoll method
      const targetChannelId = threadId || channelId;
      const result = await this.discordProvider.sendPoll(
        targetChannelId,
        mainTask,
        limitedSubtasks,
        {
          allowsMultipleAnswers: options.allowMultiselect ?? true,
        }
      );

      if (!result.success || !result.messageId) {
        return { pollId: null, messageId: null, error: 'Failed to create poll' };
      }

      // Extract poll ID from message ID (for Discord v14, poll is embedded in the message)
      const pollId = result.messageId;  // Discord uses message ID for poll reference

      logger.info({
        taskId,
        pollId,
        channelId,
        threadId,
        subtaskCount: limitedSubtasks.length
      }, 'Created task poll');

      return { pollId, messageId: result.messageId };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ taskId, channelId, threadId, error }, 'Error creating task poll');
      return { pollId: null, messageId: null, error };
    }
  }

  /**
   * Fetch the current poll state from Discord API.
   * Returns the poll question, answers, and vote counts.
   *
   * @param pollId - Poll message ID
   * @param channelId - Discord channel ID
   * @param messageId - Discord message ID
   * @returns Poll checklist or null if not found
   */
  async fetchPollState(
    pollId: string,
    channelId: string,
    messageId: string
  ): Promise<PollChecklist | null> {
    if (!this.discordProvider) {
      logger.warn('Discord provider not available for fetchPollState');
      return null;
    }

    try {
      // Use Discord provider to get poll results
      const pollResults = await this.getPollResults(channelId, messageId);

      if (!pollResults) {
        logger.warn({ pollId, channelId, messageId }, 'Poll not found');
        return null;
      }

      // Convert to PollChecklist format
      const checklist: PollChecklist = {
        question: pollResults.question,
        answers: pollResults.answers.map(ans => ({
          id: ans.id,
          text: ans.text,
          checked: false,  // Will be updated by isPollComplete
        })),
      };

      return checklist;
    } catch (err) {
      logger.error({ pollId, channelId, messageId, err }, 'Error fetching poll state');
      return null;
    }
  }

  /**
   * Get poll results from Discord.
   * This is a helper method that calls the Discord provider.
   *
   * @param _channelId - Discord channel ID
   * @param _messageId - Discord message ID
   * @returns Poll results or null
   */
  private async getPollResults(
    _channelId: string,
    _messageId: string
  ): Promise<{ question: string; answers: Array<{ id: number; text: string; voteCount: number }> } | null> {
    if (!this.discordProvider) {
      return null;
    }

    // Check if provider has getPollResults method
    // For now, return null - this will be implemented in the Discord provider extension
    return null;
  }

  /**
   * Check if a poll is complete based on user votes.
   * A poll is considered complete when all answers have at least one vote.
   *
   * @param checklist - Poll checklist data
   * @returns True if poll is complete
   */
  isPollComplete(checklist: PollChecklist): boolean {
    // Check if all answers have votes (checked = true with votes)
    return checklist.answers.every(answer => answer.checked);
  }

  /**
   * Calculate poll completion percentage.
   *
   * @param checklist - Poll checklist data
   * @returns Percentage of completed items (0-100)
   */
  getPollCompletionPercentage(checklist: PollChecklist): number {
    if (checklist.answers.length === 0) return 0;
    const completed = checklist.answers.filter(a => a.checked).length;
    return Math.round((completed / checklist.answers.length) * 100);
  }

  /**
   * Create a PollChecklist from raw Discord poll data.
   * Used when processing poll vote events.
   *
   * @param question - Poll question
   * @param answers - Array of answer objects with vote data
   * @returns PollChecklist object
   */
  createPollChecklist(
    question: string,
    answers: Array<{ id: number; text: string; voteCount?: number }>
  ): PollChecklist {
    return {
      question,
      answers: answers.map(ans => ({
        id: ans.id,
        text: ans.text,
        checked: (ans.voteCount ?? 0) > 0,
      })),
    };
  }

  /**
   * Validate subtask format for poll answers.
   * Subtasks should be short strings, optionally prefixed with an emoji.
   *
   * @param subtasks - Array of subtask strings
   * @returns True if all subtasks are valid
   */
  validateSubtasks(subtasks: string[]): boolean {
    if (subtasks.length === 0 || subtasks.length > 10) {
      return false;
    }

    // Each subtask should be 1-55 characters (Discord limit)
    const MAX_LENGTH = 55;
    for (const subtask of subtasks) {
      if (subtask.length < 1 || subtask.length > MAX_LENGTH) {
        return false;
      }
    }

    return true;
  }

  /**
   * Format subtasks for poll display.
   * Ensures emoji prefix and proper length.
   *
   * @param subtasks - Raw subtask strings
   * @returns Formatted subtask strings
   */
  formatSubtasks(subtasks: string[]): string[] {
    const defaultEmojis = ['🔧', '✨', '📝', '🐛', '🚀', '🔍', '💻', '📦', '🔒', '📊'];
    const MAX_LENGTH = 55;

    return subtasks.map((subtask, index) => {
      let formatted = subtask.trim();

      // Add emoji prefix if missing
      if (!/^[\p{Emoji}]/u.test(formatted)) {
        const emoji = defaultEmojis[index % defaultEmojis.length];
        formatted = `${emoji} ${formatted}`;
      }

      // Truncate if too long
      if (formatted.length > MAX_LENGTH) {
        formatted = formatted.slice(0, MAX_LENGTH - 3) + '...';
      }

      return formatted;
    });
  }
}

/**
 * Create a singleton poll manager instance
 */
let pollManagerInstance: PollManager | null = null;

export function getPollManager(): PollManager {
  if (!pollManagerInstance) {
    pollManagerInstance = new PollManager();
  }
  return pollManagerInstance;
}

export function setPollProvider(provider: import('./providers/discord/discord-provider.js').DiscordProvider): void {
  getPollManager().setDiscordProvider(provider);
}
