/**
 * PostgreSQL Checkpoint Saver for LangGraph
 * 
 * Implements LangGraph checkpoint persistence using the existing flow_trackings table.
 * Does NOT create a new database table - uses approved schema.
 * 
 * This allows workflow state to survive across separate HTTP requests,
 * enabling multi-turn confirmation/edit cycles.
 */

import { BaseCheckpointSaver } from '@langchain/langgraph';
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
} from '@langchain/langgraph';
import { PrismaService } from '../../database/prisma.service';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Configuration for checkpoint key generation
 */
interface CheckpointConfig {
  configurable?: {
    thread_id?: string;
    checkpoint_ns?: string;
    checkpoint_id?: string;
  };
}

/**
 * PostgreSQL-based checkpoint saver using flow_trackings table
 * 
 * Per design requirements:
 * - Uses existing flow_trackings table (data JSON field)
 * - Does NOT create a fourth database table
 * - Does NOT create a financial ledger table
 * - Stores workflow state only (NOT financial transactions)
 */
@Injectable()
export class PostgresCheckpointSaver extends BaseCheckpointSaver {
  private readonly logger = new Logger(PostgresCheckpointSaver.name);
  private readonly expenseWorkflowId: string;

  constructor(
    private readonly prisma: PrismaService,
    expenseWorkflowId: string,
  ) {
    super();
    this.expenseWorkflowId = expenseWorkflowId;
    this.logger.log(`PostgresCheckpointSaver initialized with expense workflow ID: ${expenseWorkflowId}`);
  }

  /**
   * Get checkpoint tuple by thread ID
   * Returns the most recent checkpoint for the given thread
   */
  async getTuple(config: CheckpointConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id;
    
    this.logger.log(`[getTuple] CALLED - threadId=${threadId}`);
    
    if (!threadId) {
      this.logger.warn(`[getTuple] NO thread_id in config`);
      return undefined;
    }

    try {
      // Query most recent checkpoint for this thread
      const record = await this.prisma.flowTracking.findFirst({
        where: {
          workflowId: this.expenseWorkflowId,
          status: 'checkpoint',
          data: {
            path: ['metadata', 'thread_id'],
            equals: threadId,
          },
          deletedAt: null,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      if (!record || !record.data) {
        this.logger.log(`[getTuple] NO checkpoint found for thread=${threadId}`);
        return undefined;
      }

      const data = record.data as any;
      
      this.logger.log(`[getTuple] CHECKPOINT FOUND for thread=${threadId}`);
      this.logger.log(`[getTuple] Checkpoint has pendingBatch: ${!!data.checkpoint?.channel_values?.pendingBatch}`);
      if (data.checkpoint?.channel_values?.pendingBatch) {
        this.logger.log(`[getTuple] pendingBatch length: ${data.checkpoint.channel_values.pendingBatch.length}`);
      }
      this.logger.log(`[getTuple] Checkpoint workflowMode: ${data.checkpoint?.channel_values?.workflowMode}`);

      // Reconstruct checkpoint tuple
      const checkpoint: Checkpoint = data.checkpoint || {};
      const metadata: CheckpointMetadata = data.metadata || {};
      const parentConfig = data.parentConfig;

      return {
        config,
        checkpoint,
        metadata,
        parentConfig,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get checkpoint for thread ${threadId}: ${error}`,
      );
      return undefined;
    }
  }

  /**
   * List checkpoints for a given thread (for history/replay if needed)
   */
  async *list(
    config: CheckpointConfig,
    options?: { limit?: number; before?: CheckpointConfig },
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id;
    if (!threadId) {
      return;
    }

    const limit = options?.limit || 10;

    try {
      const records = await this.prisma.flowTracking.findMany({
        where: {
          workflowId: this.expenseWorkflowId, // Use real expense workflow UUID
          status: 'checkpoint',
          data: {
            path: ['metadata', 'thread_id'],
            equals: threadId,
          },
          deletedAt: null,
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: limit,
      });

      for (const record of records) {
        if (!record.data) continue;

        const data = record.data as any;
        const checkpoint: Checkpoint = data.checkpoint || {};
        const metadata: CheckpointMetadata = data.metadata || {};
        const parentConfig = data.parentConfig;

        yield {
          config,
          checkpoint,
          metadata,
          parentConfig,
        };
      }
    } catch (error) {
      this.logger.error(
        `Failed to list checkpoints for thread ${threadId}: ${error}`,
      );
    }
  }

  /**
   * Save checkpoint to PostgreSQL flow_trackings table
   * 
   * CRITICAL: This stores workflow state only.
   * It does NOT store financial transactions.
   * Budget_2026.xlsx remains the financial source of truth.
   */
  async put(
    config: CheckpointConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<CheckpointConfig> {
    const threadId = config.configurable?.thread_id;
    if (!threadId) {
      throw new Error('thread_id is required in config.configurable');
    }

    try {
      // Store checkpoint data in flow_trackings.data JSON field
      const checkpointData = {
        checkpoint,
        metadata: {
          ...metadata,
          thread_id: threadId,
          saved_at: new Date().toISOString(),
        },
        parentConfig: config,
      };

      await this.prisma.flowTracking.create({
        data: {
          workflowId: this.expenseWorkflowId,
          status: 'checkpoint',
          data: JSON.parse(JSON.stringify(checkpointData)),
          model: 'gpt-5-mini',
          // Optional: track metadata if available
          tokens: (metadata as any).tokens || null,
          cost: (metadata as any).cost || null,
        },
      });

      this.logger.log(`Checkpoint saved for thread ${threadId}`);

      return config;
    } catch (error) {
      this.logger.error(
        `Failed to save checkpoint for thread ${threadId}: ${error}`,
      );
      throw error;
    }
  }

  /**
   * Put writes (required by BaseCheckpointSaver)
   */
  async putWrites(
    config: CheckpointConfig,
    writes: any[],
    taskId: string,
  ): Promise<void> {
    // For now, this is a no-op
    // Writes are tracked in the checkpoint metadata
    this.logger.log(`putWrites called for task=${taskId}, writes=${writes.length}`);
  }

  /**
   * Delete a specific checkpoint (cleanup)
   */
  async delete(config: CheckpointConfig): Promise<void> {
    const threadId = config.configurable?.thread_id;
    if (!threadId) {
      return;
    }

    try {
      // Soft delete by setting deletedAt
      await this.prisma.flowTracking.updateMany({
        where: {
          workflowId: this.expenseWorkflowId, // Use real expense workflow UUID
          status: 'checkpoint',
          data: {
            path: ['metadata', 'thread_id'],
            equals: threadId,
          },
          deletedAt: null,
        },
        data: {
          deletedAt: new Date(),
        },
      });

      this.logger.log(`Checkpoint deleted for thread ${threadId}`);
    } catch (error) {
      this.logger.error(
        `Failed to delete checkpoint for thread ${threadId}: ${error}`,
      );
    }
  }

  /**
   * Cleanup old checkpoints (maintenance)
   * Can be called periodically to prevent unbounded growth
   */
  async cleanup(olderThanDays: number = 30): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

      const result = await this.prisma.flowTracking.updateMany({
        where: {
          workflowId: this.expenseWorkflowId,
          status: 'checkpoint',
          createdAt: {
            lt: cutoffDate,
          },
          deletedAt: null,
        },
        data: {
          deletedAt: new Date(),
        },
      });

      this.logger.log(
        `Cleaned up ${result.count} old checkpoints (older than ${olderThanDays} days)`,
      );

      return result.count;
    } catch (error) {
      this.logger.error(`Failed to cleanup old checkpoints: ${error}`);
      return 0;
    }
  }
}

/**
 * Factory function to create PostgreSQL checkpoint saver
 */
export function createPostgresCheckpointSaver(
  prisma: PrismaService,
  expenseWorkflowId: string,
): PostgresCheckpointSaver {
  return new PostgresCheckpointSaver(prisma, expenseWorkflowId);
}
