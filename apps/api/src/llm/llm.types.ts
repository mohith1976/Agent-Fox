/**
 * LLM Types and Structured Schemas
 * Defines the contract between the LLM and deterministic tools
 */

import type { LlmUsage } from './azure-ai.service';

/**
 * Wraps any LLM result with the real token usage of the call that
 * produced it, so graph nodes can meter per-request LLM cost.
 * (azure-ai.service does NOT import this file — no import cycle.)
 */
export type WithUsage<T> = T & { usage: LlmUsage };

// Intent Classification
export type IntentType = 'NEW_TRANSACTION_BATCH' | 'ANALYTICAL_QUERY' | 'EDIT_OR_CONFIRM' | 'UNKNOWN';

export interface IntentClassificationResult {
  intent: IntentType;
  confidence: number;
  reasoning?: string;
  /** Segmented sub-requests for combinational turns (absent = single). */
  subRequests?: Array<{ text: string; intent: string }>;
}

// Transaction Extraction
export type PaymentMode = 'PHONEPAY' | 'WALLET' | 'MONEY' | 'BANK';
export type TransactionDirection = 'DEBIT' | 'CREDIT';
export type ColourCategory =
  | 'AVOID_EXPENSE'
  | 'PAY_HOME_CASH'
  | 'PERSONAL_EXPENSE'
  | 'HOME_EXPENSE'
  | 'WISHLIST_EXPENSE'
  | null;

export interface ExtractedTransaction {
  date: string; // ISO date format YYYY-MM-DD
  description: string;
  tag: string | null;
  mode: PaymentMode;
  amount: number;
  direction: TransactionDirection;
  suggestedCategory: ColourCategory;
}

export interface TransactionExtractionResult {
  transactions: ExtractedTransaction[];
  ambiguities?: string[];
  needsClarification: boolean;
}

// Category Inference
export interface CategoryInferenceInput {
  description: string;
  direction: TransactionDirection;
  wishlistTerms: {
    forHome: string[];
    personal: string[];
    wishlist: string[];
  };
}

export interface CategoryInferenceResult {
  category: ColourCategory;
  reasoning: string;
  wishlistMatch: boolean;
}

// Edit Instruction Parsing
export interface EditInstruction {
  itemNumber: number;
  field: 'description' | 'amount' | 'mode' | 'category' | 'tag';
  newValue: string | number | ColourCategory;
}

export interface EditParseResult {
  isConfirmation: boolean;
  edits: EditInstruction[];
  needsClarification: boolean;
  clarificationMessage?: string;
}

// Query Interpretation
export interface QueryFilter {
  sheets?: string[];
  modes?: PaymentMode[];
  categories?: ColourCategory[];
  dateFrom?: string;
  dateTo?: string;
  descriptionContains?: string;
  tags?: string[];
  amountMin?: number;
  amountMax?: number;
  /** Max rows newest-first ("latest transaction" → 1). */
  limit?: number | null;
}

export interface QueryInterpretationResult {
  filters: QueryFilter;
  aggregationType?: 'SUM' | 'COUNT' | 'AVERAGE';
  aggregationField?: 'debit' | 'credit' | 'amount';
  chartRequested: boolean;
  chartType?: 'bar' | 'line' | 'pie';
  /** Newest-first row cap for "latest/most recent" queries. */
  limit?: number | null;
  /**
   * True for "balance / how much is there / current X balance" questions.
   * The tool then returns authoritative sheet balances (never recomputed).
   */
  wantsBalances: boolean;
  reasoning: string;
}

// Validation Results
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// Azure AI Configuration
export interface AzureAIConfig {
  endpoint: string;
  apiKey: string;
  deployment: string;
}

// Answer Generation
export interface AnswerResult {
  /** The human-readable answer to the user's query */
  text: string;
  /** Whether the answer contains computed numbers / aggregations */
  hasNumbers: boolean;
  /** Brief reasoning for the answer (for validate_answer logic) */
  reasoning: string;
}
