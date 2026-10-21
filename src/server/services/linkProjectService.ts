import { eq, or, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  adrs,
  apexWorkItems,
  chatThreads,
  designDocs,
  designPlans,
  designPrototypes,
  devSessions,
  diagrams,
  featureRequests,
  interviews,
  loadTestRuns,
  loadTests,
  playbookRuns,
  prds,
  standupConfigs,
  standupSessions,
  uiLabDesigns,
} from '../db/schema';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function projectFrom(rows: Array<{ project: string | null }>): string | null {
  const project = rows[0]?.project?.trim();
  return project ? project : null;
}

async function projectForDesignSurface(id: string): Promise<string | null> {
  const direct = await db
    .select({ project: prds.project })
    .from(prds)
    .where(eq(prds.id, id))
    .limit(1);
  const directProject = projectFrom(direct);
  if (directProject) return directProject;

  const viaPrototype = await db
    .select({ project: prds.project })
    .from(designPrototypes)
    .innerJoin(prds, eq(designPrototypes.prdId, prds.id))
    .where(eq(designPrototypes.id, id))
    .limit(1);
  const prototypeProject = projectFrom(viaPrototype);
  if (prototypeProject) return prototypeProject;

  const viaPlan = await db
    .select({ project: prds.project })
    .from(designPlans)
    .innerJoin(prds, eq(designPlans.prdId, prds.id))
    .where(or(eq(designPlans.id, id), eq(designPlans.prdId, id)))
    .limit(1);
  return projectFrom(viaPlan);
}

/**
 * The project that owns a shared record, looked up by id alone.
 * Returns null when the id is not a record of that kind.
 */
export async function resolveLinkProject(kind: string, id: string): Promise<string | null> {
  if (!UUID_RE.test(id)) return null;

  switch (kind) {
    case 'adr':
      return projectFrom(await db.select({ project: adrs.project }).from(adrs).where(eq(adrs.id, id)).limit(1));
    case 'interview':
      return projectFrom(await db.select({ project: interviews.project }).from(interviews).where(eq(interviews.id, id)).limit(1));
    case 'prd':
    case 'design-prototype':
    case 'design-plan':
      return projectForDesignSurface(id);
    case 'design-doc':
      return projectFrom(await db.select({ project: designDocs.project }).from(designDocs).where(eq(designDocs.id, id)).limit(1));
    case 'ui-lab':
      return projectFrom(await db.select({ project: uiLabDesigns.project }).from(uiLabDesigns).where(eq(uiLabDesigns.id, id)).limit(1));
    case 'diagram':
      return projectFrom(await db.select({ project: diagrams.projectId }).from(diagrams).where(eq(diagrams.id, id)).limit(1));
    case 'load-test':
      return projectFrom(await db.select({ project: loadTests.projectId }).from(loadTests).where(eq(loadTests.id, id)).limit(1));
    case 'load-test-run':
      return projectFrom(await db.select({ project: loadTestRuns.projectId }).from(loadTestRuns).where(eq(loadTestRuns.id, id)).limit(1));
    case 'dev-session':
      return projectFrom(await db.select({ project: devSessions.project }).from(devSessions).where(eq(devSessions.id, id)).limit(1));
    case 'feature-request':
      return projectFrom(await db.select({ project: featureRequests.sourceProject }).from(featureRequests).where(eq(featureRequests.id, id)).limit(1));
    case 'work-item':
      return projectFrom(await db.select({ project: apexWorkItems.project }).from(apexWorkItems).where(eq(apexWorkItems.id, id)).limit(1));
    case 'playbook-run':
      return projectFrom(await db.select({ project: playbookRuns.project }).from(playbookRuns).where(eq(playbookRuns.id, id)).limit(1));
    case 'standup-session':
      return projectFrom(await db
        .select({ project: standupConfigs.project })
        .from(standupSessions)
        .innerJoin(standupConfigs, eq(standupSessions.configId, standupConfigs.id))
        .where(eq(standupSessions.id, id))
        .limit(1));
    case 'chat-thread':
      return projectFrom(await db
        .select({ project: sql<string | null>`${chatThreads.kickoff}->>'project'` })
        .from(chatThreads)
        .where(eq(chatThreads.id, id))
        .limit(1));
    default:
      return null;
  }
}
