import { Injectable, Logger } from '@nestjs/common';
import { AzureAIService } from './azure-ai.service';
import {
  ExtractedTransaction,
  TransactionExtractionResult,
  WithUsage,
} from './llm.types';
import {
  getTransactionExtractorSystemPrompt,
  TRANSACTION_EXTRACTION_SCHEMA,
} from './prompts/transaction-extractor.prompts';

/**
 * Transaction Extractor
 * Extracts structured transaction data from natural language
 */
@Injectable()
export class TransactionExtractor {
  private readonly logger = new Logger(TransactionExtractor.name);

  constructor(private readonly azureAI: AzureAIService) {}

  /**
   * Extract transactions from natural language
   * @param userMessage - The user's message containing transaction(s)
   * @param currentDate - Current date for defaulting transaction dates
   * @returns Extracted transaction batch
   */
  async extract(
    userMessage: string,
    currentDate: Date = new Date(),
  ): Promise<WithUsage<TransactionExtractionResult>> {
    this.logger.log(`Extracting transactions from: "${userMessage}"`);

    const todayISO = currentDate.toISOString().split('T')[0];
    const systemPrompt = getTransactionExtractorSystemPrompt(todayISO);

    const messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }> = [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: userMessage,
      },
    ];

    try {
      const { data: result, usage } =
        await this.azureAI.getStructuredCompletion<TransactionExtractionResult>(
          messages,
          {
            type: 'json_schema',
            json_schema: {
              name: 'transaction_extraction',
              strict: true,
              schema: TRANSACTION_EXTRACTION_SCHEMA,
            },
          },
          1, // gpt-5-mini requires temperature=1
        );

      this.logger.log(
        `Extracted ${result.transactions.length} transaction(s)`,
      );

      // CRITICAL: Force null category for all credits
      result.transactions.forEach((tx) => {
        if (tx.direction === 'CREDIT') {
          tx.suggestedCategory = null;
        }
      });

      return { ...result, usage };
    } catch (error) {
      this.logger.error(
        `Transaction extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}
