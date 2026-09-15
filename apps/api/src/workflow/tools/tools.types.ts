import {
  CategoryColor,
  PaymentMode,
  TransactionDirection,
  TransactionRow,
} from '../excel/excel.types';

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
