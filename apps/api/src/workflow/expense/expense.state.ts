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
 * Single chat turn persisted in checkpoint state.
 * Accumulates across invokes on the same threadId so refresh recovery
 * (GET /api/chat/state/:threadId) restores the visible transcript, not just
 * the pending batch. NEVER financial data beyond what was shown to the user.
 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** ISO timestamp */
  timestamp: string;
  /**
   * Pending-batch snapshot for confirmation turns. Restores the interactive
   * review card on refresh — without this, a reloaded page shows only the
   * confirm text with no Confirm/Cancel buttons.
   */
  pendingBatch?: PendingTransaction[] | null;
}

/**
 * Workflow execution mode
 */
export enum WorkflowMode {
  /** No pending batch, ready for new input */
  IDLE = 'IDLE',
  
  /** Processing transaction batch */
  PROCESSING = 'PROCESSING',
  
  /** New transaction batch parsed, awaiting confirmation/edit */
  PENDING_CONFIRMATION = 'PENDING_CONFIRMATION',
  
  /** Awaiting clarification from user */
  AWAITING_CLARIFICATION = 'AWAITING_CLARIFICATION',
  
  /** Awaiting user clarification for unknown intent */
  AWAITING_USER_CLARIFICATION = 'AWAITING_USER_CLARIFICATION',
  
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
  UNKNOWN = 'UNKNOWN',
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
   * Chat transcript for this thread (user + assistant turns).
   * Appended by entry nodes (user) and terminal/waiting nodes (assistant).
   * Reducer concatenates so resume invokes preserve history.
   */
  messages: Annotation<ChatMessage[]>({
    reducer: (prev, value) => [...(prev || []), ...(value || [])],
    default: () => [],
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

    /** Total LLM tokens consumed in this execution (metering, not estimates) */
    tokens?: number;
    
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

  // ========================================
  // TRANSACTION WORKFLOW FIELDS
  // ========================================

  /** Raw transactions extracted from user message */
  rawTransactions: Annotation<any[]>({
    reducer: (_, value) => value,
    default: () => [],
  }),

  /** Validated transactions ready for presentation */
  validatedTransactions: Annotation<any[]>({
    reducer: (_, value) => value,
    default: () => [],
  }),

  /** Transaction validation status */
  validationStatus: Annotation<'COMPLETE' | 'MISSING_INFO' | null>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /** Missing fields that need clarification */
  missingFields: Annotation<string[]>({
    reducer: (_, value) => value,
    default: () => [],
  }),

  /** Number of clarification attempts made */
  clarificationAttempts: Annotation<number>({
    reducer: (_, value) => value,
    default: () => 0,
  }),

  /** Consecutive UNKNOWN-intent turns (bounded loop guard for gibberish). */
  unknownAttempts: Annotation<number>({
    reducer: (_, value) => value,
    default: () => 0,
  }),

  /**
   * Total clarification merges this cycle (absolute backstop). Reset on fresh
   * extraction and on cancel; the junk-only counter is clarificationAttempts.
   */
  clarificationRounds: Annotation<number>({
    reducer: (_, value) => value,
    default: () => 0,
  }),

  /** Pending clarification context */
  pendingClarificationContext: Annotation<any>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /** Clarification data from user response */
  clarificationData: Annotation<any>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /** Extraction confidence from LLM */
  extractionConfidence: Annotation<number>({
    reducer: (_, value) => value,
    default: () => 0,
  }),

  /** Ambiguity notes reported by the extractor (needsClarification flag).
   * Carried from parse_transactions to validate_transaction_data so vague
   * input is clarified instead of silently guessed. */
  extractionAmbiguities: Annotation<string[]>({
    reducer: (_, value) => value,
    default: () => [],
  }),

  /** Classification confidence from intent classifier */
  classificationConfidence: Annotation<number>({
    reducer: (_, value) => value,
    default: () => 0,
  }),

  /** Confirmation action: CONFIRM, EDIT, or CANCEL */
  confirmAction: Annotation<'CONFIRM' | 'EDIT' | 'CANCEL' | null>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /** Edits to apply to pending batch */
  edits: Annotation<any[]>({
    reducer: (_, value) => value,
    default: () => [],
  }),

  /** Write status */
  status: Annotation<'success' | 'failed' | 'stopped' | null>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  // ========================================
  // QUERY WORKFLOW FIELDS
  // ========================================

  /** Query intent type */
  queryIntent: Annotation<string | null>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /** Query filters */
  filters: Annotation<any>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /** Deterministic aggregation requested for the query (SUM/COUNT/AVERAGE).
   * Forwarded to the query_transactions tool so math happens in
   * deterministic code, never in the LLM. */
  aggregation: Annotation<{ type: 'SUM' | 'COUNT' | 'AVERAGE'; field: string } | null>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /** Time range for query */
  timeRange: Annotation<any>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /** Retrieved transactions from query */
  retrievedTransactions: Annotation<any[]>({
    reducer: (_, value) => value,
    default: () => [],
  }),

  /** Number of transactions retrieved */
  retrievalCount: Annotation<number>({
    reducer: (_, value) => value,
    default: () => 0,
  }),

  /** Authoritative sheet balances (present only for balance questions). */
  retrievedBalances: Annotation<any>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /** Whether this query wants authoritative sheet balances. */
  balanceRequested: Annotation<boolean>({
    reducer: (_, value) => value,
    default: () => false,
  }),

  /** Whether the user asked for a chart (forwarded to build_chart). */
  chartRequested: Annotation<boolean>({
    reducer: (_, value) => value,
    default: () => false,
  }),

  /** Whether the answer must enumerate individual rows (descriptions), not
   * just totals. Set by the interpreter when the query asks to see/list/
   * describe transactions; implied by the DETAIL_LIST follow-up path. */
  detailsRequested: Annotation<boolean>({
    reducer: (_, value) => value,
    default: () => false,
  }),

  /** Segmented sub-requests for combinational turns
   * ([{text, intent}]), set by classify_intent. Single-request turns hold
   * exactly one element. Consumed by routing; persisted for debugging. */
  subRequests: Annotation<Array<{ text: string; intent: string }> | null>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /** Analytical sub-request texts deferred past transaction completion.
   * Set by start_combination on mixed turns; answered (fresh reads) after
   * the batch writes; cleared on cancel/STOP. Empty when nothing pends. */
  pendingSubs: Annotation<Array<{ text: string; intent: string }>>({
    reducer: (_, value) => value,
    default: () => [],
  }),

  /** Zero-hit broaden offer outstanding: the previous turn answered "none in
   * that scope — broaden?" and awaits the user's word. A bare affirmation
   * ("yes") consumes it (previous scope re-run dateless); any real query,
   * transaction, cancel or STOP clears it. Never persists across scopes. */
  broadenOffered: Annotation<boolean>({
    reducer: (_, value) => value,
    default: () => false,
  }),

  /** Requested chart type. */
  chartType: Annotation<string | null>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /** Query result validation status */
  queryResultStatus: Annotation<'SUFFICIENT' | 'INSUFFICIENT' | null>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /** Query result type */
  queryResultType: Annotation<string | null>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /** Insufficiency reason for query results */
  insufficiencyReason: Annotation<string | null>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /** Number of query transformation attempts */
  transformationAttempt: Annotation<number>({
    reducer: (_, value) => value,
    default: () => 0,
  }),

  /** Human-readable note when retrieval broadened the original filters
   * (e.g. color-category dropped after zero hits). Passed to the answer
   * generator so the reply discloses what was actually totaled. */
  queryNote: Annotation<string | null>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /** Generated answer text */
  generatedAnswer: Annotation<string | null>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /** Whether answer includes aggregation */
  includesAggregation: Annotation<boolean>({
    reducer: (_, value) => value,
    default: () => false,
  }),

  /** Answer validation status */
  answerStatus: Annotation<'SATISFACTORY' | 'UNSATISFACTORY' | null>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /** Feedback for answer regeneration */
  answerFeedback: Annotation<string | null>({
    reducer: (_, value) => value,
    default: () => null,
  }),

  /** Number of answer regeneration attempts */
  regenerationAttempt: Annotation<number>({
    reducer: (_, value) => value,
    default: () => 0,
  }),

  // ========================================
  // INFRASTRUCTURE FIELDS
  // ========================================

  /** User ID for file operations */
  userId: Annotation<string>({
    reducer: (_, value) => value,
    default: () => '',
  }),

  /** Flow tracking ID for monitoring */
  flowTrackingId: Annotation<string | null>({
    reducer: (_, value) => value,
    default: () => null,
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
    userId: '',
    pendingBatch: null,
    workflowMode: WorkflowMode.IDLE,
    intent: null,
    messages: [],
    lastResponse: '',
    chartData: null,
    chartImage: null,
    error: null,
    metadata: {
      startedAt: new Date(),
      llmCalls: 0,
      toolCalls: 0,
      tokens: 0,
      processedRequests: [],
    },
    // Transaction workflow fields
    rawTransactions: [],
    validatedTransactions: [],
    validationStatus: null,
    missingFields: [],
    clarificationAttempts: 0,
    unknownAttempts: 0,
    clarificationRounds: 0,
    pendingClarificationContext: null,
    clarificationData: null,
    extractionConfidence: 0,
    extractionAmbiguities: [],
    classificationConfidence: 0,
    confirmAction: null,
    edits: [],
    status: null,
    // Query workflow fields
    queryIntent: null,
    filters: null,
    aggregation: null,
    timeRange: null,
    retrievedTransactions: [],
    retrievalCount: 0,
    retrievedBalances: null,
    balanceRequested: false,
    chartRequested: false,
    chartType: null,
    detailsRequested: false,
    subRequests: null,
    pendingSubs: [],
    broadenOffered: false,
    queryResultStatus: null,
    queryResultType: null,
    insufficiencyReason: null,
    transformationAttempt: 0,
    queryNote: null,
    generatedAnswer: null,
    includesAggregation: false,
    answerStatus: null,
    answerFeedback: null,
    regenerationAttempt: 0,
    // Infrastructure fields
    flowTrackingId: null,
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
