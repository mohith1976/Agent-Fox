import { Injectable, Logger } from '@nestjs/common';
import { AzureAIService } from './azure-ai.service';
import {
  CategoryInferenceInput,
  CategoryInferenceResult,
  ColourCategory,
} from './llm.types';

/**
 * Category Inference Service
 * Infers expense categories including Wishlist matching
 */
@Injectable()
export class CategoryInferenceService {
  private readonly logger = new Logger(CategoryInferenceService.name);

  constructor(private readonly azureAI: AzureAIService) {}

  /**
   * Infer category for a transaction
   * @param input - Transaction details and Wishlist terms
   * @returns Category inference result
   */
  async inferCategory(
    input: CategoryInferenceInput,
  ): Promise<CategoryInferenceResult> {
    this.logger.log(
      `Inferring category for: "${input.description}" (${input.direction})`,
    );

    // CRITICAL: Credits never receive categories
    if (input.direction === 'CREDIT') {
      return {
        category: null,
        reasoning: 'Credits never receive category colors',
        wishlistMatch: false,
      };
    }

    const systemPrompt = `You are a category inference engine for expense categorization.

Given a transaction description and direction, determine the appropriate expense category.

Categories:
- AVOID_EXPENSE: Unnecessary or regrettable expenses (e.g., impulse buys, late fees)
- PAY_HOME_CASH: Money given to family/household
- PERSONAL_EXPENSE: Personal items/needs (e.g., clothes, grooming, personal care)
- HOME_EXPENSE: Household/family expenses (e.g., groceries, utilities, family items)
- WISHLIST_EXPENSE: Special wishlist items (expensive planned purchases)
- null: Neutral or unclear transactions

Wishlist terms from user's TERMINOLOGY sheet:

For Home: ${input.wishlistTerms.forHome.join(', ')}
Personal: ${input.wishlistTerms.personal.join(', ')}
Wishlist: ${input.wishlistTerms.wishlist.join(', ')}

MATCHING RULES:
1. Check if description contains ANY Wishlist term (case-insensitive, substring match)
2. If Wishlist term found → return WISHLIST_EXPENSE (highest priority)
3. If Personal term found → return PERSONAL_EXPENSE
4. If ForHome term found → return HOME_EXPENSE
5. Otherwise, infer based on description semantics

CRITICAL: Return null for credit transactions (already enforced by caller).

Provide reasoning for your decision.`;

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
        content: `Description: "${input.description}"\nDirection: ${input.direction}`,
      },
    ];

    const schema = {
      type: 'object' as const,
      properties: {
        category: {
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
        reasoning: {
          type: 'string' as const,
        },
        wishlistMatch: {
          type: 'boolean' as const,
        },
      },
      required: ['category', 'reasoning', 'wishlistMatch'],
      additionalProperties: false,
    };

    try {
      const result =
        await this.azureAI.getStructuredCompletion<CategoryInferenceResult>(
          messages,
          {
            type: 'json_schema',
            json_schema: {
              name: 'category_inference',
              strict: true,
              schema,
            },
          },
          1, // gpt-5-mini requires temperature=1
        );

      this.logger.log(
        `Category inferred: ${result.category} (wishlist: ${result.wishlistMatch})`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `Category inference failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Fallback to null on error
      return {
        category: null,
        reasoning: 'Inference failed',
        wishlistMatch: false,
      };
    }
  }
}
