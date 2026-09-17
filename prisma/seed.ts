/**
 * Prisma Seed Script (legacy entrypoint — canonical seed is prisma/seeds/index.seed.ts,
 * wired in prisma7.config.ts).
 *
 * Kept in sync so `tsx prisma/seed.ts` behaves identically.
 *
 * Usage:
 *   npx tsx prisma/seeds/index.seed.ts   (preferred)
 *   npx tsx prisma/seed.ts               (equivalent)
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { seedTools } from './seeds/tools.seed';
import { seedWorkflows } from './seeds/workflows.seed';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🌱 Starting database seed...\n');

  try {
    // Seed tools first (workflows reference tool PIDs)
    await seedTools(prisma);
    console.log();

    // Seed workflows
    await seedWorkflows(prisma);
    console.log();

    console.log('✅ Database seeding completed successfully!');
  } catch (error) {
    console.error('❌ Database seeding failed:');
    console.error(error);
    throw error;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
