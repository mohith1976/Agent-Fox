/**
 * Idempotency Service
 * 
 * Prevents duplicate financial writes when requests are retried.
 * Uses PostgreSQL flow_trackings table to store request/response cache.
 * 
 * CRITICAL: This is for request deduplication only.
 * It does NOT create a financial ledger.
 * Budget_2026.xlsx remains the authoritative financial source.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { ChatResponseDto } from './chat.controller';

/**
 * Cached response TTL (time to live)
 * After this duration, cached responses are considered stale
 */
const CACHE_TTL_HOURS = 24;

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {
    this.logger.log('IdempotencyService initialized');
  }

  /**
   * Acquire an advisory lock for a requestId to prevent concurrent execution
   * Returns true if lock was acquired, false if another process holds it
   * 
   * Uses PostgreSQL pg_try_advisory_lock for distributed locking
   */
  async tryAcquireLock(requestId: string): Promise<boolean> {
    try {
      // Convert requestId to a 64-bit integer hash for advisory lock
      const hash = this.hashStringToInt64(requestId);
      
      // Try to acquire lock (non-blocking)
      const result = await this.prisma.$queryRaw<Array<{ pg_try_advisory_lock: boolean }>>`
        SELECT pg_try_advisory_lock(${hash}) as pg_try_advisory_lock
      `;
      
      const acquired = result[0]?.pg_try_advisory_lock === true;
      
      if (acquired) {
        this.logger.log(`Advisory lock ACQUIRED for requestId=${requestId}`);
      } else {
        this.logger.log(`Advisory lock DENIED for requestId=${requestId} (another process holds it)`);
      }
      
      return acquired;
    } catch (error) {
      this.logger.error(`Failed to acquire lock for requestId=${requestId}: ${error}`);
      // On error, allow execution (fail open)
      return true;
    }
  }

  /**
   * Release an advisory lock for a requestId
   */
  async releaseLock(requestId: string): Promise<void> {
    try {
      const hash = this.hashStringToInt64(requestId);
      
      await this.prisma.$queryRaw`
        SELECT pg_advisory_unlock(${hash})
      `;
      
      this.logger.log(`Advisory lock RELEASED for requestId=${requestId}`);
    } catch (error) {
      this.logger.error(`Failed to release lock for requestId=${requestId}: ${error}`);
    }
  }

  /**
   * Hash a string to a 64-bit integer for advisory locks
   * Uses a simple hash function (not cryptographic)
   */
  private hashStringToInt64(str: string): bigint {
    let hash = 0n;
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 31n + BigInt(str.charCodeAt(i))) & 0x7FFFFFFFFFFFFFFFn; // Keep positive
    }
    return hash;
  }

  /**
   * Get cached response for a request ID
   * Returns null if not found or expired
   * 
   * Normalizes the response to ensure consistent key ordering
   * (PostgreSQL JSON doesn't preserve key order)
   */
  async getCachedResponse(
    requestId: string,
    workflowId: string,
  ): Promise<ChatResponseDto | null> {
    try {
      const cutoffTime = new Date();
      cutoffTime.setHours(cutoffTime.getHours() - CACHE_TTL_HOURS);

      const record = await this.prisma.flowTracking.findFirst({
        where: {
          workflowId: workflowId,
          status: 'idempotency_cache',
          data: {
            path: ['requestId'],
            equals: requestId,
          },
          createdAt: {
            gte: cutoffTime,
          },
          deletedAt: null,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      if (!record || !record.data) {
        return null;
      }

      const data = record.data as any;
      this.logger.log(`Cache hit for requestId=${requestId}`);

      const cachedResponse = data.response as ChatResponseDto;
      
      // Normalize to ensure consistent key ordering (PostgreSQL JSON doesn't preserve it)
      const normalizedResponse: ChatResponseDto = {
        success: cachedResponse.success,
        response: cachedResponse.response,
        pendingBatch: cachedResponse.pendingBatch ? cachedResponse.pendingBatch.map((tx: any) => ({
          itemNumber: tx.itemNumber,
          date: tx.date,
          description: tx.description,
          tag: tx.tag,
          mode: tx.mode,
          amount: tx.amount,
          direction: tx.direction,
          suggestedCategory: tx.suggestedCategory,
        })) : null,
        chartImage: cachedResponse.chartImage,
        error: cachedResponse.error,
        workflowMode: cachedResponse.workflowMode,
        cached: cachedResponse.cached,
        metadata: cachedResponse.metadata,
      };

      return normalizedResponse;
    } catch (error) {
      this.logger.error(
        `Failed to get cached response for requestId=${requestId}: ${error}`,
      );
      return null;
    }
  }

  /**
   * Cache a response for future idempotency checks
   * 
   * CRITICAL: This stores the response for deduplication ONLY.
   * It does NOT store financial transaction data.
   * The financial write already occurred via log_transaction → S3.
   * 
   * Uses PostgreSQL unique constraint to prevent race conditions.
   * If concurrent requests try to cache the same requestId, only one will succeed.
   * 
   * Normalizes response before caching to ensure consistent structure.
   */
  async cacheResponse(
    requestId: string,
    response: ChatResponseDto,
    workflowId: string,
  ): Promise<void> {
    try {
      // Normalize response before caching
      // 1. Remove dynamic fields that differ between retries
      // 2. Ensure consistent key ordering by rebuilding objects explicitly
      const normalizedResponse: ChatResponseDto = {
        success: response.success,
        response: response.response,
        pendingBatch: response.pendingBatch ? response.pendingBatch.map(tx => ({
          itemNumber: tx.itemNumber,
          date: tx.date,
          description: tx.description,
          tag: tx.tag,
          mode: tx.mode,
          amount: tx.amount,
          direction: tx.direction,
          suggestedCategory: tx.suggestedCategory,
        })) : null,
        chartImage: response.chartImage,
        error: response.error,
        workflowMode: response.workflowMode,
        cached: false, // Always store as false, will be set to true when returned from cache
        metadata: response.metadata ? {
          llmCalls: response.metadata.llmCalls,
          toolCalls: response.metadata.toolCalls,
          executionTimeMs: response.metadata.executionTimeMs, // Store original execution time
        } : undefined,
      };

      await this.prisma.flowTracking.create({
        data: {
          workflowId: workflowId,
          status: 'idempotency_cache',
          data: JSON.parse(JSON.stringify({
            requestId,
            response: normalizedResponse,
            cachedAt: new Date().toISOString(),
          })),
          model: null,
          tokens: null,
          cost: null,
        },
      });

      this.logger.log(`Cached response for requestId=${requestId}`);
    } catch (error: any) {
      // If duplicate key error, this is expected for concurrent requests - both tried to cache
      // One succeeded, one failed - this is correct behavior
      if (error.code === 'P2002' || error.code === '23505') {
        this.logger.log(`Request ${requestId} already cached (concurrent request won the race)`);
        return;
      }
      
      // Non-fatal: if caching fails, the request still succeeded
      this.logger.warn(
        `Failed to cache response for requestId=${requestId}: ${error}`,
      );
    }
  }

  /**
   * Check if a request has been processed (for write operations)
   * This is used for additional safety beyond response caching
   */
  async hasBeenProcessed(requestId: string, workflowId: string): Promise<boolean> {
    try {
      const cutoffTime = new Date();
      cutoffTime.setHours(cutoffTime.getHours() - CACHE_TTL_HOURS);

      const count = await this.prisma.flowTracking.count({
        where: {
          workflowId: workflowId,
          status: 'idempotency_cache',
          data: {
            path: ['requestId'],
            equals: requestId,
          },
          createdAt: {
            gte: cutoffTime,
          },
          deletedAt: null,
        },
      });

      return count > 0;
    } catch (error) {
      this.logger.error(
        `Failed to check if requestId=${requestId} has been processed: ${error}`,
      );
      return false;
    }
  }

  /**
   * Cleanup old cached responses (maintenance)
   * Can be called periodically to prevent unbounded growth
   */
  async cleanup(workflowId: string, olderThanHours: number = 72): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setHours(cutoffDate.getHours() - olderThanHours);

      const result = await this.prisma.flowTracking.updateMany({
        where: {
          workflowId: workflowId,
          status: 'idempotency_cache',
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
        `Cleaned up ${result.count} old idempotency cache entries (older than ${olderThanHours} hours)`,
      );

      return result.count;
    } catch (error) {
      this.logger.error(`Failed to cleanup idempotency cache: ${error}`);
      return 0;
    }
  }
}
