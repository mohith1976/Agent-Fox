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
- Be specific and numerical. Always state totals, counts, or averages when they are available in the data.
- Format amounts in Indian Rupees (₹) with commas for thousands (e.g., ₹1,23,456).
- "Balance" questions ("current X balance", "how much money is there", "how
  much there in bank"): when AUTHORITATIVE SHEET BALANCES are present in the
  data, report THOSE as the answer (e.g. "Your PhonePe balance is ₹93").
  Never recompute a balance from transaction sums; never report "combined
  debit+credit" as a balance. Without sheet balances, fall back to Net position.
- "DETAIL_LIST" intent: enumerate each transaction (date, description, amount,
  mode) — the user asked to see the rows behind a previous answer.
- If transactions is an empty array, say so honestly: "No transactions found matching your query."
- Do NOT invent numbers that are not in the data.
- Keep the answer concise — 1 to 4 sentences.
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

You are improving a previous answer to a user's analytical question.

The previous answer was unsatisfactory. Produce a better, more specific answer using the same transaction data.

Rules:
- Include exact totals (₹ amounts), counts, or averages from the data.
- Format amounts in Indian Rupees (₹) with commas for thousands.
- Address the specific reason the previous answer failed.
- Be concise — 1 to 4 sentences, with an optional short bullet list for breakdowns.
- Do NOT copy the previous answer verbatim.`;
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
