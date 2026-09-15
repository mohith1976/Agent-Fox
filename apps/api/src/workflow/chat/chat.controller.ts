/**
 * Chat Controller
 * 
 * Exposes the Phase 4 API contract for the React frontend.
 * Handles chat requests with idempotency support.
 */

import {
  Controller,
  Post,
  Get,
  Body,
  Res,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { ExpenseWorkflowService } from '../expense/expense-workflow.service';
import { IdempotencyService } from './idempotency.service';
import { S3Service } from '../storage/s3.service';

/**
 * Chat Request DTO
 */
export interface ChatRequestDto {
  /** Unique request/message identifier (client-generated UUID) */
  requestId: string;

  /** Thread/conversation identifier (client-generated UUID) */
  threadId: string;

  /** User message */
  message: string;
}

/**
 * Pending Transaction DTO
 */
export interface PendingTransactionDto {
  itemNumber: number;
  date: string;
  description: string;
  tag: string | null;
  mode: string;
  amount: number;
  direction: string;
  suggestedCategory: string | null;
}

/**
 * Chat Response DTO
 */
export interface ChatResponseDto {
  /** Success indicator */
  success: boolean;

  /** Agent response text */
  response: string;

  /** Pending batch (if awaiting confirmation) */
  pendingBatch?: PendingTransactionDto[] | null;

  /** Chart image (base64 encoded PNG) */
  chartImage?: string | null;

  /** Error message */
  error?: string | null;

  /** Workflow mode */
  workflowMode: string;

  /** Request was processed from cache (idempotency) */
  cached?: boolean;

  /** Execution metadata */
  metadata?: {
    llmCalls?: number;
    toolCalls?: number;
    executionTimeMs?: number;
  };
}

@Controller('api/chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly workflowService: ExpenseWorkflowService,
    private readonly idempotencyService: IdempotencyService,
    private readonly s3Service: S3Service,
  ) {
    this.logger.log('ChatController initialized');
  }

  /**
   * POST /api/chat
   * 
   * Execute the expense workflow for a user message.
   * Supports idempotency via requestId.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async chat(@Body() request: ChatRequestDto): Promise<ChatResponseDto> {
    const startTime = Date.now();

    // Validate request
    if (!request.requestId || !request.threadId || !request.message) {
      throw new BadRequestException(
        'requestId, threadId, and message are required',
      );
    }

    this.logger.log(
      `[POST /api/chat] thread=${request.threadId}, request=${request.requestId}, message="${request.message.substring(0, 50)}..."`,
    );

    try {
      // STEP 1: Check idempotency cache FIRST (before acquiring lock)
      const cachedResponse =
        await this.idempotencyService.getCachedResponse(request.requestId);

      if (cachedResponse) {
        this.logger.log(
          `[POST /api/chat] returning cached response for request=${request.requestId}`,
        );

        // Return cached response with original execution time (for idempotency)
        return {
          success: cachedResponse.success,
          response: cachedResponse.response,
          pendingBatch: cachedResponse.pendingBatch,
          chartImage: cachedResponse.chartImage,
          error: cachedResponse.error,
          workflowMode: cachedResponse.workflowMode,
          cached: false, // Keep false for strict idempotency - responses must be identical
          metadata: cachedResponse.metadata, // Includes original executionTimeMs
        };
      }

      // STEP 2: Try to acquire advisory lock to prevent concurrent execution
      const lockAcquired = await this.idempotencyService.tryAcquireLock(request.requestId);
      
      if (!lockAcquired) {
        // Another request is processing this requestId - wait for it to complete
        this.logger.log(`[POST /api/chat] request=${request.requestId} is being processed by another request, polling for cache...`);
        
        // Poll for cached response (the other request will cache it)
        // Keep polling for up to 60 seconds (enough for most workflows)
        for (let attempt = 0; attempt < 300; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 200)); // Wait 200ms
          
          const cachedAfterWait = await this.idempotencyService.getCachedResponse(request.requestId);
          if (cachedAfterWait) {
            this.logger.log(`[POST /api/chat] found cached response after waiting (attempt ${attempt + 1})`);
            
            return {
              success: cachedAfterWait.success,
              response: cachedAfterWait.response,
              pendingBatch: cachedAfterWait.pendingBatch,
              chartImage: cachedAfterWait.chartImage,
              error: cachedAfterWait.error,
              workflowMode: cachedAfterWait.workflowMode,
              cached: false, // Keep false for strict idempotency
              metadata: cachedAfterWait.metadata, // Includes original executionTimeMs
            };
          }
        }
        
        // Timeout after 60s - this should never happen in practice
        this.logger.error(`[POST /api/chat] timeout after 60s waiting for cached response for request=${request.requestId}`);
        throw new Error('Request timeout: another instance is still processing this request');
      }

      try {
        // STEP 3: Double-check cache (in case we won the race after lock)
        const cachedAfterLock =
          await this.idempotencyService.getCachedResponse(request.requestId);

        if (cachedAfterLock) {
          this.logger.log(
            `[POST /api/chat] found cached response after lock acquisition`,
          );

          return {
            success: cachedAfterLock.success,
            response: cachedAfterLock.response,
            pendingBatch: cachedAfterLock.pendingBatch,
            chartImage: cachedAfterLock.chartImage,
            error: cachedAfterLock.error,
            workflowMode: cachedAfterLock.workflowMode,
            cached: false, // Keep false for strict idempotency
            metadata: cachedAfterLock.metadata, // Includes original executionTimeMs
          };
        }

        // STEP 4: Execute workflow
        const result = await this.workflowService.execute({
          requestId: request.requestId,
          threadId: request.threadId,
          message: request.message,
        });

        const executionTimeMs = Date.now() - startTime;

        // Normalize pendingBatch to ensure consistent key ordering
        const normalizedPendingBatch = result.pendingBatch ? result.pendingBatch.map(tx => ({
          itemNumber: tx.itemNumber,
          date: tx.date,
          description: tx.description,
          tag: tx.tag,
          mode: tx.mode,
          amount: tx.amount,
          direction: tx.direction,
          suggestedCategory: tx.suggestedCategory,
        })) : null;

        const response: ChatResponseDto = {
          success: result.success,
          response: result.response,
          pendingBatch: normalizedPendingBatch,
          chartImage: result.chartImage,
          error: result.error,
          workflowMode: result.workflowMode,
          cached: false,
          metadata: {
            llmCalls: result.metadata?.llmCalls,
            toolCalls: result.metadata?.toolCalls,
            executionTimeMs,
          },
        };

        // STEP 5: Cache successful responses for idempotency
        if (result.success) {
          await this.idempotencyService.cacheResponse(request.requestId, response);
        }

        this.logger.log(
          `[POST /api/chat] completed in ${executionTimeMs}ms, success=${result.success}, mode=${result.workflowMode}`,
        );

        return response;
      } finally {
        // STEP 6: Always release lock
        if (lockAcquired) {
          await this.idempotencyService.releaseLock(request.requestId);
        }
      }
    } catch (error) {
      this.logger.error(
        `[POST /api/chat] failed for request=${request.requestId}: ${error}`,
      );

      const executionTimeMs = Date.now() - startTime;

      return {
        success: false,
        response: 'An error occurred while processing your request.',
        error: error instanceof Error ? error.message : String(error),
        workflowMode: 'ERROR',
        cached: false,
        metadata: {
          executionTimeMs,
        },
      };
    }
  }

  /**
   * GET /api/chat/health
   * 
   * Health check endpoint
   */
  @Post('health')
  @HttpCode(HttpStatus.OK)
  async health(): Promise<{ status: string; workflow: string }> {
    return this.workflowService.healthCheck();
  }

  /**
   * GET /api/chat/download-workbook
   * 
   * Download the latest workbook from S3
   */
  @Get('download-workbook')
  async downloadWorkbook(@Res() res: Response): Promise<void> {
    try {
      this.logger.log('[GET /api/chat/download-workbook] Downloading workbook from S3');
      
      const buffer = await this.s3Service.downloadWorkbook();
      const filename = 'Budget_2026.xlsx';
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', buffer.length);
      
      this.logger.log(`[GET /api/chat/download-workbook] Sending ${buffer.length} bytes`);
      res.send(buffer);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[GET /api/chat/download-workbook] Error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        error: 'Failed to download workbook',
        message: errorMessage,
      });
    }
  }
}
