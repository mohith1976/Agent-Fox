/**
 * Main seed file
 * Runs all seed scripts in sequence
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { seedWorkflows } from './workflows.seed';
import { seedTools } from './tools.seed';

// Initialize Prisma with pg adapter
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🌱 Starting database seeding...');

  try {
    // Seed workflows
    console.log('\n📋 Seeding workflows...');
    await seedWorkflows(prisma);

    // Seed tools
    console.log('\n🔧 Seeding tools...');
    await seedTools(prisma);

    console.log('\n✅ Database seeding completed successfully!');
  } catch (error) {
    console.error('\n❌ Error during seeding:', error);
    throw error;
  }
}

main()
  .catch((error) => {
    console.error('Fatal error during seeding:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
