import 'dotenv/config';
import { generateDailyBrief } from '../src/server/services/aiCostDailyBriefService';
import { db } from '../src/server/db/drizzle';
import { aiCostDailyBrief } from '../src/server/db/schema';
import { desc } from 'drizzle-orm';

async function main() {
  const project = process.argv[2] ?? 'MaxView';
  const type = (process.argv[3] as 'morning' | 'afternoon') ?? 'morning';

  console.log(`[brief] Generating ${type} brief for ${project}...`);
  await generateDailyBrief(project, type);
  console.log('[brief] Done. Latest brief:');

  const row = await db.query.aiCostDailyBrief.findFirst({
    where: undefined,
    orderBy: [desc(aiCostDailyBrief.generatedAt)],
  });

  console.log(`  headline: ${row?.headline}`);
  console.log(`  bullets: ${JSON.stringify(row?.keyBullets)}`);
  console.log(`  date: ${row?.briefDate} (${row?.briefType})`);
}

main().catch(console.error);
