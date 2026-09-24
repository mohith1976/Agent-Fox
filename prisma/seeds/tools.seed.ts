/**
 * Tools Seed
 * 
 * Seeds the tool_definitions table with the expense workflow tools
 */

import { PrismaClient } from '@prisma/client';

export async function seedTools(prisma: PrismaClient) {
  console.log('Seeding tool_definitions...');

  const canonical = [
    {
      pid: 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d',
      name: 'Log Transaction',
      description: 'Writes batch of transactions to Excel workbook in S3',
      toolCode: 'log_transaction',
    },
    {
      pid: 'b2c3d4e5-f6a7-4b5c-8d7e-9f0a1b2c3d4e',
      name: 'Query Transactions',
      description: 'Reads and filters transactions from Excel workbook',
      toolCode: 'query_transactions',
    },
    {
      pid: 'c3d4e5f6-a7b8-4c5d-8e7f-9a0b1c2d3e4f',
      name: 'Generate Chart',
      description: 'Creates visualization chart as PNG image',
      toolCode: 'generate_chart',
    },
    {
      pid: 'd4e5f6a7-b8c9-4d6e-8f0a-1b2c3d4e5f60',
      name: 'Read Terminology',
      description: 'Reads user-defined category word lists from TERMINOLOGY sheet',
      toolCode: 'read_terminology',
    },
  ];

  // Self-healing: remove rows left by older seed versions (e.g. toolCode 'deterministic')
  // so agent_workflows.toolsId can never point at ghost/junk tools.
  const junk = await prisma.toolDefinition.deleteMany({
    where: { toolCode: { notIn: canonical.map((t) => t.toolCode) } },
  });
  if (junk.count > 0) {
    console.log(`✓ Removed ${junk.count} junk tool row(s) from older seeds`);
  }

  await prisma.toolDefinition.createMany({
    data: canonical,
    skipDuplicates: true,
  });

  console.log('✓ Seeded 4 tools: log_transaction, query_transactions, generate_chart, read_terminology');
}
