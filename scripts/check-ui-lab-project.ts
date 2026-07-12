import 'dotenv/config';
import { db } from '../src/server/db/drizzle';
import { uiLabDesigns, aiUsageEvents } from '../src/server/db/schema';
import { desc, eq } from 'drizzle-orm';

async function main() {
  // Show recent UI Lab designs and their project values
  const designs = await db
    .select({ id: uiLabDesigns.id, project: uiLabDesigns.project, title: uiLabDesigns.title })
    .from(uiLabDesigns)
    .orderBy(desc(uiLabDesigns.createdAt))
    .limit(5);

  console.log('Recent UI Lab designs:');
  designs.forEach(d => console.log(`  id=${d.id} | project="${d.project}" | title="${d.title}"`));

  // Also show usage events
  const events = await db
    .select({ id: aiUsageEvents.id, project: aiUsageEvents.project, feature: aiUsageEvents.feature, provider: aiUsageEvents.provider })
    .from(aiUsageEvents)
    .orderBy(desc(aiUsageEvents.createdAt));

  console.log('\nai_usage_events:');
  events.forEach(e => console.log(`  project="${e.project}" | feature="${e.feature}" | provider="${e.provider}"`));
}

main().catch(console.error);
