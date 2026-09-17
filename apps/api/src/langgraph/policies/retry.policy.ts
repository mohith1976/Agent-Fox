/**
 * Retry Policy Interface and Defaults
 * 
 * Defines retry behavior for node execution
 */

export interface RetryPolicy {
  /**
   * Maximum number of retry attempts
   */
  maxAttempts: number;

  /**
   * Initial delay in milliseconds before first retry
   */
  initialDelayMs: number;

  /**
   * Multiplier for exponential backoff
   */
  backoffMultiplier: number;

  /**
   * Maximum delay in milliseconds between retries
   */
  maxDelayMs: number;

  /**
   * Whether to retry on this error
   */
  shouldRetry?: (error: Error) => boolean;
}

/**
 * Default retry policy for LLM operations
 */
export const DEFAULT_LLM_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 10000,
  shouldRetry: (error: Error) => {
    // Retry on network errors, rate limits, timeouts
    const message = error.message.toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('rate limit') ||
      message.includes('econnreset') ||
      message.includes('enotfound') ||
      message.includes('429') ||
      message.includes('503')
    );
  },
};

/**
 * Default retry policy for tool execution
 */
export const DEFAULT_TOOL_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 2,
  initialDelayMs: 500,
  backoffMultiplier: 2,
  maxDelayMs: 5000,
  shouldRetry: (error: Error) => {
    // Retry on transient errors only
    const message = error.message.toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('econnreset') ||
      message.includes('temporary')
    );
  },
};

/**
 * No retry policy - fail immediately
 */
export const NO_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 1,
  initialDelayMs: 0,
  backoffMultiplier: 1,
  maxDelayMs: 0,
  shouldRetry: () => false,
};
