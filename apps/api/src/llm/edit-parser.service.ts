import { Injectable, Logger } from '@nestjs/common';
import { AzureAIService, EMPTY_USAGE } from './azure-ai.service';
import { EditParseResult, EditInstruction, WithUsage } from './llm.types';
import {
  getEditParserSystemPrompt,
  EDIT_PARSE_SCHEMA,
} from './prompts/edit-parser.prompts';

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
  ): Promise<WithUsage<EditParseResult>> {
    this.logger.log(
      `Parsing edit/confirm for: "${userMessage}" (${pendingBatch.length} items in batch)`,
    );

    const systemPrompt = getEditParserSystemPrompt(pendingBatch.length);

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
        await this.azureAI.getStructuredCompletion<EditParseResult>(
          messages,
          {
            type: 'json_schema',
            json_schema: {
              name: 'edit_parse',
              strict: true,
              schema: EDIT_PARSE_SCHEMA,
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
          usage,
        };
      }

      return { ...result, usage };
    } catch (error) {
      this.logger.error(
        `Edit parsing failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        isConfirmation: false,
        edits: [],
        needsClarification: true,
        clarificationMessage: 'Could not understand your instruction',
        usage: EMPTY_USAGE,
      };
    }
  }
}
