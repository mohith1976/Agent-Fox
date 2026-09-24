import {
  CategoryColor,
  PaymentMode,
  SheetBalances,
  TransactionDirection,
  TransactionRow,
} from '../workflow/excel/excel.types';

/**
 * Tool Definition from database (tool_definitions table)
 */
export interface ToolDefinition {
  pid: string;
  toolCode: string;
  description: string | null; // Allow null from database
  name: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Input for log_transaction tool
 */
export interface LogTransactionInput {
  date: string; // ISO date string
  description: string;
  tag: string | null;
  mode: PaymentMode;
  amount: number; // Always positive
  direction: TransactionDirection;
  colourCategory: CategoryColor;
}

/**
 * Output from log_transaction tool
 */
export interface LogTransactionOutput {
  success: boolean;
  newBalance: number;
  insertedRow: number;
  sheet: string;
  error?: string;
}

/**
 * Input for query_transactions tool
 */
export interface QueryTransactionsInput {
  filters?: {
    sheets?: string[];
    modes?: PaymentMode[];
    categories?: CategoryColor[];
    dateFrom?: string;
    dateTo?: string;
    tags?: string[];
    descriptionContains?: string;
  };
  aggregation?: {
    type: 'SUM' | 'COUNT' | 'AVERAGE';
    field: 'debit' | 'credit' | 'amount'; // 'amount' = debit OR credit
  };
  /**
   * When true, also read current sheet balances (last-row running balances).
   * Used for "balance / how much is there" questions — the sheet values are
   * authoritative and must NOT be recomputed from transactions.
   */
  includeBalances?: boolean;
  /**
   * Set by the workflow when the user EXPLICITLY named a single month.
   * Balance reads then answer from that month's own closings (see
   * getMonthClosingBalances), never the current month. Default-scoped and
   * broadened turns leave it unset (global current balances).
   */
  monthExplicit?: boolean;
}

/**
 * Output from query_transactions tool
 */
export interface QueryTransactionsOutput {
  transactions: TransactionRow[];
  aggregation?: {
    sum?: number;
    count: number;
    average?: number;
  };
  /** Present only when includeBalances was requested. */
  balances?: SheetBalances | null;
}

/**
 * Input for generate_chart tool
 */
export interface GenerateChartInput {
  chartType: 'bar' | 'line' | 'pie' | 'doughnut';
  data: {
    labels: string[];
    datasets: {
      label: string;
      data: number[];
      backgroundColor?: string[];
      borderColor?: string;
    }[];
  };
  title: string;
  width?: number; // Default: 800
  height?: number; // Default: 600
}

/**
 * Output from generate_chart tool
 */
export interface GenerateChartOutput {
  imageBuffer: Buffer;
  mimeType: string; // 'image/png'
  width: number;
  height: number;
}

/**
 * Input for read_terminology tool.
 * No filters needed — the tool always returns all three user-defined lists
 * (the caller selects which to present).
 */
export interface ReadTerminologyInput {
  s3KeyOverride?: string;
}

/**
 * Output from read_terminology tool.
 * The user's own words from the TERMINOLOGY sheet (rows 15-17, cols H-J):
 * the rulebook for category coloring. Served verbatim for list questions.
 */
export interface ReadTerminologyOutput {
  forHome: string[];
  personal: string[];
  wishlist: string[];
}
