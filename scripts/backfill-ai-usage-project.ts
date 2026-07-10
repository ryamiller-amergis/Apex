import 'dotenv/config';
import { db } from '../src/server/db/drizzle';
import { aiUsageEvents } from '../src/server/db/schema';
import { eq, desc } from 'drizzle-orm';

async function main() {
  // Show current state
  const before = await db.select().from(aiUsageEvents).orderBy(desc(aiUsageEvents.createdAt));
  console.log(`\nBefore: ${before.length} total rows`);
  before.forEach(r => console.log(`  [${r.project}] ${r.feature} | ${r.provider} | $${r.costUsd}`));

  // Backfill unknown project rows — update to MaxView
  const result = await db
    .update(aiUsageEvents)
    .set({ project: 'MaxView' })
    .where(eq(aiUsageEvents.project, 'unknown'))
    .returning({ id: aiUsageEvents.id });

  console.log(`\nUpdated ${result.length} row(s) from project='unknown' to project='MaxView'`);

  // Show updated state
  const after = await db.select().from(aiUsageEvents).orderBy(desc(aiUsageEvents.createdAt));
  console.log(`\nAfter:`);
  after.forEach(r => console.log(`  [${r.project}] ${r.feature} | ${r.provider} | $${r.costUsd}`));
}

main().catch(console.error);
