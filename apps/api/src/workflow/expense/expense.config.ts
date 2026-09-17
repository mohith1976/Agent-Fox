/**
 * Expense Workflow Configuration
 * 
 * Bounded loop protection, timeout limits, and retry policies
 */

export const EXPENSE_CONFIG = {
  // ========================================
  // CLASSIFICATION
  // ========================================

  /**
   * Minimum LLM confidence to accept a classification.
   * Below this → UNKNOWN (per architecture §2.3.3). Prevents
   * low-confidence gibberish from entering the transaction path.
   */
  INTENT_CONFIDENCE_THRESHOLD: 0.7,
  // ========================================
  // BOUNDED LOOP PROTECTION
  // ========================================
  
  /**
   * Maximum clarification attempts
   * Covers amount → description → mode chains (3 rounds) without looping
   * forever. The user's own rule ("ask me how I paid AND what it was for")
   * needs all three rounds available.
   */
  MAX_CLARIFICATION_ATTEMPTS: 3,

  /**
   * Absolute cap on clarification rounds per cycle (backstop). The attempts
   * counter above only grows on UNPRODUCTIVE answers; this caps total turns
   * so even stubborn junk-answer loops terminate.
   */
  MAX_CLARIFICATION_ROUNDS: 6,
  
  /**
   * Maximum query transformation attempts
   * Try different query variations before giving up
   */
  MAX_QUERY_TRANSFORMATIONS: 3,
  
  /**
   * Maximum answer regeneration attempts
   * Try generating answer multiple times for quality
   */
  MAX_ANSWER_REGENERATIONS: 2,
  
  // ========================================
  // INFRASTRUCTURE RETRIES (AUTOMATIC)
  // ========================================
  
  /**
   * LLM retry attempts for transient failures
   */
  LLM_RETRY_ATTEMPTS: 3,
  
  /**
   * LLM retry backoff strategy
   */
  LLM_RETRY_BACKOFF: 'exponential' as const,
  
  // ========================================
  // TIMEOUT LIMITS
  // ========================================
  
  /**
   * Individual node execution timeout
   * Applies to each node independently (LLM call, tool execution, etc.)
   */
  NODE_EXECUTION_TIMEOUT_MS: 30000, // 30 seconds
  
  /**
   * Maximum duration for a single graph.invoke() execution
   * Prevents runaway loops during active execution
   * ONLY applies while graph is actively executing
   * DOES NOT apply to waiting states (AWAITING_CLARIFICATION, PENDING_CONFIRMATION)
   */
  ACTIVE_RUN_TIMEOUT_MS: 300000, // 5 minutes
  
  /**
   * Redis checkpoint retention time
   * After expiration, thread cannot be resumed
   * 
   * IMPORTANT: RedisSaver.fromUrl() expects TTL in MINUTES
   * Value: 1440 minutes = 24 hours
   */
  CHECKPOINT_TTL_MINUTES: 1440, // 24 hours
  
  /**
   * Maximum time a conversation can remain in waiting state
   * User can respond hours/days later (asynchronous checkpointed waiting)
   * After this duration, conversation is considered abandoned
   * Cleanup mechanism for stale conversations
   */
  WAITING_STATE_MAX_AGE_SECONDS: 604800, // 7 days
} as const;

/**
 * Timeout Model:
 * 
 * 1. NODE_EXECUTION_TIMEOUT_MS (30s)
 *    - Individual node execution timeout
 *    - LLM call, tool execution, data transformation
 *    - Applies to each node independently
 * 
 * 2. ACTIVE_RUN_TIMEOUT_MS (5 min)
 *    - Maximum duration for a single graph.invoke() execution
 *    - Prevents runaway loops
 *    - ONLY applies while graph is actively executing
 *    - DOES NOT apply to waiting states
 * 
 * 3. CHECKPOINT_TTL_MINUTES (1440 minutes = 24 hours)
 *    - Redis key expiration for checkpoint data (configured in MINUTES)
 *    - Affects ALL checkpointed state
 *    - After expiration, thread cannot be resumed
 * 
 * 4. WAITING_STATE_MAX_AGE_SECONDS (7 days)
 *    - Maximum time a conversation can remain in AWAITING_CLARIFICATION or PENDING_CONFIRMATION
 *    - User can respond hours/days later
 *    - NOT an active execution timeout
 *    - Cleanup mechanism for abandoned conversations
 */
