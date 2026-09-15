/**
 * Chat Types
 * 
 * TypeScript definitions matching the backend API contract
 */

export interface ChatRequest {
  requestId: string;
  threadId: string;
  message: string;
}

export interface PendingTransaction {
  itemNumber: number;
  date: string;
  description: string;
  tag: string | null;
  mode: string;
  amount: number;
  direction: string;
  suggestedCategory: string | null;
}

export interface ChatResponse {
  success: boolean;
  response: string;
  pendingBatch?: PendingTransaction[] | null;
  chartImage?: string | null;
  error?: string | null;
  workflowMode: string;
  cached?: boolean;
  metadata?: {
    llmCalls?: number;
    toolCalls?: number;
    executionTimeMs?: number;
  };
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  pendingBatch?: PendingTransaction[] | null;
  chartImage?: string | null;
  error?: string | null;
  workflowMode?: string;
}
