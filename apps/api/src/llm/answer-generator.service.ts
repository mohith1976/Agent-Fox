import { Injectable, Logger } from '@nestjs/common';
import { AzureAIService, EMPTY_USAGE } from './azure-ai.service';
import { AnswerResult, WithUsage } from './llm.types';
import { normalizeModeLabel } from '../workflow/excel/excel.service';
import {
  getAnswerGeneratorSystemPrompt,
  getAnswerRegeneratorSystemPrompt,
  ANSWER_GENERATION_SCHEMA,
} from './prompts/answer-generator.prompts';

/**
 * Answer Generator Service
 *
 * Converts retrieved transaction data into a human-readable answer
 * using the Azure AI LLM.
 *
 * GENERIC BY DESIGN:
 * The `workflowPrompt` parameter comes from `agent_workflows.prompt` in the DB.
 * This means the service is not hardcoded to expense tracking — any workflow
 * with a different DB prompt will get domain-appropriate answers automatically.
 */
@Injectable()
export class AnswerGenerator {
  private readonly logger = new Logger(AnswerGenerator.name);

  constructor(private readonly azureAI: AzureAIService) {}

  /**
   * Generate an answer for the user's query from retrieved transaction data.
   *
   * @param input.transactions - The transactions retrieved by the query_transactions tool
   * @param input.queryIntent - Aggregation type (SUM/COUNT/AVERAGE) or filter description
   * @param input.workflowPrompt - The agent_workflows.prompt value — provides domain context
   * @param input.count - Number of transactions retrieved
   * @returns Structured answer with text, hasNumbers flag, and reasoning
   */
  async generate(input: {
    transactions: any[];
    queryIntent: string;
    workflowPrompt: string;
    count: number;
    /** Retrieval caveat (e.g. filters were broadened) — disclosed in the answer. */
    note?: string | null;
    /** Authoritative sheet balances (for balance questions — lead with these). */
    balances?: Record<string, number | null> | null;
    /** Modes the user asked about (null/empty = all). Scopes the mandatory lead sentence. */
    balanceModes?: string[] | null;
  }): Promise<WithUsage<AnswerResult>> {
    this.logger.log(
      `Generating answer for intent "${input.queryIntent}" with ${input.count} transactions`,
    );

    const systemPrompt = getAnswerGeneratorSystemPrompt(input.workflowPrompt);

    const userContent = buildUserContent(
      input.transactions,
      input.queryIntent,
      input.count,
      input.note,
      input.balances,
      input.balanceModes,
    );

    return this.callLLM(systemPrompt, userContent, 'generate');
  }

  /**
   * Regenerate an improved answer when the first attempt was unsatisfactory.
   *
   * @param input.transactions - Same transactions as the original call
   * @param input.queryIntent - Same intent as the original call
   * @param input.workflowPrompt - The agent_workflows.prompt value
   * @param input.previousAnswer - The previous (unsatisfactory) answer text
   * @param input.feedback - Why the previous answer was unsatisfactory
   * @returns Improved answer
   */
  async regenerate(input: {
    transactions: any[];
    queryIntent: string;
    workflowPrompt: string;
    previousAnswer: string;
    feedback: string;
    note?: string | null;
    balances?: Record<string, number | null> | null;
    balanceModes?: string[] | null;
  }): Promise<WithUsage<AnswerResult>> {
    this.logger.log(
      `Regenerating answer for intent "${input.queryIntent}" — reason: ${input.feedback}`,
    );

    const systemPrompt = getAnswerRegeneratorSystemPrompt(input.workflowPrompt);

    const userContent =
      `Previous answer (unsatisfactory): "${input.previousAnswer}"\n` +
      `Feedback: ${input.feedback}\n\n` +
      buildUserContent(input.transactions, input.queryIntent, input.transactions.length, input.note, input.balances, input.balanceModes);

    return this.callLLM(systemPrompt, userContent, 'regenerate');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async callLLM(
    systemPrompt: string,
    userContent: string,
    operation: string,
  ): Promise<WithUsage<AnswerResult>> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ];

    try {
      const { data: result, usage } = await this.azureAI.getStructuredCompletion<AnswerResult>(
        messages,
        {
          type: 'json_schema',
          json_schema: {
            name: 'answer_generation',
            strict: true,
            schema: ANSWER_GENERATION_SCHEMA,
          },
        },
        1, // gpt-5-mini only supports temperature=1
      );

      this.logger.log(
        `Answer ${operation}d: hasNumbers=${result.hasNumbers}, length=${result.text.length}`,
      );

      return { ...result, usage };
    } catch (error) {
      this.logger.error(
        `Answer ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}

/**
 * Serialize the transaction list and query intent into a compact user message.
 * Includes aggregated totals so the LLM doesn't need to re-compute them.
 */
function buildUserContent(
  transactions: any[],
  queryIntent: string,
  count: number,
  note?: string | null,
  balances?: Record<string, number | null> | null,
  balanceModes?: string[] | null,
): string {
  // Balances outrank row counts: a balance question with zero retrieved rows
  // still has an authoritative answer from the sheet last-rows.
  if (count === 0 && !balances) {
    return `Query intent: ${queryIntent}\nResult: No transactions found.`;
  }
  if (count === 0 && balances) {
    return (
      `Query intent: ${queryIntent}\n` +
      `Result: No transaction rows matched, but authoritative sheet balances exist.\n` +
      `${mandatoryBalanceLead(balances, balanceModes)}\n` +
      (note ? `Retrieval note (disclose this briefly in the answer): ${note}\n` : '')
    );
  }

  // Pre-compute totals so the LLM has exact numbers
  const totalDebit = transactions.reduce(
    (sum, t) => sum + (Number(t.debit) || Number(t.amount) || 0),
    0,
  );
  const totalCredit = transactions.reduce(
    (sum, t) => sum + (Number(t.credit) || 0),
    0,
  );
  // Net position (credit − debit). "Balance" questions MUST lead with this.
  const net = totalCredit - totalDebit;

  // Summarize top entries (cap at 20 to stay within context)
  const sample = transactions.slice(0, 20).map((t) => ({
    date: t.date,
    description: t.description,
    amount: t.debit || t.credit || t.amount,
    mode: t.mode,
    category: t.category,
  }));

  // Deterministic per-mode subtotals so the LLM reports exact
  // "via PhonePay X, via Bank Y…" breakdowns without doing arithmetic.
  // Modes are normalized ("Phone Pay" and "PHONEPAY" merge) so inconsistent
  // workbook labels never split a breakdown.
  const byMode: Record<string, { debit: number; credit: number; count: number }> = {};
  for (const t of transactions) {
    const mode = normalizeModeLabel(t.mode);
    byMode[mode] = byMode[mode] || { debit: 0, credit: 0, count: 0 };
    byMode[mode].debit += Number(t.debit) || 0;
    byMode[mode].credit += Number(t.credit) || 0;
    if (!Number(t.credit)) {
      // amount fallback for rows shaped as { amount } instead of debit/credit
      byMode[mode].debit += Number(t.amount) || 0;
    }
    byMode[mode].count += 1;
  }
  const modeLines = Object.entries(byMode).map(
    ([mode, m]) =>
      `- ${mode}: debit ₹${m.debit.toLocaleString('en-IN')} / credit ₹${m.credit.toLocaleString('en-IN')} across ${m.count} transaction(s)`,
  );

  return (
    `Query intent: ${queryIntent}\n` +
    (balances ? `${mandatoryBalanceLead(balances, balanceModes)}\n` : '') +
    `Total transactions: ${count}\n` +
    `Total debit: ₹${totalDebit.toLocaleString('en-IN')}\n` +
    `Total credit: ₹${totalCredit.toLocaleString('en-IN')}\n` +
    `Net position (total credit − total debit): ₹${net.toLocaleString('en-IN')}\n` +
    `Per-mode breakdown (report these exact numbers, grouped by mode):\n${modeLines.join('\n')}\n` +
    (note ? `Retrieval note (disclose this briefly in the answer): ${note}\n` : '') +
    `Transactions (up to 20 shown):\n${JSON.stringify(sample, null, 2)}`
  );
}

/**
 * Mandatory lead sentence for balance questions. Placed FIRST in the user
 * content and mirrored by a deterministic validator check, so the LLM cannot
 * silently substitute recomputed sums for sheet truth.
 */
function mandatoryBalanceLead(
  balances: Record<string, number | null>,
  balanceModes?: string[] | null,
): string {
  const wanted =
    balanceModes && balanceModes.length > 0
      ? balanceModes.map((m) => normalizeModeLabel(m))
      : Object.keys(balances);
  const parts = wanted.map((mode) => {
    const value = balances[mode];
    return value === null || value === undefined
      ? `${mode} — no recorded balance`
      : `${mode} ₹${Number(value).toLocaleString('en-IN')}`;
  });
  return (
    `MANDATORY FIRST SENTENCE — start your answer with EXACTLY this (fill nothing else in):\n` +
    `"Your balance${wanted.length === 1 ? '' : 's'}: ${parts.join('; ')} (as per your sheet)."`
  );
}
