/**
 * Workflow Module
 * 
 * Integrates the expense workflow and its dependencies into NestJS.
 * Provides ExpenseWorkflow as a service that can be injected into controllers.
 */

import { Module } from '@nestjs/common';
import { ExpenseWorkflow } from './expense/expense.workflow';
import { ExpenseWorkflowService } from './expense/expense-workflow.service';
import { DatabaseModule } from '../database/database.module';
import { LlmModule } from '../llm/llm.module';
import { ToolsModule } from './tools/tools.module';

@Module({
  imports: [
    DatabaseModule,
    LlmModule,
    ToolsModule,
  ],
  providers: [ExpenseWorkflow, ExpenseWorkflowService],
  exports: [ExpenseWorkflow, ExpenseWorkflowService],
})
export class WorkflowModule {}
