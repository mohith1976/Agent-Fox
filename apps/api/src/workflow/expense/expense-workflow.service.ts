/**
 * Expense Workflow Service
 * 
 * NestJS service wrapper for the ExpenseWorkflow.
 * Provides a clean interface for controllers to execute the workflow.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ExpenseWorkflow } from './expense.workflow';
import { ExpenseWorkflowStateType } from './expense.state';

/**
 * Request DTO for workflow execution
 */
export interface ExecuteWorkflowRequest {
  /** Unique request/message identifier (for idempotency) */
  requestId: string;
  
  /** Thread/conversation identifier */
  threadId: string;
  
  /** User message */
  message: string;
}

/**
 * Response DTO for workflow execution
 */
export interface ExecuteWorkflowResponse {
  /** Success indicator */
  success: boolean;
  
  /** Agent response text */
  response: string;
  
  /** Pending batch (if awaiting confirmation) */
  pendingBatch?: Array<{
    itemNumber: number;
    date: string;
    description: string;
    tag: string | null;
    mode: string;
    amount: number;
    direction: string;
    suggestedCategory: string | null;
  }> | null;
  
  /** Chart image (base64 encoded, if generated) */
  chartImage?: string | null;
  
  /** Error message (if failed) */
  error?: string | null;
  
  /** Workflow mode */
  workflowMode: string;
  
  /** Execution metadata */
  metadata?: {
    llmCalls?: number;
    toolCalls?: number;
    startedAt?: Date;
    completedAt?: Date;
  };
}

@Injectable()
export class ExpenseWorkflowService {
  private readonly logger = new Logger(ExpenseWorkflowService.name);

  constructor(private readonly expenseWorkflow: ExpenseWorkflow) {
    this.logger.log('ExpenseWorkflowService initialized');
  }

  /**
   * Execute the expense workflow
   */
  async execute(
    request: ExecuteWorkflowRequest,
  ): Promise<ExecuteWorkflowResponse> {
    this.logger.log(
      `Executing workflow: thread=${request.threadId}, request=${request.requestId}`,
    );

    try {
      // Execute the workflow
      const state: ExpenseWorkflowStateType =
        await this.expenseWorkflow.execute(
          request.requestId,
          request.threadId,
          request.message,
        );

      // Map to response DTO
      const response: ExecuteWorkflowResponse = {
        success: !state.error,
        response: state.lastResponse,
        pendingBatch: state.pendingBatch,
        chartImage: state.chartImage,
        error: state.error,
        workflowMode: state.workflowMode,
        metadata: {
          llmCalls: state.metadata.llmCalls,
          toolCalls: state.metadata.toolCalls,
          startedAt: state.metadata.startedAt,
          completedAt: state.metadata.completedAt,
        },
      };

      this.logger.log(
        `Workflow completed: success=${response.success}, mode=${response.workflowMode}`,
      );

      return response;
    } catch (error) {
      this.logger.error(`Workflow execution failed: ${error}`);

      return {
        success: false,
        response: 'An error occurred while processing your request.',
        error: error instanceof Error ? error.message : String(error),
        workflowMode: 'ERROR',
      };
    }
  }

  /**
   * Get workflow health status
   */
  async healthCheck(): Promise<{ status: string; workflow: string }> {
    return {
      status: 'healthy',
      workflow: 'expense',
    };
  }
}
