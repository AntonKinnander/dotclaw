import { logger } from './logger.js';

/**
 * Request for breaking down a task into subtasks
 */
export interface BreakdownRequest {
  group_folder: string;
  main_task: string;
  context?: {
    repo?: string;
    url?: string;
    calendar_link?: string;
    description?: string;
  };
}

/**
 * A single subtask in the breakdown
 */
export interface Subtask {
  title: string;  // with emoji prefix
  emoji: string;
  description?: string;
}

/**
 * Result of task breakdown
 */
export interface BreakdownResult {
  main_task: string;
  subtasks: Subtask[];
}

/**
 * Extract emoji from a task title
 */
export function extractEmoji(title: string): string {
  const emojiMatch = title.match(/^(\p{Emoji}+)/u);
  return emojiMatch ? emojiMatch[1] : '📋';
}

/**
 * Validate and parse subtask output
 */
export function parseSubtasks(output: string): Subtask[] {
  try {
    // Try to parse as JSON array first
    const parsed = JSON.parse(output) as string[] | { subtasks: string[] };
    const subtaskArray = Array.isArray(parsed) ? parsed : parsed.subtasks;

    if (!Array.isArray(subtaskArray)) {
      throw new Error('Output is not an array');
    }

    // Validate each subtask
    return subtaskArray.slice(0, 10).map((item: string) => {
      const title = typeof item === 'string' ? item.trim() : String(item);
      if (title.length === 0) {
        throw new Error('Empty subtask title');
      }
      if (title.length > 55) {
        throw new Error(`Subtask title too long: ${title.length} chars (max 55)`);
      }
      return {
        title,
        emoji: extractEmoji(title),
      };
    });
  } catch (err) {
    logger.error({ err, output }, 'Failed to parse subtask output');
    return [];
  }
}

/**
 * Create subtasks from a breakdown result
 *
 * This helper extracts just the titles for easier iteration
 */
export function getSubtaskTitles(result: BreakdownResult): string[] {
  return result.subtasks.map(s => s.title);
}
