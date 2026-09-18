import { Injectable, Logger } from '@nestjs/common';
import { AzureAIService, EMPTY_USAGE } from './azure-ai.service';
import {
  IntentClassificationResult,
  IntentType,
  WithUsage,
} from './llm.types';
import {
  getIntentClassifierSystemPrompt,
  INTENT_CLASSIFIER_SCHEMA,
} from './prompts/intent-classifier.prompts';

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
   * @param hasPriorResults - Whether the thread already holds retrieved transactions
   *   (lets follow-ups like "give their details" resolve to ANALYTICAL_QUERY)
   * @returns Intent classification result
   */
  async classify(
    userMessage: string,
    hasPendingBatch: boolean = false,
    hasPriorResults: boolean = false,
  ): Promise<WithUsage<IntentClassificationResult>> {
    this.logger.log(
      `Classifying intent for message: "${userMessage.substring(0, 50)}..."`,
    );

    const systemPrompt = getIntentClassifierSystemPrompt(
      hasPendingBatch,
      hasPriorResults,
    );

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
        await this.azureAI.getStructuredCompletion<{
          intent: IntentType;
          confidence: number;
          reasoning: string;
          subRequests?: Array<{ text: string; intent: string }>;
        }>(
          messages,
          {
            type: 'json_schema',
            json_schema: {
              name: 'intent_classification',
              strict: true,
              schema: INTENT_CLASSIFIER_SCHEMA,
            },
          },
          1, // gpt-5-mini requires temperature=1
        );

      this.logger.log(
        `Intent classified: ${result.intent} (confidence: ${result.confidence}, subs: ${(result.subRequests || []).length})`,
      );

      return { ...result, usage };
    } catch (error) {
      this.logger.error(
        `Intent classification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Fallback to UNKNOWN on error
      return {
        intent: 'UNKNOWN',
        confidence: 0,
        reasoning: 'Classification failed',
        subRequests: [],
        usage: EMPTY_USAGE,
      };
    }
  }
}
