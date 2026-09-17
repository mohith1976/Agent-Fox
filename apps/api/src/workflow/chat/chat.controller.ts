/**
 * Chat Controller
 * 
 * Exposes the API contract for the React frontend.
 * Handles chat requests with idempotency support and state recovery.
 */

import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Res,
  Req,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
  HttpException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { WorkflowService } from '../workflow.service';
import { WorkflowRegistryService } from '../workflow-registry.service';
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

  /** Workflow trigger code (e.g., 'expense_workflow') */
  triggerCode: string;
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
    private readonly workflowService: WorkflowService,
    private readonly workflowRegistry: WorkflowRegistryService,
    private readonly idempotencyService: IdempotencyService,
    private readonly s3Service: S3Service,
  ) {
    this.logger.log('ChatController initialized');
  }

  /**
   * POST /api/chat
   * 
   * Execute workflow for a user message.
   * Supports idempotency via requestId.
   * Routes to appropriate workflow via triggerCode.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async chat(@Body() request: ChatRequestDto): Promise<ChatResponseDto> {
    const startTime = Date.now();

    // Validate request
    if (!request.requestId || !request.threadId || !request.message || !request.triggerCode) {
      throw new BadRequestException(
        'requestId, threadId, message, and triggerCode are required',
      );
    }

    this.logger.log(
      `[POST /api/chat] thread=${request.threadId}, request=${request.requestId}, trigger=${request.triggerCode}, message="${request.message.substring(0, 50)}..."`,
    );

    try {
      // STEP 0a: STOP interception at the request boundary (BEFORE LangGraph).
      // Exact keyword only — "stop buying groceries" etc. are normal messages.
      // Never creates FlowTracking, never invokes the graph, never touches checkpoints.
      if (request.message.trim().toLowerCase() === 'stop') {
        const { stopped } = await this.workflowService.requestStop(
          request.threadId,
          request.triggerCode,
        );

        this.logger.log(
          `[POST /api/chat] STOP for thread=${request.threadId}: ${stopped ? 'session ended' : 'no active execution'}`,
        );

        return {
          success: true,
          response: stopped ? 'Flow stopped.' : 'No flow is currently running.',
          workflowMode: 'IDLE',
          cached: false,
        };
      }

      // STEP 0b: Look up workflow from database using triggerCode
      const workflow = await this.workflowRegistry.findByTriggerCode(request.triggerCode);
      const workflowId = workflow.id;

      this.logger.log(
        `[POST /api/chat] resolved workflow: id=${workflowId}, name=${workflow.name}`,
      );

      // STEP 1: Check idempotency cache FIRST (before acquiring lock)
      const cachedResponse =
        await this.idempotencyService.getCachedResponse(request.requestId, workflowId);

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
        
        // Poll for cached response (the other request will cache it).
        // Bounded with linear backoff: up to ~30s total, then fail fast
        // instead of hammering PostgreSQL with 300 fixed-interval queries.
        const MAX_POLL_ATTEMPTS = 30;
        for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 200 + attempt * 100));
          
          const cachedAfterWait = await this.idempotencyService.getCachedResponse(request.requestId, workflowId);
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
        
        // Bounded wait exhausted — fail fast so the client can retry with a new requestId
        this.logger.error(`[POST /api/chat] timeout waiting for cached response for request=${request.requestId}`);
        throw new Error('Request timeout: another instance is still processing this request');
      }

      try {
        // STEP 3: Double-check cache (in case we won the race after lock)
        const cachedAfterLock =
          await this.idempotencyService.getCachedResponse(request.requestId, workflowId);

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

        // STEP 4: Execute workflow via WorkflowService
        const result = await this.workflowService.execute({
          triggerCode: request.triggerCode,
          message: request.message,
          threadId: request.threadId,
          requestId: request.requestId,
        });

        const executionTimeMs = Date.now() - startTime;

        // Map WorkflowService result to ChatResponseDto
        // llmCalls/toolCalls are MEASURED graph-state counters (never estimates).
        const response: ChatResponseDto = {
          success: result.status === 'completed',
          response: result.result?.lastResponse || result.error || 'No response',
          pendingBatch: result.result?.pendingBatch || null,
          chartImage: result.result?.chartImage || null,
          error: result.error || null,
          workflowMode: result.result?.workflowMode || 'IDLE',
          cached: false,
          metadata: {
            llmCalls: result.result?.metadata?.llmCalls || 0,
            toolCalls: result.result?.metadata?.toolCalls || 0,
            executionTimeMs,
          },
        };

        // STEP 5: Cache successful responses for idempotency
        if (result.status === 'completed') {
          await this.idempotencyService.cacheResponse(request.requestId, response, workflowId);
        }

        this.logger.log(
          `[POST /api/chat] completed in ${executionTimeMs}ms, status=${result.status}, mode=${response.workflowMode}`,
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
   * GET /api/chat/state/:threadId
   * 
   * Recover conversation state for a thread.
   * Used by frontend on mount/refresh to restore pending batches and conversation state.
   */
  @Get('state/:threadId')
  @HttpCode(HttpStatus.OK)
  async getState(@Param('threadId') threadId: string): Promise<{
    messages: any[];
    pendingBatch: any | null;
    lastResponse: string;
    status: string;
  }> {
    this.logger.log(`[GET /api/chat/state/:threadId] Recovering state for thread=${threadId}`);

    try {
      const state = await this.workflowService.recoverState(threadId);

      this.logger.log(
        `[GET /api/chat/state/:threadId] Recovered state: status=${state.status}, hasPending=${!!state.pendingBatch}`,
      );

      return state;
    } catch (error) {
      this.logger.error(
        `[GET /api/chat/state/:threadId] Failed to recover state: ${error instanceof Error ? error.message : String(error)}`,
      );

      // Return empty state on error
      return {
        messages: [],
        pendingBatch: null,
        lastResponse: '',
        status: 'idle',
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
  async health(): Promise<{ status: string; service: string }> {
    return {
      status: 'ok',
      service: 'chat-controller',
    };
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

  /**
   * POST /api/chat/upload-workbook
   * 
   * Upload Budget_2026.xlsx to S3 (replaces existing file)
   */
  @Post('upload-workbook')
  @HttpCode(HttpStatus.OK)
  async uploadWorkbook(@Req() req: Request): Promise<{ success: boolean; message: string; filename: string }> {
    try {
      this.logger.log('[POST /api/chat/upload-workbook] Starting upload');

      // Read file buffer from request body
      const chunks: Buffer[] = [];
      for await (const chunk of req as any) {
        chunks.push(Buffer.from(chunk));
      }
      const fileBuffer = Buffer.concat(chunks);

      if (fileBuffer.length === 0) {
        throw new HttpException('Empty file uploaded', HttpStatus.BAD_REQUEST);
      }

      this.logger.log(`[POST /api/chat/upload-workbook] File size: ${fileBuffer.length} bytes`);

      // Upload to S3 (replaces existing file - same key)
      await this.s3Service.uploadWorkbook(fileBuffer);

      this.logger.log('[POST /api/chat/upload-workbook] Upload successful');

      return {
        success: true,
        message: 'Workbook uploaded and replaced successfully',
        filename: 'Budget_2026.xlsx',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[POST /api/chat/upload-workbook] Error: ${errorMessage}`);

      if (error instanceof HttpException) {
        throw error;
      }

      throw new HttpException(
        'Failed to upload workbook',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
