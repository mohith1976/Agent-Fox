import { Injectable, Logger } from '@nestjs/common';
import { StateGraph, END, START } from '@langchain/langgraph';
import { createClient, RedisClientType } from 'redis';
import { ExpenseWorkflowState, WorkflowMode } from './expense.state';
import { createExpenseNodes } from './expense.nodes';
import { ExpenseEdges } from './expense.edges';
import { LangGraphService } from '../../langgraph/langgraph.service';
import { IntentClassifier } from '../../llm/intent-classifier.service';
import { TransactionExtractor } from '../../llm/transaction-extractor.service';
import { EditParser } from '../../llm/edit-parser.service';
import { QueryInterpreter } from '../../llm/query-interpreter.service';
import { AnswerGenerator } from '../../llm/answer-generator.service';
import { SchemaValidator } from '../../llm/schema-validator.service';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { FlowTrackingService } from '../flow-tracking.service';

/**
 * Expense Workflow
 *
 * Orchestrates expense tracking with modular architecture:
 * - Nodes: Classification, transaction parsing, confirmation, writing
 * - Edges: Conditional routing with bounded retry loops
 * - Config: Timeouts, retry limits, TTL
 */
@Injectable()
export class ExpenseWorkflow {
  private readonly logger = new Logger(ExpenseWorkflow.name);
  private redis!: RedisClientType;

  constructor(
    private readonly langGraphService: LangGraphService,
    private readonly intentClassifier: IntentClassifier,
    private readonly transactionExtractor: TransactionExtractor,
    private readonly editParser: EditParser,
    private readonly queryInterpreter: QueryInterpreter,
    private readonly answerGenerator: AnswerGenerator,
    private readonly schemaValidator: SchemaValidator,
    private readonly toolExecutor: ToolExecutorService,
    private readonly flowTrackingService: FlowTrackingService,
  ) {
    // Initialize Redis for safety checks (use same package as RedisSaver)
    this.initializeRedis();
    this.logger.log('ExpenseWorkflow initialized');
  }

  private async initializeRedis() {
    this.redis = createClient({
      url: `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6380'}`,
      password: process.env.REDIS_PASSWORD,
      database: parseInt(process.env.REDIS_DB || '0'),
    });

    this.redis.on('error', (err) => {
      this.logger.error(`Redis client error: ${err.message}`);
    });

    await this.redis.connect();
  }

  /**
   * Build LangGraph workflow with modular nodes and edges.
   *
   * Called per-execution so node deps (workflowPrompt, allowedToolCodes) can be
   * injected at runtime from the DB-loaded workflowConfig.
   *
   * @param workflowPrompt - agent_workflows.prompt from DB, passed to AnswerGenerator
   * @param allowedToolCodes - tool_code strings from agent_workflows.toolsId, enforced in ToolExecutor
   */
  private buildGraph(workflowPrompt: string, allowedToolCodes: string[]) {
    // Create nodes with all injected dependencies
    const nodes = createExpenseNodes({
      intentClassifier: this.intentClassifier,
      transactionExtractor: this.transactionExtractor,
      editParser: this.editParser,
      queryInterpreter: this.queryInterpreter,
      answerGenerator: this.answerGenerator,
      schemaValidator: this.schemaValidator,
      toolExecutor: this.toolExecutor,
      redis: this.redis,
      flowTrackingService: this.flowTrackingService,
      // DB-driven runtime configuration
      workflowPrompt,
      allowedToolCodes,
    });

    // Build graph using fluent chaining (26 nodes)
    const compiledGraph = new StateGraph(ExpenseWorkflowState)
      .addNode('classify_intent', nodes.classifyIntent)
      .addNode('start_combination', nodes.start_combination)
      .addNode('answer_subqueries', nodes.answer_subqueries)
      .addNode('answer_deferred_subs', nodes.answer_deferred_subs)
      .addNode('broaden_previous', nodes.broaden_previous)
      .addNode('parse_transactions', nodes.parseTransactions)
      .addNode('validate_transaction_data', nodes.validateTransactionData)
      .addNode('request_clarification', nodes.requestClarification)
      .addNode('parse_clarification', nodes.parseClarification)
      .addNode('merge_with_pending', nodes.mergeWithPending)
      .addNode('present_batch', nodes.presentBatch)
      .addNode('parse_edit_or_confirm', nodes.parseEditOrConfirm)
      .addNode('merge_edits', nodes.mergeEdits)
      .addNode('write_batch', nodes.writeBatch)
      .addNode('clear_batch', nodes.clearBatch)
      .addNode('reject_incomplete_transaction', nodes.rejectIncompleteTransaction)
      .addNode('interpret_query', nodes.interpretQuery)
      .addNode('retrieve_transactions', nodes.retrieveTransactions)
      .addNode('validate_query_result', nodes.validateQueryResult)
      .addNode('transform_query', nodes.transformQuery)
      .addNode('generate_answer', nodes.generateAnswer)
      .addNode('validate_answer', nodes.validateAnswer)
      .addNode('regenerate_answer', nodes.regenerateAnswer)
      .addNode('inform_user_insufficient', nodes.informUserInsufficient)
      .addNode('build_chart', nodes.buildChart)
      .addNode('request_user_clarification', nodes.requestUserClarification)
      .addNode('handle_error', nodes.handleError)
      // Add edges
      .addConditionalEdges(START, ExpenseEdges.routeFromStart)
      .addConditionalEdges('classify_intent', ExpenseEdges.routeByIntent)
      .addEdge('start_combination', 'parse_transactions')
      .addEdge('broaden_previous', 'retrieve_transactions')
      .addEdge('parse_transactions', 'validate_transaction_data')
      .addConditionalEdges('validate_transaction_data', ExpenseEdges.routeAfterValidation)
      .addEdge('request_clarification', END) // Waiting state
      .addEdge('parse_clarification', 'merge_with_pending')
      .addEdge('merge_with_pending', 'validate_transaction_data')
      .addEdge('present_batch', END) // Waiting state
      .addConditionalEdges('parse_edit_or_confirm', ExpenseEdges.routeAfterEditConfirm)
      .addEdge('merge_edits', 'present_batch')
      .addConditionalEdges('write_batch', ExpenseEdges.routeAfterWrite)
      .addEdge('answer_deferred_subs', END)
      .addEdge('clear_batch', END)
      .addEdge('reject_incomplete_transaction', END)
      .addEdge('interpret_query', 'retrieve_transactions')
      .addEdge('retrieve_transactions', 'validate_query_result')
      .addConditionalEdges('validate_query_result', ExpenseEdges.routeAfterQueryValidation)
      .addEdge('transform_query', 'retrieve_transactions')
      .addEdge('generate_answer', 'validate_answer')
      .addConditionalEdges('validate_answer', ExpenseEdges.routeAfterAnswerValidation)
      .addEdge('regenerate_answer', 'validate_answer')
      .addEdge('inform_user_insufficient', END)
      .addEdge('build_chart', END)
      .addEdge('request_user_clarification', END) // Waiting state
      .addEdge('handle_error', END)
      // Compile with LangGraphService (uses RedisSaver)
      .compile({ checkpointer: this.langGraphService.getCheckpointer() });

    this.logger.log('Graph compiled successfully with RedisSaver checkpointing');
    return compiledGraph;
  }

  /**
   * Execute workflow
   *
   * @param input - Execution parameters including workflowConfig (from DB) and allowedTools
   * @returns Workflow result
   */
  async execute(input: {
    message: string;
    threadId: string;
    requestId: string;
    workflowConfig: any;
    allowedTools?: Array<{ toolCode: string }>;
  }): Promise<any> {
    this.logger.log(
      `Executing expense workflow: thread=${input.threadId}, request=${input.requestId}`,
    );

    // Extract DB-driven runtime configuration
    const workflowPrompt: string = input.workflowConfig?.prompt || '';
    const allowedToolCodes: string[] =
      (input.allowedTools || []).map((t) => t.toolCode);

    this.logger.log(
      `Workflow prompt: "${workflowPrompt.substring(0, 60)}..." | Allowed tools: [${allowedToolCodes.join(', ')}]`,
    );

    try {
      // Per-request metering scope: checkpointed counters accumulate across
      // turns on a thread, so snapshot them BEFORE invoke and report DELTAS.
      // Otherwise a 2-call "cancel" on a long thread would report 6+ calls.
      let prior = { llmCalls: 0, toolCalls: 0, tokens: 0 };
      try {
        const prevState =
          await this.langGraphService.getWorkflowState<any>(input.threadId);
        if (prevState?.metadata) {
          prior = {
            llmCalls: prevState.metadata.llmCalls || 0,
            toolCalls: prevState.metadata.toolCalls || 0,
            tokens: prevState.metadata.tokens || 0,
          };
        }
      } catch {
        // No checkpoint yet (first turn) — deltas equal totals.
      }

      // Build graph with per-execution DB-driven config
      const compiledGraph = this.buildGraph(workflowPrompt, allowedToolCodes);

      // Prepare initial state — only request-specific fields
      // Checkpointed state (workflowMode, pendingBatch, counters) comes from Redis
      const initialState = {
        requestId: input.requestId,
        threadId: input.threadId,
        message: input.message,
        userId: 'default-user', // TODO: Get from auth context
        flowTrackingId: null,   // Set by WorkflowService
      };

      const config = {
        configurable: {
          thread_id: input.threadId,
        },
      };

      const result = await compiledGraph.invoke(initialState, config);

      this.logger.log(
        `Workflow completed: status=${result.status || 'success'}, mode=${result.workflowMode}`,
      );

      const total = result.metadata || {};
      const delta = {
        llmCalls: Math.max(0, (total.llmCalls || 0) - prior.llmCalls),
        toolCalls: Math.max(0, (total.toolCalls || 0) - prior.toolCalls),
        tokens: Math.max(0, (total.tokens || 0) - prior.tokens),
      };

      return {
        success: !result.error,
        response: result.lastResponse || 'No response',
        pendingBatch: result.pendingBatch || null,
        chartImage: result.chartImage || null,
        error: result.error || null,
        workflowMode: result.workflowMode || 'IDLE',
        metadata: {
          ...delta,
          executionTimeMs: result.metadata?.completedAt
            ? new Date(result.metadata.completedAt).getTime() -
              new Date(result.metadata.startedAt || Date.now()).getTime()
            : 0,
        },
      };
    } catch (error) {
      this.logger.error(
        `Workflow execution failed: ${error instanceof Error ? error.message : String(error)}`,
      );

      return {
        success: false,
        response: 'An error occurred while processing your request.',
        error: error instanceof Error ? error.message : String(error),
        workflowMode: 'ERROR',
        pendingBatch: null,
        chartImage: null,
        metadata: {
          llmCalls: 0,
          toolCalls: 0,
          executionTimeMs: 0,
        },
      };
    }
  }

  /**
   * Clear a WAITING checkpoint (clarification / confirmation) for a thread.
   *
   * STOP during a waiting state finds no active lock (the graph finished and
   * checkpointed). Ending the session anyway is what users mean by "stop":
   * this uses LangGraph's official updateState API to reset the waiting
   * fields while keeping the transcript, so the next message starts fresh
   * instead of resuming the abandoned flow.
   *
   * @returns true when a waiting state was actually cleared
   */
  async clearWaitingState(threadId: string): Promise<boolean> {
    let checkpoint: any = null;
    try {
      checkpoint =
        await this.langGraphService.getWorkflowState<any>(threadId);
    } catch (error) {
      this.logger.error(`STOP: failed to read checkpoint for ${threadId}`);
      return false;
    }

    if (!checkpoint) {
      return false;
    }

    const mode = checkpoint.workflowMode;
    const waiting =
      mode === WorkflowMode.PENDING_CONFIRMATION ||
      mode === WorkflowMode.AWAITING_CLARIFICATION ||
      mode === WorkflowMode.AWAITING_USER_CLARIFICATION;

    if (!waiting) {
      return false;
    }

    // updateState needs a compiled graph; node deps are irrelevant here
    // because no node executes — this only writes checkpoint state.
    const compiledGraph = this.buildGraph('', []);

    await compiledGraph.updateState(
      { configurable: { thread_id: threadId } },
      {
        workflowMode: WorkflowMode.IDLE,
        pendingBatch: null,
        rawTransactions: [],
        validatedTransactions: [],
        clarificationData: null,
        extractionAmbiguities: [],
        clarificationAttempts: 0,
        clarificationRounds: 0,
        unknownAttempts: 0,
        pendingClarificationContext: null,
        missingFields: [],
        validationStatus: null,
        confirmAction: null,
        edits: [],
        subRequests: null,
        pendingSubs: [],
        broadenOffered: false,
        error: null,
        status: null,
        lastResponse: 'Flow stopped.',
        messages: [
          {
            id: `stop-${Date.now()}`,
            role: 'assistant' as const,
            content: 'Flow stopped.',
            timestamp: new Date().toISOString(),
          },
        ],
      } as any,
    );

    this.logger.log(
      `STOP: cleared waiting state (${mode}) for thread ${threadId}`,
    );
    return true;
  }
}

