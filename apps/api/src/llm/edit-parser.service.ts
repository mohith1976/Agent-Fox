import { Injectable, Logger } from '@nestjs/common';
import { AzureAIService } from './azure-ai.service';
import { EditParseResult, EditInstruction } from './llm.types';

/**
 * Edit Parser
 * Parses user edit instructions or confirmation for pending transaction batches
 */
@Injectable()
export class EditParser {
  private readonly logger = new Logger(EditParser.name);

  constructor(private readonly azureAI: AzureAIService) {}

  /**
   * Parse edit instruction or confirmation
   * @param userMessage - User's response to pending batch
   * @param pendingBatch - The pending batch for context
   * @returns Parse result with edits or confirmation
   */
  async parse(
    userMessage: string,
    pendingBatch: any[],
  ): Promise<EditParseResult> {
    this.logger.log(
      `Parsing edit/confirm for: "${userMessage}" (${pendingBatch.length} items in batch)`,
    );

    const systemPrompt = `You are an edit instruction parser for a transaction review system.

The user is reviewing a numbered list of pending transactions and can:
1. Confirm the batch: "confirm", "yes", "ok", "looks good", etc.
2. Edit specific items by number: "edit item 2 amount to 500", "change item 1 description to restaurant", "item 3 mode wallet"

Available fields for editing:
- description: Text description
- amount: Numeric value
- mode: PHONEPAY, WALLET, MONEY, or BANK
- category: AVOID_EXPENSE, PAY_HOME_CASH, PERSONAL_EXPENSE, HOME_EXPENSE, WISHLIST_EXPENSE, or null
- tag: Free text tag

Parse the user's message and determine:
1. Is this a confirmation (approve the batch)?
2. Are there any edit instructions?

For edits, extract:
- itemNumber: The item number being edited (1-indexed)
- field: Which field to edit
- newValue: The new value (as string for description/tag/mode/category, number for amount)

If the instruction is unclear or refers to non-existent items, set needsClarification to true.

Current batch has ${pendingBatch.length} items (numbered 1 to ${pendingBatch.length}).`;

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
        isConfirmation: {
          type: 'boolean' as const,
        },
        edits: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            properties: {
              itemNumber: {
                type: 'number' as const,
                minimum: 1,
              },
              field: {
                type: 'string' as const,
                enum: ['description', 'amount', 'mode', 'category', 'tag'],
              },
              newValue: {
                type: ['string', 'number'] as any,
              },
            },
            required: ['itemNumber', 'field', 'newValue'],
            additionalProperties: false,
          },
        },
        needsClarification: {
          type: 'boolean' as const,
        },
        clarificationMessage: {
          type: 'string' as const,
        },
      },
      required: [
        'isConfirmation',
        'edits',
        'needsClarification',
        'clarificationMessage',
      ],
      additionalProperties: false,
    };

    try {
      const result =
        await this.azureAI.getStructuredCompletion<EditParseResult>(
          messages,
          {
            type: 'json_schema',
            json_schema: {
              name: 'edit_parse',
              strict: true,
              schema,
            },
          },
          1, // gpt-5-mini requires temperature=1
        );

      this.logger.log(
        `Parsed: confirmation=${result.isConfirmation}, edits=${result.edits.length}`,
      );

      // Validate item numbers are within range
      const invalidEdits = result.edits.filter(
        (edit) => edit.itemNumber < 1 || edit.itemNumber > pendingBatch.length,
      );

      if (invalidEdits.length > 0) {
        return {
          isConfirmation: false,
          edits: [],
          needsClarification: true,
          clarificationMessage: `Invalid item numbers: ${invalidEdits.map((e) => e.itemNumber).join(', ')}. Batch has ${pendingBatch.length} items.`,
        };
      }

      return result;
    } catch (error) {
      this.logger.error(
        `Edit parsing failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        isConfirmation: false,
        edits: [],
        needsClarification: true,
        clarificationMessage: 'Could not understand your instruction',
      };
    }
  }
}
