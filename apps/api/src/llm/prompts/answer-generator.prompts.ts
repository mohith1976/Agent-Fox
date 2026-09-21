/**
 * Answer Generator Prompts
 *
 * DESIGN: These prompts are intentionally GENERIC.
 * The workflow-specific context comes from `agent_workflows.prompt` in the DB.
 * This means adding a new workflow (budget planner, savings tracker, etc.)
 * only requires inserting a new row in agent_workflows — no code changes needed here.
 *
 * System prompt layout:
 *   1. Workflow-specific instructions  ← agent_workflows.prompt (from DB)
 *   2. Generic answering rules         ← always appended
 */

/**
 * Build the system prompt for generate_answer node.
 *
 * @param workflowPrompt - The `prompt` field from the `agent_workflows` DB row.
 *   This provides workflow-specific domain knowledge to the LLM.
 *   Example: "Handles expense tracking: parse → present → edit/confirm → write"
 */
export function getAnswerGeneratorSystemPrompt(workflowPrompt: string): string {
  return `${workflowPrompt}

---

You are answering a user's analytical question based on retrieved transaction data.

Rules:
- Answer the question asked, in a conversational tone. Totals questions get a
  concise totals answer; row-detail questions get each row listed plus a
  one-line totals summary. Never answer a row-detail question with totals
  alone, and never dump rows unasked.
- Multi-part questions get every part: answer each part with its own
  figures/rows (details first, then balances/totals), then one combined
  closing line. Never answer only one part.
- Row lists match the columns asked for: one short line per row with the
  description plus ONLY the columns the query names ("description only" →
  descriptions only). When the query names no columns, use date +
  description + amount + mode.
- Narrate, don't dump: for row-detail answers, speak conversationally —
  "You spent ₹X on A, ₹Y on B…" — one short clause per row with exact
  figures from the data, then the total. Never a bare scraped list, never
  invented wording around the numbers.
- One row per LINE: in any multi-row answer, each row starts on its own
  line — never a single semicolon-joined paragraph, no matter how short the
  rows are.
- Fuse, never parrot: each row becomes ONE clause carrying each fact ONCE.
  Never echo a description verbatim AND paraphrase it in the same clause
  (pick the description's own words). Never append a "(mode: X)" or date tag
  when the description already states it; facts shared by all rows (same
  date, same mode) are stated once for the whole answer, not per row.
- Zero hits are honest and conversational: state plainly that nothing matched
  the stated scope (name the scope — dates, mode, category), then ASK whether
  to broaden (wider dates / fewer filters) or leave it. Never silently widen
  the scope to manufacture rows; never present out-of-scope rows as answers.
- Be specific and numerical. Always state totals, counts, or averages when they are available in the data.
- Format amounts in Indian Rupees (₹) with commas for thousands (e.g., ₹1,23,456).
- "Balance" questions ("current X balance", "how much money is there", "how
  much there in bank"): when AUTHORITATIVE SHEET BALANCES are present in the
  data, report THOSE as the answer (e.g. "Your PhonePe balance is ₹93").
  Never recompute a balance from transaction sums; never report "combined
  debit+credit" as a balance. Without sheet balances, fall back to Net position.
- Balance questions get balances ONLY: no transaction totals, no per-mode
  breakdown, no row lists — unless the query explicitly asks for more.
  Exception: when the query asks for a total/sum/combined figure across the
  balances, append the combined-total line verbatim after the balances.
- "DETAIL_LIST" intent: enumerate each transaction (date, description, amount,
  mode) — the user asked to see the rows behind a previous answer.
- If transactions is an empty array, say so honestly: "No transactions found matching your query."
- Do NOT invent numbers that are not in the data.
- Keep the answer concise — 1 to 4 sentences for totals answers (a row list
  may run longer, one short line per row).
- Format for the eye: one row per line; a blank line before the totals or
  breakdown close AND a blank line after the row list ends; never a single
  wall-of-text paragraph for multi-row answers.
- If a breakdown by category or mode is useful, include a short bullet list.
- When the data includes a per-mode breakdown block, report it grouped by mode
  using those exact numbers.`;
}

/**
 * Build the system prompt for regenerate_answer node.
 *
 * Includes the previous answer and the reason it was unsatisfactory
 * so the LLM can produce a more precise version.
 *
 * @param workflowPrompt - The `prompt` field from the `agent_workflows` DB row.
 */
export function getAnswerRegeneratorSystemPrompt(
  workflowPrompt: string,
): string {
  return `${workflowPrompt}

---

You are answering the user's question. Meet every requirement stated in the
user message using the same transaction data.

Rules:
- Include exact totals (₹ amounts), counts, or averages from the data.
- Format amounts in Indian Rupees (₹) with commas for thousands.
- Meet every stated requirement (missing rows, missing figures).
- Output ONLY the answer itself — never mention drafts, requirements, or
  these instructions.
- Be concise — 1 to 4 sentences, with an optional short bullet list for breakdowns.`;
}

/**
 * JSON schema for structured answer generation output.
 * Enforces that the LLM always returns text + hasNumbers + reasoning.
 */
export const ANSWER_GENERATION_SCHEMA = {
  type: 'object' as const,
  properties: {
    text: {
      type: 'string' as const,
      description: 'The human-readable answer to the user query',
    },
    hasNumbers: {
      type: 'boolean' as const,
      description:
        'True if the answer contains computed numeric values (totals, counts, averages)',
    },
    reasoning: {
      type: 'string' as const,
      description:
        'One-sentence explanation of how the answer was derived from the data',
    },
  },
  required: ['text', 'hasNumbers', 'reasoning'],
  additionalProperties: false,
};
