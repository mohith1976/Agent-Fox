/**
 * Workflow Module
 * 
 * Integrates workflow orchestration, registry, flow tracking, and implementations.
 * Provides WorkflowService as the main entry point for workflow execution.
 */

import { Module } from '@nestjs/common';
import { ExpenseWorkflow } from './expense/expense.workflow';
import { WorkflowService } from './workflow.service';
import { WorkflowRegistryService } from './workflow-registry.service';
import { FlowTrackingService } from './flow-tracking.service';
import { DatabaseModule } from '../database/database.module';
import { LlmModule } from '../llm/llm.module';
import { ToolsModule } from '../tools/tools.module';
import { LangGraphModule } from '../langgraph/langgraph.module';

@Module({
  imports: [
    DatabaseModule,
    LlmModule,
    ToolsModule,
    LangGraphModule,
  ],
  providers: [
    // Core workflow services
    WorkflowService,
    WorkflowRegistryService,
    FlowTrackingService,
    
    // Workflow implementations
    ExpenseWorkflow,
  ],
  exports: [
    WorkflowService,
    WorkflowRegistryService,
    FlowTrackingService,
    ExpenseWorkflow,
  ],
})
export class WorkflowModule {}

