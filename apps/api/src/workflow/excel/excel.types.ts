/**
 * Workbook color constants - exact ARGB values from Budget_2026.xlsx
 */
export const WORKBOOK_COLORS = {
  AVOID_EXPENSE: 'FFFF0000', // Red
  PAY_HOME_CASH: 'FFFFFF00', // Yellow
  PERSONAL_EXPENSE: 'FF70AD47', // Green
  HOME_EXPENSE: 'FFEE7ADD', // Pink
  WISHLIST_EXPENSE: 'FFC00000', // Maroon/Dark Red
  OPENING_BALANCE: 'FF5B9BD5', // Light Blue
  CLOSING_BALANCE: 'FF4472C4', // Dark Blue
  BASE_FILL: 'FFEEF3FB', // Light base row fill (used in CASH TRACKER)
} as const;

/**
 * Payment modes supported by the workbook
 */
export type PaymentMode = 'PHONEPAY' | 'PHONE PAY' | 'WALLET' | 'MONEY' | 'BANK';

/**
 * Transaction direction
 */
export type TransactionDirection = 'DEBIT' | 'CREDIT';

/**
 * Category color types (maps to workbook color fills)
 */
export type CategoryColor =
  | 'AVOID_EXPENSE'
  | 'PAY_HOME_CASH'
  | 'PERSONAL_EXPENSE'
  | 'HOME_EXPENSE'
  | 'WISHLIST_EXPENSE'
  | null;

/**
 * Input for creating a new transaction
 */
export interface NewTransactionInput {
  date: string; // ISO date string or Date
  description: string;
  tag: string | null;
  mode: PaymentMode;
  amount: number; // Always positive
  direction: TransactionDirection;
  colourCategory: CategoryColor;
}

/**
 * Transaction row read from workbook
 */
export interface TransactionRow {
  sheet: string;
  row: number;
  date: Date;
  description: string;
  mode: PaymentMode;
  debit: number | null;
  credit: number | null;
  balance: number;
  colourCategory: CategoryColor;
  tag: string | null;
}

/**
 * Wishlist data from TERMINOLOGY sheet
 */
export interface WishlistData {
  forHome: string[];
  personal: string[];
  wishlist: string[];
}

/**
 * TERMINOLOGY sheet configuration
 */
export interface TerminologyData {
  wishlist: WishlistData;
}

/**
 * Transaction filters for queries
 */
export interface TransactionFilters {
  /**
   * Month sheets to read (plus CASH TRACKER where relevant). Explicit null =
   * consent-broadened all-time read (every month sheet); undefined/empty =
   * interpreter default (current month + CASH TRACKER).
   */
  sheets?: string[] | null;
  modes?: PaymentMode[];
  categories?: CategoryColor[];
  dateFrom?: string;
  dateTo?: string;
  tags?: string[];
  descriptionContains?: string;
  /**
   * Max rows to return, newest-first by date ("latest transaction" → 1).
   * Applied AFTER all other filters.
   */
  limit?: number | null;
}

/**
 * Current balances read from the workbook itself (last-row running balances
 * per mode). This is the AUTHORITATIVE answer for "balance" questions —
 * never recompute balances by summing transactions.
 * Null when the mode column has no recorded balance.
 */
export interface SheetBalances {
  PHONEPAY: number | null;
  WALLET: number | null;
  MONEY: number | null;
  BANK: number | null;
}

/**
 * Result of a write transaction operation
 */
export interface WriteTransactionResult {
  success: boolean;
  newBalance: number;
  insertedRow: number;
  sheet: string;
  error?: string;
}

/**
 * Result of a query operation
 */
export interface QueryResult {
  transactions: TransactionRow[];
  aggregation?: {
    sum?: number;
    count: number;
    average?: number;
  };
}

/**
 * Aggregation request
 */
export interface AggregationRequest {
  type: 'SUM' | 'COUNT' | 'AVERAGE';
  field: 'debit' | 'credit' | 'amount'; // 'amount' = debit OR credit (whichever is populated)
}

/**
 * Workbook validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Sheet and balance column routing information
 */
export interface SheetRouting {
  sheetName: string;
  balanceColumn: string; // Column letter (H or I)
}
