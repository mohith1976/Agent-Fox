/**
 * Intent Classifier Prompts
 *
 * Classifies user intent into:
 * - NEW_TRANSACTION_BATCH
 * - ANALYTICAL_QUERY
 * - EDIT_OR_CONFIRM
 * - UNKNOWN
 *
 * Plus combinational splitting: one message can carry several independent
 * sub-requests ("log X and what's my balance"), each classified on its own.
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

Combinational messages (subRequests — segment by MEANING, never by example):
- A message is combinational ONLY when its parts do/ask genuinely different
  things joined by conjunctions ("log siva 100 and what's my bank balance",
  "avoid expenses last week and home expenses this month", "chart my spending
  and show yesterday's rows"). Emit one sub-request per part, each with its
  own intent, in order.
- Item lists sharing one verb are ONE request, never split ("coffee 100 and
  tea 50", "idli 50 cash; dosa 80 phonepay" → single NEW_TRANSACTION_BATCH
  with the whole text).
- A single request → subRequests holds exactly one element (the whole
  message, intent = the overall intent).
- Each sub-request text must be self-contained (repeat the amount/mode when
  splitting would otherwise strand it).

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
    subRequests: {
      type: 'array' as const,
      description:
        'Independent sub-requests (combinational messages only); single-element array holding the whole message otherwise',
      items: {
        type: 'object' as const,
        properties: {
          text: {
            type: 'string' as const,
            description: 'Self-contained sub-request text',
          },
          intent: {
            type: 'string' as const,
            enum: [
              'NEW_TRANSACTION_BATCH',
              'ANALYTICAL_QUERY',
              'EDIT_OR_CONFIRM',
              'UNKNOWN',
            ],
          },
        },
        required: ['text', 'intent'],
        additionalProperties: false,
      },
    },
  },
  required: ['intent', 'confidence', 'reasoning', 'subRequests'],
  additionalProperties: false,
};
