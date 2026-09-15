/**
 * Expense Workflow - Single LangGraph Workflow
 * 
 * Orchestrates the complete expense tracking flow:
 * 1. classify_intent - Determine what the user wants to do
 * 2. parse_transactions - Extract structured transaction data
 * 3. present_batch - Show numbered review, pause for confirmation
 * 4. parse_edit_or_confirm - Interpret confirmation or edits
 * 5. write_batch - Execute deterministic workbook writes
 * 6. answer_query - Handle analytical questions
 * 
 * Per design requirements:
 * - Exactly ONE workflow (expense)
 * - Multi-turn confirmation/edit cycle
 * - Persistent state via checkpointing
 * - LLM for intelligence, deterministic tools for financial operations
 * - No financial writes without confirmation
 */

import { Injectable, Logger } from '@nestjs/common';
import { StateGraph, END, START } from '@langchain/langgraph';
import {
  ExpenseWorkflowState,
  ExpenseWorkflowStateType,
  WorkflowMode,
  IntentType,
  PendingTransaction,
  formatPendingBatch,
} from './expense.state';
import { PostgresCheckpointSaver } from './postgres-checkpoint.saver';
import { PrismaService } from '../../database/prisma.service';
import { IntentClassifier } from '../../llm/intent-classifier.service';
import { TransactionExtractor } from '../../llm/transaction-extractor.service';
import { EditParser } from '../../llm/edit-parser.service';
import { QueryInterpreter } from '../../llm/query-interpreter.service';
import { LogTransactionTool } from '../tools/log-transaction.tool';
import { LogTransactionBatchTool } from '../tools/log-transaction-batch.tool';
import { QueryTransactionsTool } from '../tools/query-transactions.tool';
import { GenerateChartTool } from '../tools/generate-chart.tool';

/**
 * Expense Workflow Graph
 * 
 * Implements the complete expense tracking state machine using LangGraph
 */
@Injectable()
export class ExpenseWorkflow {
  private readonly logger = new Logger(ExpenseWorkflow.name);
  private readonly workflowId = 'expense-workflow';
  private graph: ReturnType<typeof this.buildGraph>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly intentClassifier: IntentClassifier,
    private readonly transactionExtractor: TransactionExtractor,
    private readonly editParser: EditParser,
    private readonly queryInterpreter: QueryInterpreter,
    private readonly logTransactionTool: LogTransactionTool,
    private readonly logTransactionBatchTool: LogTransactionBatchTool,
    private readonly queryTransactionsTool: QueryTransactionsTool,
    private readonly generateChartTool: GenerateChartTool,
  ) {
    this.graph = this.buildGraph();
    this.logger.log('ExpenseWorkflow initialized');
  }

  /**
   * Build the LangGraph state machine
   */
  private buildGraph() {
    const workflow = new StateGraph(ExpenseWorkflowState)
      // Stage 1: Classify Intent
      .addNode('classify_intent', this.classifyIntent.bind(this))
      
      // Stage 2: Parse Transactions
      .addNode('parse_transactions', this.parseTransactions.bind(this))
      
      // Stage 3: Present Batch
      .addNode('present_batch', this.presentBatch.bind(this))
      
      // Stage 4: Parse Edit or Confirm
      .addNode('parse_edit_or_confirm', this.parseEditOrConfirm.bind(this))
      
      // Stage 5: Write Batch
      .addNode('write_batch', this.writeBatch.bind(this))
      
      // Stage 6: Answer Query
      .addNode('answer_query', this.answerQuery.bind(this));

    // Define edges (routing logic)
    workflow.addEdge(START, 'classify_intent');

    // From classify_intent, route based on intent
    workflow.addConditionalEdges('classify_intent', (state) => {
      if (state.intent === IntentType.NEW_TRANSACTION_BATCH) {
        return 'parse_transactions';
      } else if (state.intent === IntentType.EDIT_OR_CONFIRM) {
        return 'parse_edit_or_confirm';
      } else if (state.intent === IntentType.ANALYTICAL_QUERY) {
        return 'answer_query';
      }
      return END;
    });

    // After parsing transactions, present batch
    workflow.addEdge('parse_transactions', 'present_batch');

    // After presenting batch, wait for next user input (END)
    workflow.addEdge('present_batch', END);

    // From edit/confirm, either re-present or write
    workflow.addConditionalEdges('parse_edit_or_confirm', (state) => {
      // If it's an edit, re-present the batch
      if (state.workflowMode === WorkflowMode.PENDING_CONFIRMATION) {
        return 'present_batch';
      }
      // If it's a confirmation, write the batch
      return 'write_batch';
    });

    // After writing batch, we're done
    workflow.addEdge('write_batch', END);

    // After answering query, we're done
    workflow.addEdge('answer_query', END);

    // Compile graph WITH checkpoint saver using real expense workflow UUID
    const expenseWorkflowId = process.env.EXPENSE_WORKFLOW_ID;
    if (!expenseWorkflowId) {
      throw new Error('EXPENSE_WORKFLOW_ID not found in environment');
    }
    
    const checkpointSaver = new PostgresCheckpointSaver(
      this.prisma,
      expenseWorkflowId,
    );

    return workflow.compile({ checkpointer: checkpointSaver });
  }

  /**
   * Execute the workflow
   */
  async execute(
    requestId: string,
    threadId: string,
    message: string,
  ): Promise<ExpenseWorkflowStateType> {
    this.logger.log(
      `Executing workflow for thread=${threadId}, request=${requestId}`,
    );

    try {
      // LangGraph with checkpoint: provide input that will be MERGED with restored state
      // The checkpoint will restore: pendingBatch, workflowMode, etc.
      // We only need to provide the new message and requestId
      const input: Partial<ExpenseWorkflowStateType> = {
        requestId,
        threadId,
        message,
      };

      // Execute graph with checkpoint restoration
      const config = {
        configurable: {
          thread_id: threadId,
        },
      };

      this.logger.log(`[EXECUTE] Invoking graph with thread_id=${threadId}, will restore checkpoint if exists`);
      
      // LangGraph will:
      // 1. Call checkpointer.getTuple(config) to load checkpoint
      // 2. Merge input with restored state
      // 3. Execute workflow from restored state
      const result = await this.graph.invoke(input, config);

      this.logger.log(
        `Workflow completed for thread=${threadId}, mode=${result.workflowMode}`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `Workflow execution failed for thread=${threadId}: ${error}`,
      );
      throw error;
    }
  }

  /**
   * STAGE 1: Classify Intent
   * 
   * Determines what the user wants to do:
   * - NEW_TRANSACTION_BATCH: Recording new expenses
   * - EDIT_OR_CONFIRM: Responding to a pending batch
   * - ANALYTICAL_QUERY: Asking questions about spending
   */
  private async classifyIntent(
    state: ExpenseWorkflowStateType,
  ): Promise<Partial<ExpenseWorkflowStateType>> {
    this.logger.log(`[classify_intent] thread=${state.threadId}`);

    try {
      // Check if there's already a pending batch
      const hasPendingBatch =
        state.pendingBatch !== null && state.pendingBatch.length > 0;

      // Classify the intent
      const result = await this.intentClassifier.classify(
        state.message,
        hasPendingBatch,
      );

      this.logger.log(
        `[classify_intent] intent=${result.intent}, confidence=${result.confidence}`,
      );

      return {
        intent: result.intent as IntentType,
        metadata: {
          ...state.metadata,
          llmCalls: (state.metadata.llmCalls || 0) + 1,
          lastStage: 'classify_intent',
        },
      };
    } catch (error) {
      this.logger.error(`[classify_intent] failed: ${error}`);
      return {
        error: `Failed to classify intent: ${error}`,
        workflowMode: WorkflowMode.ERROR,
        metadata: {
          ...state.metadata,
          errorStage: 'classify_intent',
        },
      };
    }
  }

  /**
   * STAGE 2: Parse Transactions
   * 
   * Extracts structured transaction data from natural language.
   * Creates a pending batch but does NOT write to workbook.
   */
  private async parseTransactions(
    state: ExpenseWorkflowStateType,
  ): Promise<Partial<ExpenseWorkflowStateType>> {
    this.logger.log(`[parse_transactions] thread=${state.threadId}`);

    try {
      // Extract transactions using Phase 3 service
      const result = await this.transactionExtractor.extract(state.message);

      // Convert to pending transaction format with item numbers
      const pendingBatch: PendingTransaction[] = result.transactions.map(
        (tx, index) => ({
          itemNumber: index + 1,
          date: tx.date,
          description: tx.description,
          tag: tx.tag,
          mode: tx.mode as 'PHONEPAY' | 'WALLET' | 'MONEY' | 'BANK',
          amount: tx.amount,
          direction: tx.direction as 'DEBIT' | 'CREDIT',
          suggestedCategory: tx.suggestedCategory as any,
        }),
      );

      this.logger.log(
        `[parse_transactions] extracted ${pendingBatch.length} transaction(s)`,
      );

      // CRITICAL: Set mode to PENDING_CONFIRMATION
      // NO workbook write occurs at this stage
      return {
        pendingBatch,
        workflowMode: WorkflowMode.PENDING_CONFIRMATION,
        metadata: {
          ...state.metadata,
          llmCalls: (state.metadata.llmCalls || 0) + 1,
          lastStage: 'parse_transactions',
        },
      };
    } catch (error) {
      this.logger.error(`[parse_transactions] failed: ${error}`);
      return {
        error: `Failed to parse transactions: ${error}`,
        workflowMode: WorkflowMode.ERROR,
        metadata: {
          ...state.metadata,
          errorStage: 'parse_transactions',
        },
      };
    }
  }

  /**
   * STAGE 3: Present Batch
   * 
   * Formats pending batch as numbered review list.
   * Workflow pauses here - waits for user's next message.
   * 
   * CRITICAL: NO workbook write occurs. Batch remains pending.
   */
  private async presentBatch(
    state: ExpenseWorkflowStateType,
  ): Promise<Partial<ExpenseWorkflowStateType>> {
    this.logger.log(`[present_batch] thread=${state.threadId}`);

    if (!state.pendingBatch || state.pendingBatch.length === 0) {
      return {
        error: 'No pending batch to present',
        workflowMode: WorkflowMode.ERROR,
      };
    }

    // Format the batch for display
    const formattedBatch = formatPendingBatch(state.pendingBatch);
    const response = `${formattedBatch}\n\nConfirm?`;

    this.logger.log(
      `[present_batch] displaying ${state.pendingBatch.length} item(s)`,
    );

    // Workflow remains in PENDING_CONFIRMATION mode
    // Graph will END here, waiting for next user input
    return {
      lastResponse: response,
      workflowMode: WorkflowMode.PENDING_CONFIRMATION,
      metadata: {
        ...state.metadata,
        lastStage: 'present_batch',
        completedAt: new Date(),
      },
    };
  }

  /**
   * STAGE 4: Parse Edit or Confirm
   * 
   * Interprets the user's response to a pending batch:
   * - Confirmation: Proceed to write_batch
   * - Edit: Modify specific item, re-present batch
   * 
   * CRITICAL: Edits affect ONLY the referenced item.
   */
  private async parseEditOrConfirm(
    state: ExpenseWorkflowStateType,
  ): Promise<Partial<ExpenseWorkflowStateType>> {
    this.logger.log(`[parse_edit_or_confirm] thread=${state.threadId}`);

    if (!state.pendingBatch || state.pendingBatch.length === 0) {
      return {
        error: 'No pending batch to edit or confirm',
        workflowMode: WorkflowMode.ERROR,
      };
    }

    try {
      // Parse edit or confirmation using Phase 3 service
      const result = await this.editParser.parse(
        state.message,
        state.pendingBatch,
      );

      this.logger.log(
        `[parse_edit_or_confirm] isConfirmation=${result.isConfirmation}, edits=${result.edits.length}`,
      );

      // If it's a confirmation, prepare for write
      if (result.isConfirmation) {
        return {
          workflowMode: WorkflowMode.IDLE, // Will trigger write_batch
          metadata: {
            ...state.metadata,
            llmCalls: (state.metadata.llmCalls || 0) + 1,
            lastStage: 'parse_edit_or_confirm',
          },
        };
      }

      // Apply edits to specific items ONLY
      let updatedBatch = [...state.pendingBatch];

      for (const edit of result.edits) {
        const itemIndex = edit.itemNumber - 1; // Convert to 0-indexed

        if (itemIndex < 0 || itemIndex >= updatedBatch.length) {
          this.logger.warn(
            `[parse_edit_or_confirm] invalid item number: ${edit.itemNumber}`,
          );
          continue;
        }

        // CRITICAL: Modify ONLY the referenced item
        const item = updatedBatch[itemIndex];

        if (edit.field === 'amount') {
          item.amount = edit.newValue as number;
        } else if (edit.field === 'description') {
          item.description = edit.newValue as string;
        } else if (edit.field === 'mode') {
          item.mode = edit.newValue as any;
        } else if (edit.field === 'category') {
          item.suggestedCategory = edit.newValue as any;
        }

        updatedBatch[itemIndex] = item;
      }

      this.logger.log(
        `[parse_edit_or_confirm] applied ${result.edits.length} edit(s)`,
      );

      // Re-present the revised batch
      return {
        pendingBatch: updatedBatch,
        workflowMode: WorkflowMode.PENDING_CONFIRMATION,
        metadata: {
          ...state.metadata,
          llmCalls: (state.metadata.llmCalls || 0) + 1,
          lastStage: 'parse_edit_or_confirm',
        },
      };
    } catch (error) {
      this.logger.error(`[parse_edit_or_confirm] failed: ${error}`);
      return {
        error: `Failed to parse edit or confirmation: ${error}`,
        workflowMode: WorkflowMode.ERROR,
        metadata: {
          ...state.metadata,
          errorStage: 'parse_edit_or_confirm',
        },
      };
    }
  }

  /**
   * STAGE 5: Write Batch
   * 
   * Executes deterministic workbook writes for the confirmed batch.
   * Uses Phase 2 log_transaction_batch tool for atomic writes.
   * 
   * CRITICAL:
   * - Only called AFTER explicit confirmation
   * - Downloads workbook ONCE, applies ALL transactions, uploads ONCE
   * - Reports success ONLY after S3 upload succeeds
   * - Clears pending batch only on success
   * - RETRY SAFE: No partial S3 writes, no duplicate transactions
   */
  private async writeBatch(
    state: ExpenseWorkflowStateType,
  ): Promise<Partial<ExpenseWorkflowStateType>> {
    this.logger.log(`[write_batch] DEBUG START - thread=${state.threadId}`);
    this.logger.log(`[write_batch] DEBUG - pendingBatch exists: ${!!state.pendingBatch}`);
    this.logger.log(`[write_batch] DEBUG - pendingBatch length: ${state.pendingBatch?.length || 0}`);
    
    if (state.pendingBatch && state.pendingBatch.length > 0) {
      this.logger.log(`[write_batch] DEBUG - pendingBatch contents: ${JSON.stringify(state.pendingBatch.map(tx => ({
        date: tx.date,
        description: tx.description,
        amount: tx.amount,
        direction: tx.direction
      })))}`);
    }

    if (!state.pendingBatch || state.pendingBatch.length === 0) {
      this.logger.error(`[write_batch] ERROR - No pending batch to write`);
      return {
        error: 'No pending batch to write',
        workflowMode: WorkflowMode.ERROR,
        lastResponse: 'No pending transactions to confirm.',
      };
    }

    this.logger.log(
      `[write_batch] attempting ATOMIC batch write: ${state.pendingBatch.length} transaction(s)`,
    );

    try {
      // Convert pendingBatch to LogTransactionInput format
      const transactions = state.pendingBatch.map((tx) => ({
        date: tx.date,
        description: tx.description,
        tag: tx.tag,
        mode: tx.mode,
        amount: tx.amount,
        direction: tx.direction,
        colourCategory: tx.suggestedCategory as any,
      }));
      
      this.logger.log(`[write_batch] DEBUG - calling logTransactionBatchTool.execute with ${transactions.length} transactions`);

      // ATOMIC WRITE: Download once, mutate all, upload once
      const batchResult = await this.logTransactionBatchTool.execute({
        transactions,
      });
      
      this.logger.log(`[write_batch] DEBUG - batchResult: success=${batchResult.success}, error=${batchResult.error}, results=${batchResult.results?.length || 0}`);

      if (batchResult.success) {
        // SUCCESS: All transactions written to S3 atomically
        this.logger.log(
          `[write_batch] SUCCESS: ${state.pendingBatch.length} transaction(s) persisted atomically`,
        );

        const resultsSummary = batchResult.results
          .map(
            (r, idx) =>
              `✓ Item ${idx + 1}: ${state.pendingBatch![idx].description} - ₹${state.pendingBatch![idx].amount} (Balance: ₹${r.newBalance})`,
          )
          .join('\n');

        const response = `Transaction${state.pendingBatch.length > 1 ? 's' : ''} saved successfully!\n\n${resultsSummary}`;

        // CRITICAL: Clear pending batch ONLY after successful S3 upload
        return {
          pendingBatch: null,
          workflowMode: WorkflowMode.IDLE,
          lastResponse: response,
          metadata: {
            ...state.metadata,
            toolCalls:
              (state.metadata.toolCalls || 0) + state.pendingBatch.length,
            lastStage: 'write_batch',
            completedAt: new Date(),
            processedRequests: [
              ...(state.metadata.processedRequests || []),
              state.requestId,
            ],
          },
        };
      } else {
        // FAILURE: S3 upload failed or validation failed
        // CRITICAL: Do NOT clear pending batch - preserved for retry
        this.logger.error(
          `[write_batch] FAILED: ${batchResult.error || 'Unknown error'}`,
        );

        const response = `Failed to save transaction(s): ${batchResult.error}\n\nPending batch retained. Please retry when the issue is resolved.`;

        return {
          error: batchResult.error || 'Batch write failed',
          lastResponse: response,
          workflowMode: WorkflowMode.ERROR,
          // pendingBatch NOT cleared
          metadata: {
            ...state.metadata,
            errorStage: 'write_batch',
          },
        };
      }
    } catch (error) {
      this.logger.error(`[write_batch] EXCEPTION CAUGHT: ${error instanceof Error ? error.name : typeof error}`);
      this.logger.error(`[write_batch] EXCEPTION MESSAGE: ${error instanceof Error ? error.message : String(error)}`);
      this.logger.error(`[write_batch] EXCEPTION STACK: ${error instanceof Error ? error.stack : 'N/A'}`);
      
      return {
        error: `Failed to write batch: ${error instanceof Error ? error.message : String(error)}`,
        lastResponse: `An error occurred while saving transactions: ${error instanceof Error ? error.message : String(error)}\n\nPending batch retained. Please retry.`,
        workflowMode: WorkflowMode.ERROR,
        // pendingBatch NOT cleared
        metadata: {
          ...state.metadata,
          errorStage: 'write_batch',
        },
      };
    }
  }

  /**
   * STAGE 6: Answer Query
   * 
   * Handles analytical questions using Phase 2 deterministic tools.
   * LLM performs semantic interpretation and shortlisting.
   * Deterministic tool performs arithmetic.
   */
  private async answerQuery(
    state: ExpenseWorkflowStateType,
  ): Promise<Partial<ExpenseWorkflowStateType>> {
    this.logger.log(`[answer_query] thread=${state.threadId}`);

    try {
      // Interpret query using Phase 3 service
      const interpretation = await this.queryInterpreter.interpret(
        state.message,
      );

      this.logger.log(
        `[answer_query] aggregation=${interpretation.aggregationType}, chart=${interpretation.chartRequested}`,
      );

      // Execute query using Phase 2 deterministic tool
      const queryResult = await this.queryTransactionsTool.execute({
        filters: {
          sheets: interpretation.filters.sheets,
          modes: interpretation.filters.modes,
          categories: interpretation.filters.categories,
          dateFrom: interpretation.filters.dateFrom,
          dateTo: interpretation.filters.dateTo,
          tags: interpretation.filters.tags,
          descriptionContains: interpretation.filters.descriptionContains,
        },
        aggregation: interpretation.aggregationType
          ? {
              type: interpretation.aggregationType,
              field: interpretation.aggregationField || 'amount',
            }
          : undefined,
      });

      let response = '';
      let chartImage: string | null = null;

      // Format response based on query type
      if (interpretation.aggregationType && queryResult.aggregation) {
        const agg = queryResult.aggregation;
        if (agg.sum !== undefined) {
          response = `The ${interpretation.aggregationType.toLowerCase()} is ₹${agg.sum.toLocaleString()}.`;
        } else if (agg.average !== undefined) {
          response = `The ${interpretation.aggregationType.toLowerCase()} is ₹${agg.average.toLocaleString()}.`;
        } else {
          response = `Found ${agg.count} transaction(s).`;
        }
      } else {
        const count = queryResult.transactions?.length || 0;
        response = `Found ${count} transaction(s).`;
      }

      // Generate chart if requested
      if (interpretation.chartRequested && queryResult.transactions) {
        this.logger.log('[answer_query] generating chart');

        // Prepare chart data from transactions
        // For simplicity, we'll create a basic chart with transaction counts by mode
        const modeCounts = new Map<string, number>();
        for (const tx of queryResult.transactions) {
          const mode = tx.mode || 'Unknown';
          modeCounts.set(mode, (modeCounts.get(mode) || 0) + 1);
        }

        const chartResult = await this.generateChartTool.execute({
          chartType: interpretation.chartType || 'bar',
          data: {
            labels: Array.from(modeCounts.keys()),
            datasets: [
              {
                label: 'Transaction Count',
                data: Array.from(modeCounts.values()),
              },
            ],
          },
          title: state.message,
        });

        if (chartResult.imageBuffer) {
          chartImage = chartResult.imageBuffer.toString('base64');
          response += '\n\n[Chart generated]';
        }
      }

      this.logger.log('[answer_query] query completed successfully');

      return {
        lastResponse: response,
        chartImage,
        workflowMode: WorkflowMode.IDLE,
        metadata: {
          ...state.metadata,
          llmCalls: (state.metadata.llmCalls || 0) + 1,
          toolCalls: (state.metadata.toolCalls || 0) + 1,
          lastStage: 'answer_query',
          completedAt: new Date(),
        },
      };
    } catch (error) {
      this.logger.error(`[answer_query] failed: ${error}`);
      return {
        error: `Failed to answer query: ${error}`,
        workflowMode: WorkflowMode.ERROR,
        metadata: {
          ...state.metadata,
          errorStage: 'answer_query',
        },
      };
    }
  }
}
