import { Injectable, Logger } from '@nestjs/common';
import { AzureAIService } from './azure-ai.service';
import { QueryInterpretationResult } from './llm.types';

/**
 * Query Interpreter
 * Converts natural language queries into structured filter parameters
 */
@Injectable()
export class QueryInterpreter {
  private readonly logger = new Logger(QueryInterpreter.name);

  constructor(private readonly azureAI: AzureAIService) {}

  /**
   * Interpret analytical query
   * @param userMessage - User's analytical question
   * @param currentDate - Current date for date interpretation
   * @returns Query interpretation with filters and aggregation
   */
  async interpret(
    userMessage: string,
    currentDate: Date = new Date(),
  ): Promise<QueryInterpretationResult> {
    this.logger.log(`Interpreting query: "${userMessage}"`);

    const todayISO = currentDate.toISOString().split('T')[0];
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth() + 1;

    const systemPrompt = `You are a query interpreter for a personal finance application.

Convert natural language queries into structured filter parameters.

Today's date: ${todayISO}

Available sheets: SEPTEMBER (PhonePay/Wallet), "CASH TRACKER" (Money/Bank), etc.
Payment modes: PHONEPAY, WALLET, MONEY, BANK
Categories: AVOID_EXPENSE, PAY_HOME_CASH, PERSONAL_EXPENSE, HOME_EXPENSE, WISHLIST_EXPENSE

Date interpretation:
- "this month" → current month dates
- "last week" → past 7 days
- "September" → September ${year}

Common queries:
- "how much did I spend this month?" → aggregate SUM on debit, filter current month
- "show me party expenses" → filter descriptionContains: "party"
- "count phonepay transactions" → filter mode: PHONEPAY, aggregate COUNT
- "average home expenses" → filter category: HOME_EXPENSE, aggregate AVERAGE

Aggregation types: SUM, COUNT, AVERAGE
Aggregation fields: debit, credit, amount

Chart detection:
- Keywords: "chart", "graph", "plot", "show", "visualize"
- Types: bar (default), line (trends), pie (distribution)

Output structured filters, aggregation preferences, and chart request.`;

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
        filters: {
          type: 'object' as const,
          properties: {
            sheets: {
              type: 'array' as const,
              items: {
                type: 'string' as const,
              },
            },
            modes: {
              type: 'array' as const,
              items: {
                type: 'string' as const,
                enum: ['PHONEPAY', 'WALLET', 'MONEY', 'BANK'],
              },
            },
            categories: {
              type: 'array' as const,
              items: {
                type: 'string' as const,
                enum: [
                  'AVOID_EXPENSE',
                  'PAY_HOME_CASH',
                  'PERSONAL_EXPENSE',
                  'HOME_EXPENSE',
                  'WISHLIST_EXPENSE',
                ],
              },
            },
            dateFrom: {
              type: 'string' as const,
            },
            dateTo: {
              type: 'string' as const,
            },
            descriptionContains: {
              type: 'string' as const,
            },
            tags: {
              type: 'array' as const,
              items: {
                type: 'string' as const,
              },
            },
            amountMin: {
              type: 'number' as const,
            },
            amountMax: {
              type: 'number' as const,
            },
          },
          required: [
            'sheets',
            'modes',
            'categories',
            'dateFrom',
            'dateTo',
            'descriptionContains',
            'tags',
            'amountMin',
            'amountMax',
          ],
          additionalProperties: false,
        },
        aggregationType: {
          type: 'string' as const,
          enum: ['SUM', 'COUNT', 'AVERAGE'],
        },
        aggregationField: {
          type: 'string' as const,
          enum: ['debit', 'credit', 'amount'],
        },
        chartRequested: {
          type: 'boolean' as const,
        },
        chartType: {
          type: 'string' as const,
          enum: ['bar', 'line', 'pie'],
        },
        reasoning: {
          type: 'string' as const,
        },
      },
      required: [
        'filters',
        'aggregationType',
        'aggregationField',
        'chartRequested',
        'chartType',
        'reasoning',
      ],
      additionalProperties: false,
    };

    try {
      const result =
        await this.azureAI.getStructuredCompletion<QueryInterpretationResult>(
          messages,
          {
            type: 'json_schema',
            json_schema: {
              name: 'query_interpretation',
              strict: true,
              schema,
            },
          },
          1, // gpt-5-mini only supports temperature=1
        );

      this.logger.log(
        `Query interpreted: ${result.aggregationType || 'filter'} on ${Object.keys(result.filters).length} filter(s)`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `Query interpretation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}
