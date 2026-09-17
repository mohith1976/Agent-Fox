/**
 * Redis Saver Configuration
 * 
 * Configuration for official LangGraph RedisSaver
 */

export interface RedisSaverConfig {
  /**
   * Redis URL connection string
   */
  url: string;

  /**
   * Default TTL in minutes for checkpoints
   */
  defaultTTL: number;

  /**
   * Whether to refresh TTL when checkpoints are read
   */
  refreshOnRead: boolean;
}

/**
 * Get Redis Saver configuration from environment variables.
 *
 * NOTE: the fallback port MUST match the lock/signal clients
 * (WorkflowService, ExpenseWorkflow → 6380). A split fallback once risked
 * putting checkpoints and locks on different Redis servers.
 */
export function getRedisSaverConfig(): RedisSaverConfig {
  return {
    url: process.env.REDIS_URL || 'redis://localhost:6380',
    defaultTTL: parseInt(process.env.REDIS_TTL_MINUTES || '60', 10),
    refreshOnRead: true,
  };
}
