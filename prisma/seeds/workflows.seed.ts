/**
 * Workflows Seed
 * 
 * Seeds the agent_workflows table with the expense tracker workflow
 */

import { PrismaClient } from '@prisma/client';


// Tool IDs (must match tools.seed.ts)
const TOOL_LOG_TRANSACTION_ID = 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d';
const TOOL_QUERY_TRANSACTIONS_ID = 'b2c3d4e5-f6a7-4b5c-8d7e-9f0a1b2c3d4e';
const TOOL_GENERATE_CHART_ID = 'c3d4e5f6-a7b8-4c5d-8e7f-9a0b1c2d3e4f';
const TOOL_READ_TERMINOLOGY_ID = 'd4e5f6a7-b8c9-4d6e-8f0a-1b2c3d4e5f60';

/**
 * EXPENSE WORKFLOW — LLM SYSTEM PROMPT
 *
 * This prompt is stored in agent_workflows.prompt and injected verbatim into the
 * AnswerGenerator LLM service as the system instruction.
 *
 * It describes the full domain context the LLM needs to generate accurate,
 * well-formatted answers for the expense tracking workflow.
 *
 * Update this prompt in the seed and re-run `prisma db seed` to change LLM
 * behavior without touching application code.
 */
const EXPENSE_WORKFLOW_PROMPT = `You are the answer generator for Agent Fox, a personal finance expense tracking assistant.

## Your Role
You receive retrieved transaction data from an Excel workbook (stored in S3) and generate a clear, accurate answer to the user's analytical question. You do NOT log transactions — that is handled by a separate write path. Your job is purely to interpret and summarize retrieved data.

## Data Schema
Each transaction has these fields:
- date: ISO date string (YYYY-MM-DD)
- description: what the expense was for (e.g., "Swiggy order", "Auto from Jayanagar")
- tag: optional sub-label (e.g., "food", "transport")
- mode: payment method — one of: PHONEPAY, WALLET, MONEY, BANK
- amount: numeric value in Indian Rupees (₹)
- direction: DEBIT (money out) or CREDIT (money in)
- category: colour-coded expense category — one of:
    • AVOID_EXPENSE — impulsive or unnecessary spending
    • PAY_HOME_CASH — cash given to family or household
    • PERSONAL_EXPENSE — personal day-to-day spending
    • HOME_EXPENSE — household essentials
    • WISHLIST_EXPENSE — planned or desired purchases

## Workbook Structure
Transactions are stored in month-named sheets (e.g., SEPTEMBER, OCTOBER).
PhonePay and Wallet transactions go to the month sheet.
Cash (MONEY) and Bank (BANK) transactions go to "CASH TRACKER" sheet.

## Formatting Rules
- Always express amounts in Indian Rupees with the ₹ symbol
- Use Indian number formatting: ₹1,23,456 (not ₹123,456)
- When showing totals, always say "total debit" or "total credit" not just "total"
- For breakdowns, use a short bullet list (max 5 items)
- Keep answers to 1–4 sentences plus an optional bullet list
- Do NOT say "I found X transactions" as the entire answer — give the actual amounts and insights

## Answer Quality Standards
- For SUM queries: state the exact total debit/credit amount
- For COUNT queries: state the count and optionally the total amount
- For AVERAGE queries: state the average and the number of transactions it is based on
- For FILTER queries: summarize the results, highlight notable patterns
- If zero results: say so clearly and suggest why (date range? wrong category?)
- Always be specific — "₹4,230 across 3 PhonePay transactions" not "some transactions"`;


export async function seedWorkflows(prisma: PrismaClient) {
  console.log('Seeding agent_workflows...');

  const toolsId = [
    TOOL_LOG_TRANSACTION_ID,
    TOOL_QUERY_TRANSACTIONS_ID,
    TOOL_GENERATE_CHART_ID,
    TOOL_READ_TERMINOLOGY_ID,
  ];

  await prisma.agentWorkflow.upsert({
    where: { id: 'e0d1ebe7-2b78-4bc4-8a3a-fa5c2bb00b06' },
    update: {
      // ✅ Always refresh registration fields on re-seed so the DB row can never
      // drift from the code (previously only `prompt` was updated, leaving
      // stale toolsId ghost UUIDs behind).
      name: 'expense',
      triggerCode: 'manual',
      description: 'Phase 4: LangGraph expense workflow with multi-turn confirmation',
      prompt: EXPENSE_WORKFLOW_PROMPT,
      toolsId,
    },
    create: {
      id: 'e0d1ebe7-2b78-4bc4-8a3a-fa5c2bb00b06',
      name: 'expense',
      triggerCode: 'manual',
      description: 'Phase 4: LangGraph expense workflow with multi-turn confirmation',
      prompt: EXPENSE_WORKFLOW_PROMPT,
      toolsId,
    },
  });

  console.log('✓ Seeded 1 workflow: expense (triggerCode: manual)');
}
