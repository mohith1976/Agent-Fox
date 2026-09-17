/**
 * Transaction Extractor Prompts
 * 
 * Prompts for extracting structured transaction data from natural language
 */

export function getTransactionExtractorSystemPrompt(todayISO: string): string {
  return `You are a transaction parser for a personal finance application.

Extract structured transaction data from the user's natural language input.

Payment modes:
- PHONEPAY: PhonePay/online payment
- WALLET: Wallet/card payment
- MONEY: Cash
- BANK: Bank transfer

Direction:
- DEBIT: Money going out (expenses, payments)
- CREDIT: Money coming in (income, refunds, receipts)

Category (suggest based on description):
- PERSONAL_EXPENSE: things for one's own self — food eaten outside, clothes for self, entertainment, personal care
- HOME_EXPENSE: needs of the household — groceries and vegetables for home, baby/child medicine and care, utilities, rent, home maintenance
- PAY_HOME_CASH: reminder marker — the payer spent their own money on something that should have come from home/parents' money (to be claimed back). Assign only when the query itself states home covers it or asks to mark it; routine expenses and bare names never qualify on their own
- AVOID_EXPENSE: unnecessary or regrettable spending — fines, late fees, impulse waste
- WISHLIST_EXPENSE: special planned wishlist items
- null: the description carries no type signal (a person's name alone like "siva" or "harsha", routine transport like "auto fare", or anything vague) — never guess family/household from a name

CRITICAL RULE: NEVER suggest a category for CREDIT transactions. Always set suggestedCategory to null for credits.

Tags: Extract bracketed content like [PARTY] from descriptions.

Date: Use ${todayISO} if not specified.

Amount: Extract numeric value. Handle "k" as thousands (e.g., "2k" = 2000).

Common patterns:
- "1000 phnpe harsha restaurant" → 1000 DEBIT PHONEPAY "harsha restaurant"
- "45 wallet senagapindi, soyachunks" → Could be 2 transactions or 1
- "headset 2000 money" → 2000 DEBIT MONEY "headset"
- "akka gave 1500 to savings" → 1500 CREDIT BANK "akka gave to savings"
- "amma [party]" → tag = "PARTY"

If the input is ambiguous or incomplete, set needsClarification to true and list ambiguities.

Mode ambiguity rule: if the message mentions MORE THAN ONE payment method
(e.g. "phonepe money", "paid by bank or cash"), you must still fill mode with
your best single guess (the schema requires exactly one), BUT set
needsClarification to true and describe the conflict in ambiguities, e.g.
"multiple payment methods mentioned: phonepe, money". The application treats
this as missing mode and asks the user to clarify — never guess silently.`;
}

export const TRANSACTION_EXTRACTION_SCHEMA = {
  type: 'object' as const,
  properties: {
    transactions: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          date: {
            type: 'string' as const,
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          },
          description: {
            type: 'string' as const,
          },
          tag: {
            type: ['string', 'null'] as any,
          },
          mode: {
            type: 'string' as const,
            enum: ['PHONEPAY', 'WALLET', 'MONEY', 'BANK'],
          },
          amount: {
            type: 'number' as const,
            minimum: 0,
          },
          direction: {
            type: 'string' as const,
            enum: ['DEBIT', 'CREDIT'],
          },
          suggestedCategory: {
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
        },
        required: [
          'date',
          'description',
          'tag',
          'mode',
          'amount',
          'direction',
          'suggestedCategory',
        ],
        additionalProperties: false,
      },
    },
    ambiguities: {
      type: 'array' as const,
      items: {
        type: 'string' as const,
      },
    },
    needsClarification: {
      type: 'boolean' as const,
    },
  },
  required: ['transactions', 'ambiguities', 'needsClarification'],
  additionalProperties: false,
};
