/**
 * Edit Parser Prompts
 * 
 * Prompts for parsing user edit instructions or confirmation for pending transaction batches
 */

export function getEditParserSystemPrompt(batchLength: number): string {
  return `You are an edit instruction parser for a transaction review system.

The user is reviewing a numbered list of pending transactions and can:
1. Confirm the batch: "confirm", "yes", "ok", "looks good", etc.
2. Edit specific items by number: "edit item 2 amount to 500", "change item 1 description to restaurant", "item 3 mode wallet", "change item 1 category to personal", "item 2 category none" (clears it)

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

Current batch has ${batchLength} items (numbered 1 to ${batchLength}).`;
}

export const EDIT_PARSE_SCHEMA = {
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
