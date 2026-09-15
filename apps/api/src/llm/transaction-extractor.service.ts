import { Injectable, Logger } from '@nestjs/common';
import { AzureAIService } from './azure-ai.service';
import {
  ExtractedTransaction,
  TransactionExtractionResult,
} from './llm.types';

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
  ): Promise<TransactionExtractionResult> {
    this.logger.log(`Extracting transactions from: "${userMessage}"`);

    const todayISO = currentDate.toISOString().split('T')[0];

    const systemPrompt = `You are a transaction parser for a personal finance application.

Extract structured transaction data from the user's natural language input.

Payment modes:
- PHONEPAY: PhonePay/online payment
- WALLET: Wallet/card payment
- MONEY: Cash
- BANK: Bank transfer

Direction:
- DEBIT: Money going out (expenses, payments)
- CREDIT: Money coming in (income, refunds, receipts)

Category (suggest based on description):
- AVOID_EXPENSE: Unnecessary or regrettable expenses
- PAY_HOME_CASH: Money given to family/household
- PERSONAL_EXPENSE: Personal items/needs
- HOME_EXPENSE: Household/family expenses
- WISHLIST_EXPENSE: Special wishlist items
- null: Neutral or unclear

CRITICAL RULE: NEVER suggest a category for CREDIT transactions. Always set suggestedCategory to null for credits.

Tags: Extract bracketed content like [PARTY] from descriptions.

Date: Use ${todayISO} if not specified.

Amount: Extract numeric value. Handle "k" as thousands (e.g., "2k" = 2000).

Common patterns:
- "1000 phnpe harsha restaurant" → 1000 DEBIT PHONEPAY "harsha restaurant"
- "45 wallet senagapindi, soyachunks" → Could be 2 transactions or 1
- "headset 2000 money" → 2000 DEBIT MONEY "headset"
- "akka gave 1500 to savings" → 1500 CREDIT BANK "akka gave to savings"
- "amma [party]" → tag = "PARTY"

If the input is ambiguous or incomplete, set needsClarification to true and list ambiguities.`;

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

    const schema = {
      type: 'object' as const,
      properties: {
        transactions: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            properties: {
              date: {
                type: 'string' as const,
                pattern: '^\\d{4}-\\d{2}-\\d{2}$',
              },
              description: {
                type: 'string' as const,
              },
              tag: {
                type: ['string', 'null'] as any,
              },
              mode: {
                type: 'string' as const,
                enum: ['PHONEPAY', 'WALLET', 'MONEY', 'BANK'],
              },
              amount: {
                type: 'number' as const,
                minimum: 0,
              },
              direction: {
                type: 'string' as const,
                enum: ['DEBIT', 'CREDIT'],
              },
              suggestedCategory: {
                type: ['string', 'null'] as any,
                enum: [
                  'AVOID_EXPENSE',
                  'PAY_HOME_CASH',
                  'PERSONAL_EXPENSE',
                  'HOME_EXPENSE',
                  'WISHLIST_EXPENSE',
                  null,
                ],
              },
            },
            required: [
              'date',
              'description',
              'tag',
              'mode',
              'amount',
              'direction',
              'suggestedCategory',
            ],
            additionalProperties: false,
          },
        },
        ambiguities: {
          type: 'array' as const,
          items: {
            type: 'string' as const,
          },
        },
        needsClarification: {
          type: 'boolean' as const,
        },
      },
      required: ['transactions', 'ambiguities', 'needsClarification'],
      additionalProperties: false,
    };

    try {
      const result =
        await this.azureAI.getStructuredCompletion<TransactionExtractionResult>(
          messages,
          {
            type: 'json_schema',
            json_schema: {
              name: 'transaction_extraction',
              strict: true,
              schema,
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

      return result;
    } catch (error) {
      this.logger.error(
        `Transaction extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}
