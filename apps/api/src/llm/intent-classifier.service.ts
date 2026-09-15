import { Injectable, Logger } from '@nestjs/common';
import { AzureAIService } from './azure-ai.service';
import { IntentClassificationResult, IntentType } from './llm.types';

/**
 * Intent Classifier
 * Classifies user messages into: NEW_TRANSACTION_BATCH, ANALYTICAL_QUERY, EDIT_OR_CONFIRM, UNKNOWN
 */
@Injectable()
export class IntentClassifier {
  private readonly logger = new Logger(IntentClassifier.name);

  constructor(private readonly azureAI: AzureAIService) {}

  /**
   * Classify the user's intent
   * @param userMessage - The user's natural language message
   * @param hasPendingBatch - Whether there's a pending transaction batch awaiting confirmation
   * @returns Intent classification result
   */
  async classify(
    userMessage: string,
    hasPendingBatch: boolean = false,
  ): Promise<IntentClassificationResult> {
    this.logger.log(
      `Classifying intent for message: "${userMessage.substring(0, 50)}..."`,
    );

    const systemPrompt = `You are an intent classifier for a personal finance application.

The user can:
1. Record new transactions (e.g., "1000 phnpe harsha restaurant", "headset 2000 money")
2. Ask analytical questions (e.g., "how much did I spend this month?", "show me party expenses")
3. Respond to a pending transaction batch with edits or confirmation (e.g., "edit item 2 amount to 500", "confirm", "yes")

${hasPendingBatch ? 'IMPORTANT: There is currently a PENDING transaction batch awaiting the user\'s response.' : ''}

Classify the user's intent into one of:
- NEW_TRANSACTION_BATCH: User is recording new transactions
- ANALYTICAL_QUERY: User is asking a question or requesting analysis/charts
- EDIT_OR_CONFIRM: User is editing or confirming a pending batch
- UNKNOWN: Cannot determine intent

Return a confidence score (0-1) and brief reasoning.`;

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
        intent: {
          type: 'string' as const,
          enum: [
            'NEW_TRANSACTION_BATCH',
            'ANALYTICAL_QUERY',
            'EDIT_OR_CONFIRM',
            'UNKNOWN',
          ],
        },
        confidence: {
          type: 'number' as const,
          minimum: 0,
          maximum: 1,
        },
        reasoning: {
          type: 'string' as const,
        },
      },
      required: ['intent', 'confidence', 'reasoning'],
      additionalProperties: false,
    };

    try {
      const result = await this.azureAI.getStructuredCompletion<{
        intent: IntentType;
        confidence: number;
        reasoning: string;
      }>(
        messages,
        {
          type: 'json_schema',
          json_schema: {
            name: 'intent_classification',
            strict: true,
            schema,
          },
        },
        1, // gpt-5-mini requires temperature=1
      );

      this.logger.log(
        `Intent classified: ${result.intent} (confidence: ${result.confidence})`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `Intent classification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Fallback to UNKNOWN on error
      return {
        intent: 'UNKNOWN',
        confidence: 0,
        reasoning: 'Classification failed',
      };
    }
  }
}
