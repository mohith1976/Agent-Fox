import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { FlowTracking } from '@prisma/client';

/**
 * Flow Tracking Service
 * 
 * Responsibilities:
 * - Track workflow execution lifecycle
 * - Record execution metadata (tokens, cost, model)
 * - Provide analytics and debugging data
 * - Monitor execution status
 * 
 * Lifecycle:
 * 1. start() - Create running record
 * 2. complete() - Mark as completed/failed with metrics
 * 3. fail() - Mark as failed with error details
 */
@Injectable()
export class FlowTrackingService {
  private readonly logger = new Logger(FlowTrackingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Start flow tracking
   * Creates a new flow tracking record with 'running' status
   * 
   * @param data - Workflow and input information
   * @returns Created flow tracking record
   */
  async start(data: {
    workflowId: string;
    data: { input: any };
  }): Promise<FlowTracking> {
    this.logger.log(`Starting flow tracking for workflow: ${data.workflowId}`);

    return this.prisma.flowTracking.create({
      data: {
        workflowId: data.workflowId,
        status: 'running',
        data: data.data,
        createdAt: new Date(),
      },
    });
  }

  /**
   * Complete flow tracking
   * Updates flow tracking with final status and execution metadata
   * 
   * @param id - Flow tracking ID
   * @param data - Completion data with status, output, and metrics
   */
  async complete(
    id: string,
    data: {
      status: 'completed' | 'failed';
      data: { input: any; output: any };
      tokens: number; // ✅ Actual tokens from LLM
      model: string; // ✅ Actual model used
      cost: number; // ✅ Actual cost
    },
  ): Promise<void> {
    this.logger.log(
      `Completing flow tracking ${id}: status=${data.status}, tokens=${data.tokens}, cost=${data.cost}`,
    );

    await this.prisma.flowTracking.update({
      where: { id },
      data: {
        status: data.status,
        data: data.data,
        tokens: data.tokens,
        model: data.model,
        cost: data.cost,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Mark flow as failed
   * Used when execution terminates abnormally (ownership loss, cancellation, errors)
   * 
   * @param id - Flow tracking ID
   * @param data - Failure details
   */
  async fail(
    id: string,
    data: {
      error: string;
      reason?: string; // e.g., 'ownership_lost', 'cancelled', 'exception'
      data?: any;
    },
  ): Promise<void> {
    this.logger.error(
      `Marking flow tracking ${id} as failed: ${data.reason || 'unknown'} - ${data.error}`,
    );

    await this.prisma.flowTracking.update({
      where: { id },
      data: {
        status: 'failed',
        data: {
          error: data.error,
          reason: data.reason,
          ...(data.data || {}),
        },
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Get flow tracking by ID
   * 
   * @param id - Flow tracking ID
   * @returns Flow tracking record or null
   */
  async findById(id: string): Promise<FlowTracking | null> {
    return this.prisma.flowTracking.findUnique({
      where: { id },
    });
  }

  /**
   * Get recent flow trackings for a workflow
   * 
   * @param workflowId - Workflow UUID
   * @param limit - Maximum number of records to return
   * @returns Array of flow tracking records
   */
  async findByWorkflow(
    workflowId: string,
    limit: number = 50,
  ): Promise<FlowTracking[]> {
    return this.prisma.flowTracking.findMany({
      where: { workflowId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Get running flows for a workflow
   * Useful for debugging stuck executions
   * 
   * @param workflowId - Workflow UUID
   * @returns Array of running flow tracking records
   */
  async findRunning(workflowId?: string): Promise<FlowTracking[]> {
    return this.prisma.flowTracking.findMany({
      where: {
        status: 'running',
        ...(workflowId && { workflowId }),
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
