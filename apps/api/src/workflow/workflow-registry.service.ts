import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AgentWorkflow } from '@prisma/client';
import { ExpenseWorkflow } from './expense/expense.workflow';

/**
 * WorkflowImplementation Interface
 * Defines the contract for workflow implementations
 */
export interface WorkflowImplementation {
  execute(input: {
    message: string;
    threadId: string;
    requestId: string;
    workflowConfig: AgentWorkflow;
    allowedTools?: Array<{ toolCode: string; [key: string]: any }>;
  }): Promise<any>;
  /**
   * Clear a WAITING checkpoint for a thread (STOP semantics).
   * Optional: workflows that don't support it simply omit it.
   */
  clearWaitingState?(threadId: string): Promise<boolean>;
}

/**
 * Workflow Registry Service
 * 
 * Responsibilities:
 * - Lookup workflows from database by triggerCode
 * - Route to hardcoded workflow implementations
 * - Validate workflow configuration
 * 
 * Architecture:
 * - Database provides configuration/registration
 * - Code provides implementation (expense.workflow.ts)
 * - Supports soft-delete (deletedAt column)
 */
@Injectable()
export class WorkflowRegistryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly expenseWorkflow: ExpenseWorkflow,
  ) {}

  /**
   * Find active workflow by trigger code
   * 
   * IMPORTANT: Uses findFirst because triggerCode is NOT unique in schema
   * Validates exactly one active workflow exists
   * 
   * @param triggerCode - The trigger code sent from frontend
   * @returns Active workflow configuration
   * @throws Error if multiple active workflows found or none found
   */
  async findByTriggerCode(triggerCode: string): Promise<AgentWorkflow> {
    // ✅ findFirst (triggerCode NOT unique in schema)
    const workflow = await this.prisma.agentWorkflow.findFirst({
      where: { triggerCode, deletedAt: null },
    });

    if (!workflow) {
      throw new Error(`Workflow not found: ${triggerCode}`);
    }

    // ✅ Validate exactly one active workflow
    const count = await this.prisma.agentWorkflow.count({
      where: { triggerCode, deletedAt: null },
    });

    if (count > 1) {
      throw new Error(
        `Multiple active workflows found for trigger code: ${triggerCode}`,
      );
    }

    return workflow;
  }

  /**
   * Get workflow implementation by trigger code
   *
   * Routes to the correct TypeScript implementation using the workflow's triggerCode.
   * Using triggerCode (not UUID) makes this resilient to DB re-seeds with different UUIDs.
   *
   * @param workflowId - The workflow UUID from database (used to look up triggerCode)
   * @returns Workflow implementation instance
   * @throws Error if implementation not found
   */
  async getImplementation(workflowId: string): Promise<WorkflowImplementation> {
    // Look up the workflow to get its triggerCode — more resilient than UUID switch
    const workflow = await this.prisma.agentWorkflow.findUnique({
      where: { id: workflowId },
      select: { triggerCode: true },
    });

    if (!workflow) {
      throw new Error(`Workflow not found for id: ${workflowId}`);
    }

    // Route by triggerCode — stable across re-seeds, not UUID-dependent
    switch (workflow.triggerCode) {
      case 'manual': // expense tracker workflow
        return this.expenseWorkflow;

      // Add new workflows here as triggerCode cases:
      // case 'budget_planner':
      //   return this.budgetWorkflow;

      default:
        throw new Error(
          `No implementation registered for triggerCode: ${workflow.triggerCode}`,
        );
    }
  }

  /**
   * List all active workflows
   * 
   * @returns Array of active workflow configurations
   */
  async listActive(): Promise<AgentWorkflow[]> {
    return this.prisma.agentWorkflow.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
    });
  }
}
