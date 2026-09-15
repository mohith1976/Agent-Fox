/**
 * Expense Workflow State Schema
 * 
 * Defines the typed state that persists across LangGraph workflow execution.
 * This state survives between separate chat requests via checkpointing.
 * 
 * CRITICAL: This is NOT the financial ledger. Budget_2026.xlsx remains
 * the authoritative financial source of truth.
 */

import { Annotation } from '@langchain/langgraph';

/**
 * Transaction candidate in a pending batch
 * Structured but NOT yet written to the workbook
 */
export interface PendingTransaction {
  /** Sequential item number in the batch (1-indexed for user display) */
  itemNumber: number;
  
  /** Transaction date (ISO format: YYYY-MM-DD) */
  date: string;
  
  /** Description/payee/merchant */
  description: string;
  
  /** Optional tag extracted from [TAG] format */
  tag: string | null;
  
  /** Payment mode: PHONEPAY, WALLET, MONEY, or BANK */
  mode: 'PHONEPAY' | 'WALLET' | 'MONEY' | 'BANK';
  
  /** Transaction amount (positive number) */
  amount: number;
  
  /** Direction: DEBIT (expense) or CREDIT (income) */
  direction: 'DEBIT' | 'CREDIT';
  
  /** 
   * Suggested category from LLM inference
   * CRITICAL: null for CREDIT transactions (enforced by Phase 3)
   */
  suggestedCategory: 
    | 'AVOID_EXPENSE' 
    | 'PAY_HOME_CASH' 
    | 'PERSONAL_EXPENSE' 
    | 'HOME_EXPENSE' 
    | 'WISHLIST_EXPENSE' 
    | null;
}

/**
 * Workflow execution mode
 */
export enum WorkflowMode {
  /** No pending batch, ready for new input */
  IDLE = 'IDLE',
  
  /** New transaction batch parsed, awaiting confirmation/edit */
  PENDING_CONFIRMATION = 'PENDING_CONFIRMATION',
  
  /** Analytical query in progress */
  QUERY = 'QUERY',
  
  /** Error state requiring user intervention */
  ERROR = 'ERROR',
}

/**
 * Intent classification result
 */
export enum IntentType {
  NEW_TRANSACTION_BATCH = 'NEW_TRANSACTION_BATCH',
  ANALYTICAL_QUERY = 'ANALYTICAL_QUERY',
  EDIT_OR_CONFIRM = 'EDIT_OR_CONFIRM',
}

/**
 * Chart data for visualization
 */
export interface ChartData {
  type: 'bar' | 'line' | 'pie';
  title: string;
  labels: string[];
  datasets: {
    label: string;
    data: number[];
  }[];
}

/**
 * Expense Workflow State
 * 
 * Per design document:
 * - requestId: unique identifier for each user message (idempotency)
 * - threadId: conversation/session identifier
 * - message: current raw user input
 * - pendingBatch: transactions awaiting confirmation
 * - workflowMode: current workflow state
 * - lastResponse: most recent agent response text
 * - metadata: execution tracking information
 */
export const ExpenseWorkflowState = Annotation.Root({
  /**
   * Unique identifier for this specific request/message
   * Used for idempotency - prevents duplicate financial writes on retry
   */
  requestId: Annotation<string>({
    reducer: (_, value) => value,
    default: () => '',
  }),

  /**
   * Thread/conversation identifier
   * Groups related messages in a conversation session
   */
  threadId: Annotation<string>({
    reducer: (_, value) => value,
    default: () => '',
  }),

  /**
   * Raw user message text
   */
  message: Annotation<string>({
    reducer: (_, value) => value,
    default: () => '',
  }),

  /**
   * Pending transaction batch awaiting confirmation
   * null when no pending batch exists
   * 
   * CRITICAL: These are candidates only. NOT written to workbook until confirmed.
   */
  pendingBatch: Annotation<PendingTransaction[] | null>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /**
   * Current workflow execution mode
   */
  workflowMode: Annotation<WorkflowMode>({
    reducer: (_, value) => value,
    default: () => WorkflowMode.IDLE,
  }),

  /**
   * Classified intent for current message
   */
  intent: Annotation<IntentType | null>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /**
   * Most recent agent response text
   * Used for conversational context and display
   */
  lastResponse: Annotation<string>({
    reducer: (_, value) => value,
    default: () => '',
  }),

  /**
   * Optional chart data for visualization
   */
  chartData: Annotation<ChartData | null>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /**
   * Optional chart image buffer (base64 encoded)
   */
  chartImage: Annotation<string | null>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /**
   * Error message if workflow encountered a failure
   */
  error: Annotation<string | null>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /**
   * Execution metadata for tracking and observability
   */
  metadata: Annotation<{
    /** Timestamp when workflow execution started */
    startedAt?: Date;
    
    /** Timestamp when workflow execution completed */
    completedAt?: Date;
    
    /** Number of LLM calls made in this execution */
    llmCalls?: number;
    
    /** Number of tool executions in this execution */
    toolCalls?: number;
    
    /** Stage where error occurred (if any) */
    errorStage?: string;
    
    /** Last successful stage completed */
    lastStage?: string;
    
    /** Request IDs processed in this thread (for idempotency tracking) */
    processedRequests?: string[];
  }>({
    reducer: (prev, value) => ({ ...prev, ...value }),
    default: () => ({}),
  }),
});

/**
 * Type inference for ExpenseWorkflowState
 */
export type ExpenseWorkflowStateType = typeof ExpenseWorkflowState.State;

/**
 * Helper to create initial state
 */
export function createInitialState(
  requestId: string,
  threadId: string,
  message: string,
): ExpenseWorkflowStateType {
  return {
    requestId,
    threadId,
    message,
    pendingBatch: null,
    workflowMode: WorkflowMode.IDLE,
    intent: null,
    lastResponse: '',
    chartData: null,
    chartImage: null,
    error: null,
    metadata: {
      startedAt: new Date(),
      llmCalls: 0,
      toolCalls: 0,
      processedRequests: [],
    },
  };
}

/**
 * Helper to format pending batch for display
 * Returns numbered list suitable for user review
 */
export function formatPendingBatch(batch: PendingTransaction[]): string {
  if (!batch || batch.length === 0) {
    return '';
  }

  const lines = batch.map((tx) => {
    const category = tx.suggestedCategory
      ? ` — ${formatCategoryDisplay(tx.suggestedCategory)}`
      : '';
    const tag = tx.tag ? ` [${tx.tag}]` : '';
    const rupeeSymbol = '₹';
    
    return `${tx.itemNumber}. ${tx.description}${tag} — ${rupeeSymbol}${tx.amount.toLocaleString()} — ${formatModeDisplay(tx.mode)}${category}`;
  });

  return lines.join('\n');
}

/**
 * Format mode for display
 */
function formatModeDisplay(mode: string): string {
  const displayMap: Record<string, string> = {
    PHONEPAY: 'PhonePay',
    WALLET: 'Wallet',
    MONEY: 'Money',
    BANK: 'Bank',
  };
  return displayMap[mode] || mode;
}

/**
 * Format category for display
 */
function formatCategoryDisplay(category: string): string {
  const displayMap: Record<string, string> = {
    AVOID_EXPENSE: 'Avoid Expense',
    PAY_HOME_CASH: "Pay in Home's Cash",
    PERSONAL_EXPENSE: 'Personal Expense',
    HOME_EXPENSE: 'For Home Expense',
    WISHLIST_EXPENSE: 'Wishlist Expense',
  };
  return displayMap[category] || category;
}
