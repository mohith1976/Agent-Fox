import { Injectable, Logger } from '@nestjs/common';
import { AzureAIService } from './azure-ai.service';
import { QueryInterpretationResult, WithUsage } from './llm.types';
import {
  getQueryInterpreterSystemPrompt,
  QUERY_INTERPRETATION_SCHEMA,
} from './prompts/query-interpreter.prompts';

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
  ): Promise<WithUsage<QueryInterpretationResult>> {
    this.logger.log(`Interpreting query: "${userMessage}"`);

    const todayISO = currentDate.toISOString().split('T')[0];
    const year = currentDate.getFullYear();
    const systemPrompt = getQueryInterpreterSystemPrompt(todayISO, year);

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
        await this.azureAI.getStructuredCompletion<QueryInterpretationResult>(
          messages,
          {
            type: 'json_schema',
            json_schema: {
              name: 'query_interpretation',
              strict: true,
              schema: QUERY_INTERPRETATION_SCHEMA,
            },
          },
          1, // gpt-5-mini only supports temperature=1
        );

      this.logger.log(
        `Query interpreted: ${result.aggregationType || 'filter'} on ${Object.keys(result.filters).length} filter(s)`,
      );

      return { ...result, usage };
    } catch (error) {
      this.logger.error(
        `Query interpretation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}
