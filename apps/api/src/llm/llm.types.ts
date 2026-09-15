/**
 * LLM Types and Structured Schemas
 * Defines the contract between the LLM and deterministic tools
 */

// Intent Classification
export type IntentType = 'NEW_TRANSACTION_BATCH' | 'ANALYTICAL_QUERY' | 'EDIT_OR_CONFIRM' | 'UNKNOWN';

export interface IntentClassificationResult {
  intent: IntentType;
  confidence: number;
  reasoning?: string;
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
}

export interface QueryInterpretationResult {
  filters: QueryFilter;
  aggregationType?: 'SUM' | 'COUNT' | 'AVERAGE';
  aggregationField?: 'debit' | 'credit' | 'amount';
  chartRequested: boolean;
  chartType?: 'bar' | 'line' | 'pie';
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
