/**
 * Query Interpreter Prompts
 * 
 * Prompts for converting natural language queries into structured filter parameters
 */

export function getQueryInterpreterSystemPrompt(
  todayISO: string,
  year: number,
): string {
  return `You are a query interpreter for a personal finance application.

Convert natural language queries into structured filter parameters.

Today's date: ${todayISO}

Available sheets — use these EXACT names, never decorated or invented:
"SEPTEMBER" (PhonePay/Wallet rows), "CASH TRACKER" (Money/Bank rows).
Payment modes: PHONEPAY, WALLET, MONEY, BANK
Categories: AVOID_EXPENSE, PAY_HOME_CASH, PERSONAL_EXPENSE, HOME_EXPENSE, WISHLIST_EXPENSE

Date interpretation (rolling windows, NEVER calendar weeks):
- "this month" → current month dates
- "last 7 days", "last week", "over last week", "past week" → ALL mean the
  trailing 7 days ending today (dateFrom = today − 6 days, dateTo = today).
  "Last week" is NOT Monday–Sunday — it is identical to "last 7 days".
- "last 3 days" → trailing 3 days ending today.
- "September" → September ${year}

Common queries:
- "how much did I spend this month?" → aggregate SUM on debit, filter current month
- "show me party expenses" → filter descriptionContains: "party"
- "count phonepay transactions" → filter mode: PHONEPAY, aggregate COUNT
- "average home expenses" → filter category: HOME_EXPENSE, aggregate AVERAGE
- "what was my latest transaction" / "most recent phonepay payment" → limit: 1
  (newest-first), keep any mode/category filters, no date narrowing needed

"Latest" queries:
- "latest", "most recent", "last transaction" → set limit: 1
- Combine with other filters when present ("latest BANK transaction" → modes: [BANK], limit: 1)

Category mapping (IMPORTANT — color codes are sparse in real books):
- Bare "personal expenses" / "my spending" / "my expenses" WITHOUT a color-coded
  qualifier means ALL debit spending → do NOT set a categories filter.
- Only set a categories filter when the user names a color-coded concept:
  "avoid" (unnecessary) → AVOID_EXPENSE, "wishlist" → WISHLIST_EXPENSE,
  "home/household/family" → HOME_EXPENSE, "given to family/cash to home" → PAY_HOME_CASH.
- Most everyday rows are uncolored; filtering them by PERSONAL_EXPENSE would
  wrongly return zero results.

Mode mapping:
- "savings" / "bank" / "account" → BANK (savings live in CASH TRACKER as BANK).
- "cash" / "money" → MONEY. "phonepe/phonepay/upi/gpay" → PHONEPAY.
  "wallet/paytm/card" → WALLET.

Balance questions (read sheet balances, NEVER transaction sums):
- "balance", "current X balance", "how much money is there", "how much is
  there in bank", "how much there at present" → wantsBalances: true.
- Keep the mode filter when a mode is named (BANK for "bank balance").
- Do NOT narrow by date unless the user states a period ("current" = all-time).
- Aggregation still SUM (totals accompany the balances for context).

Aggregation types: SUM, COUNT, AVERAGE
Aggregation fields: debit, credit, amount

Chart detection:
- Keywords: "chart", "graph", "plot", "show", "visualize"
- Types: bar (default), line (trends), pie (distribution)

Output structured filters, aggregation preferences, and chart request.`;
}

export const QUERY_INTERPRETATION_SCHEMA = {
  type: 'object' as const,
  properties: {
    filters: {
      type: 'object' as const,
      properties: {
        sheets: {
          type: 'array' as const,
          items: {
            type: 'string' as const,
          },
        },
        modes: {
          type: 'array' as const,
          items: {
            type: 'string' as const,
            enum: ['PHONEPAY', 'WALLET', 'MONEY', 'BANK'],
          },
        },
        categories: {
          type: 'array' as const,
          items: {
            type: 'string' as const,
            enum: [
              'AVOID_EXPENSE',
              'PAY_HOME_CASH',
              'PERSONAL_EXPENSE',
              'HOME_EXPENSE',
              'WISHLIST_EXPENSE',
            ],
          },
        },
        dateFrom: {
          type: 'string' as const,
        },
        dateTo: {
          type: 'string' as const,
        },
        descriptionContains: {
          type: 'string' as const,
        },
        tags: {
          type: 'array' as const,
          items: {
            type: 'string' as const,
          },
        },
        amountMin: {
          type: 'number' as const,
        },
        amountMax: {
          type: 'number' as const,
        },
      },
      required: [
        'sheets',
        'modes',
        'categories',
        'dateFrom',
        'dateTo',
        'descriptionContains',
        'tags',
        'amountMin',
        'amountMax',
      ],
      additionalProperties: false,
    },
    aggregationType: {
      type: 'string' as const,
      enum: ['SUM', 'COUNT', 'AVERAGE'],
    },
    aggregationField: {
      type: 'string' as const,
      enum: ['debit', 'credit', 'amount'],
    },
    chartRequested: {
      type: 'boolean' as const,
    },
    chartType: {
      type: 'string' as const,
      enum: ['bar', 'line', 'pie'],
    },
    limit: {
      type: ['number', 'null'] as any,
      description:
        'Max rows newest-first; 1 for latest/most-recent queries, null otherwise',
    },
    wantsBalances: {
      type: 'boolean' as const,
      description:
        'True for balance/how-much-is-there questions; sheet balances are returned authoritatively',
    },
    reasoning: {
      type: 'string' as const,
    },
  },
  required: [
    'filters',
    'aggregationType',
    'aggregationField',
    'chartRequested',
    'chartType',
    'limit',
    'wantsBalances',
    'reasoning',
  ],
  additionalProperties: false,
};
