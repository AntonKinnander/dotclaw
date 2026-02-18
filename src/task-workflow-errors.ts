/**
 * Task Workflow Error Handling
 *
 * Centralized error handling for the daily planning workflow.
 * Provides retry logic, error classification, and logging.
 */

import { logger } from './logger.js';

/**
 * Error categories for workflow operations
 */
export enum WorkflowErrorCategory {
  DISCORD_API = 'discord_api',
  DATABASE = 'database',
  VALIDATION = 'validation',
  PERMISSION = 'permission',
  NETWORK = 'network',
  UNKNOWN = 'unknown',
}

/**
 * Classified workflow error
 */
export interface WorkflowError {
  category: WorkflowErrorCategory;
  message: string;
  originalError?: unknown;
  retryable: boolean;
  context: Record<string, unknown>;
}

/**
 * Error handler for workflow operations
 */
export class WorkflowErrorHandler {
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_MS = 1000;

  /**
   * Handle task creation error
   */
  async handleTaskCreationError(error: Error, context: {
    group_folder: string;
    task: string;
  }): Promise<void> {
    const classified = this.classifyError(error);
    this.logWorkflowError(classified, context);

    if (classified.category === WorkflowErrorCategory.VALIDATION) {
      // Don't retry validation errors
      logger.error({ error: classified.message, context }, 'Task creation failed - validation error');
      return;
    }

    // Retry for network/API errors
    if (classified.retryable) {
      logger.warn({ error: classified.message, context }, 'Task creation failed - will retry');
    }
  }

  /**
   * Handle poll creation error
   */
  async handlePollCreationError(error: Error, taskId: string): Promise<void> {
    const classified = this.classifyError(error);
    this.logWorkflowError(classified, { task_id: taskId });

    if (classified.category === WorkflowErrorCategory.PERMISSION) {
      logger.error({ task_id: taskId }, 'Poll creation failed - permission error. Check bot permissions.');
      return;
    }

    // Mark task for retry if network/API error
    if (classified.retryable) {
      logger.warn({ task_id: taskId }, 'Poll creation failed - scheduling retry');
    }
  }

  /**
   * Retry a failed operation with exponential backoff
   */
  async retryFailedOperation<T>(
    fn: () => Promise<T>,
    maxRetries = this.MAX_RETRIES
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const classified = this.classifyError(lastError);

        if (!classified.retryable) {
          throw lastError;
        }

        if (attempt === maxRetries) {
          throw lastError;
        }

        const delay = this.RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        logger.debug({ attempt, maxRetries, delay }, 'Retrying failed operation');

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError || new Error('Retry failed');
  }

  /**
   * Classify an error into a category
   */
  classifyError(error: Error): WorkflowError {
    const message = error.message.toLowerCase();
    const originalError = error;

    // Discord API errors
    if (message.includes('429') || message.includes('rate limit')) {
      return {
        category: WorkflowErrorCategory.DISCORD_API,
        message: 'Rate limited by Discord API',
        originalError,
        retryable: true,
        context: {},
      };
    }

    if (message.includes('missing permissions') || message.includes('403')) {
      return {
        category: WorkflowErrorCategory.PERMISSION,
        message: 'Missing Discord permissions',
        originalError,
        retryable: false,
        context: {},
      };
    }

    if (message.includes('unknown channel') || message.includes('invalid channel')) {
      return {
        category: WorkflowErrorCategory.VALIDATION,
        message: 'Invalid Discord channel',
        originalError,
        retryable: false,
        context: {},
      };
    }

    // Network errors
    if (message.includes('etimedout') || message.includes('econnrefused') ||
        message.includes('enotfound') || message.includes('network')) {
      return {
        category: WorkflowErrorCategory.NETWORK,
        message: 'Network error',
        originalError,
        retryable: true,
        context: {},
      };
    }

    // Database errors
    if (message.includes('sqlite') || message.includes('database') || message.includes('sql')) {
      return {
        category: WorkflowErrorCategory.DATABASE,
        message: 'Database error',
        originalError,
        retryable: true,
        context: {},
      };
    }

    // Validation errors
    if (message.includes('invalid') || message.includes('required') ||
        message.includes('not found') || message.includes('does not exist')) {
      return {
        category: WorkflowErrorCategory.VALIDATION,
        message: 'Validation error',
        originalError,
        retryable: false,
        context: {},
      };
    }

    // Default
    return {
      category: WorkflowErrorCategory.UNKNOWN,
      message: error.message,
      originalError,
      retryable: false,
      context: {},
    };
  }

  /**
   * Log a workflow error with context
   */
  logWorkflowError(error: WorkflowError, context: Record<string, unknown>): void {
    const logData = {
      category: error.category,
      message: error.message,
      retryable: error.retryable,
      ...context,
    };

    if (error.retryable) {
      logger.warn(logData, 'Workflow error (retryable)');
    } else {
      logger.error(logData, 'Workflow error (non-retryable)');
    }
  }

  /**
   * Format an error for user display
   */
  formatErrorForUser(error: WorkflowError): string {
    switch (error.category) {
      case WorkflowErrorCategory.DISCORD_API:
        if (error.message.includes('Rate limited')) {
          return '⚠️ Discord rate limit reached. Please wait a moment and try again.';
        }
        return '⚠️ Discord API error. Please try again.';

      case WorkflowErrorCategory.PERMISSION:
        return '⚠️ Missing permissions. Please check the bot has the required permissions.';

      case WorkflowErrorCategory.VALIDATION:
        return `⚠️ ${error.message}`;

      case WorkflowErrorCategory.NETWORK:
        return '⚠️ Network error. Please check your connection and try again.';

      case WorkflowErrorCategory.DATABASE:
        return '⚠️ Database error. Your data is safe, but the operation failed.';

      default:
        return '⚠️ An unexpected error occurred. Please try again.';
    }
  }
}

/**
 * Singleton instance
 */
let workflowErrorHandlerInstance: WorkflowErrorHandler | null = null;

/**
 * Get the workflow error handler singleton
 */
export function getWorkflowErrorHandler(): WorkflowErrorHandler {
  if (!workflowErrorHandlerInstance) {
    workflowErrorHandlerInstance = new WorkflowErrorHandler();
  }
  return workflowErrorHandlerInstance;
}
