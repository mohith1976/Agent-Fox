/**
 * LangGraph Service
 * 
 * Central service for LangGraph infrastructure:
 * - Manages official RedisSaver checkpoint persistence
 * - Compiles graphs with checkpointer
 * - Provides retry wrapper for node execution
 * - Extracts typed workflow state from checkpoints
 */

import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { RedisSaver } from '@langchain/langgraph-checkpoint-redis';
import { StateGraph } from '@langchain/langgraph';
import {
  CompiledStateGraph,
  NodeFunction,
  CheckpointTuple,
} from './langgraph.types';
import { RetryPolicy } from './policies/retry.policy';
import { getRedisSaverConfig } from './checkpoint/redis-saver.config';

@Injectable()
export class LangGraphService implements OnModuleInit {
  private readonly logger = new Logger(LangGraphService.name);
  private checkpointer!: RedisSaver; // Use definite assignment assertion

  /**
   * Initialize RedisSaver asynchronously during module initialization
   */
  async onModuleInit() {
    const config = getRedisSaverConfig();

    this.logger.log(
      `Initializing RedisSaver with URL: ${config.url}, TTL: ${config.defaultTTL} minutes`,
    );

    try {
      this.checkpointer = await RedisSaver.fromUrl(config.url, {
        defaultTTL: config.defaultTTL,
        refreshOnRead: config.refreshOnRead,
      });

      this.logger.log('RedisSaver initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize RedisSaver:', error);
      throw error;
    }
  }

  /**
   * Compile a StateGraph with official checkpoint saver
   */
  compile(graph: any): any {
    this.logger.debug('Compiling graph with RedisSaver checkpointer');

    return graph.compile({
      checkpointer: this.checkpointer,
    });
  }

  /**
   * Wrap a node function with retry logic
   */
  wrapWithRetry(
    nodeFunc: NodeFunction,
    policy: RetryPolicy,
  ): NodeFunction {
    return async (state: any) => {
      let lastError: Error | undefined;
      let delay = policy.initialDelayMs;

      for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
        try {
          return await nodeFunc(state);
        } catch (error) {
          lastError = error as Error;

          // Check if we should retry
          if (
            attempt >= policy.maxAttempts ||
            (policy.shouldRetry && !policy.shouldRetry(lastError))
          ) {
            break;
          }

          // Log retry attempt
          this.logger.warn(
            `Node execution failed (attempt ${attempt}/${policy.maxAttempts}), retrying in ${delay}ms: ${lastError.message}`,
          );

          // Wait before retry
          await new Promise((resolve) => setTimeout(resolve, delay));

          // Calculate next delay with exponential backoff
          delay = Math.min(
            delay * policy.backoffMultiplier,
            policy.maxDelayMs,
          );
        }
      }

      // All retries exhausted
      if (lastError) {
        this.logger.error(
          `Node execution failed after ${policy.maxAttempts} attempts: ${lastError.message}`,
        );
        throw lastError;
      }
      
      throw new Error('Node execution failed with no error details');
    };
  }

  /**
   * Extract typed workflow state from checkpoint
   * 
   * This is the ONLY method that accesses checkpoint internal structure.
   * Application services do NOT access tuple.checkpoint.channel_values directly.
   */
  async getWorkflowState<T>(threadId: string): Promise<T | null> {
    try {
      const tuple = await this.checkpointer.getTuple({
        configurable: { thread_id: threadId },
      });

      if (!tuple) {
        this.logger.debug(`No checkpoint found for thread: ${threadId}`);
        return null;
      }

      // LangGraphService knows about checkpoint.checkpoint.channel_values
      // Application services do NOT
      return tuple.checkpoint.channel_values as T;
    } catch (error) {
      this.logger.error(
        `Failed to get workflow state for thread ${threadId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Get the checkpointer instance (for advanced use cases only)
   * NOTE: This should rarely be needed - use getWorkflowState() instead
   */
  getCheckpointer(): RedisSaver {
    return this.checkpointer;
  }
}
