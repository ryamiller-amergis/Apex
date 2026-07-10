import 'dotenv/config';
import { db } from '../src/server/db/drizzle';
import { aiUsageEvents } from '../src/server/db/schema';
import { desc } from 'drizzle-orm';

async function main() {
  const rows = await db.select().from(aiUsageEvents).orderBy(desc(aiUsageEvents.createdAt)).limit(10);
  if (rows.length === 0) {
    console.log('No rows in ai_usage_events yet.');
  } else {
    console.log(`Found ${rows.length} row(s):`);
    rows.forEach((r, i) => {
      console.log(`\n[${i + 1}] ${r.feature} | ${r.provider} | ${r.modelId}`);
      console.log(`     cost: $${r.costUsd} (${r.costSource}) | tokens: ${r.inputTokens}in ${r.outputTokens}out | source: ${r.tokenSource}`);
      console.log(`     project: ${r.project} | status: ${r.status} | at: ${r.createdAt}`);
    });
  }
}

main().catch(console.error);
