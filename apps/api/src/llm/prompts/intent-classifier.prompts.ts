/**
 * Intent Classifier Prompts
 * 
 * Prompts for classifying user intent into:
 * - NEW_TRANSACTION_BATCH
 * - ANALYTICAL_QUERY
 * - EDIT_OR_CONFIRM
 * - UNKNOWN
 */

export function getIntentClassifierSystemPrompt(
  hasPendingBatch: boolean,
  hasPriorResults: boolean = false,
): string {
  return `You are an intent classifier for a personal finance application.

The user can:
1. Record new transactions (e.g., "1000 phnpe harsha restaurant", "headset 2000 money")
2. Ask analytical questions (e.g., "how much did I spend this month?", "show me party expenses")
3. Respond to a pending transaction batch with edits or confirmation (e.g., "edit item 2 amount to 500", "confirm", "yes")

${hasPendingBatch ? 'IMPORTANT: There is currently a PENDING transaction batch awaiting the user\'s response.' : ''}
${hasPriorResults ? 'IMPORTANT: The previous turn retrieved transactions. References to them ("give their details", "show them", "those ones", "list them") are follow-up analytical questions, NOT new transactions and NOT unknown.' : ''}

Classify the user's intent into one of:
- NEW_TRANSACTION_BATCH: User is recording new transactions
- ANALYTICAL_QUERY: User is asking a question or requesting analysis/charts (including follow-ups about previously retrieved results)
- EDIT_OR_CONFIRM: User is editing or confirming a pending batch — ONLY when a
  pending batch was actually mentioned as awaiting response. A bare fragment
  like "i paid" with no pending batch is NEW_TRANSACTION_BATCH, never
  EDIT_OR_CONFIRM.
- UNKNOWN: Cannot determine intent. Questions about the bot/system itself
  ("how many workflows are there", "what model are you", "list your tools")
  are ALWAYS UNKNOWN — this bot only does expense tracking.

Return a confidence score (0-1) and brief reasoning. Be strict: vague bullying,
jokes, or off-topic chat are UNKNOWN, never transactions.`;
}

export const INTENT_CLASSIFIER_SCHEMA = {
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
