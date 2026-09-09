/**
 * Artifact cycle time medians for the Agent Home dashboard (FEAT-001 / TBI-002,
 * PBI-002).
 *
 * Per artifact type: the median days from the artifact's `created_at` to its own
 * frozen done event in `artifact_done_events`, over events that landed inside the
 * trailing 90 days. Reading the frozen event is what makes the number stable — a
 * later edit, re-approval, or regeneration cannot move a median, and nothing here
 * reads `updated_at`.
 *
 * Deliberately independent of the Incomplete Pipeline stall rules (BR-007): an
 * Interview's cycle time ends at Mark Complete even while it is still stalled
 * waiting on a PRD, so this module imports nothing from
 * `pipelineArtifactStatusService`.
 *
 * Events are only written from the migration forward (no backfill), so artifacts
 * that reached their done state earlier stay outside the population.
 */

import { and, eq, gte } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  artifactDoneEvents,
  designDocs,
  designPrototypes,
  interviews,
  prds,
  testCases,
} from '../db/schema';
import { computeMedianDays, type DurationSample } from './medianDuration';
import type { ArtifactCycleTimeData, CycleTimeKpi } from '../../shared/types/homeDashboard';

const WINDOW_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const emptyKpi = (): CycleTimeKpi => ({
  medianDays: null,
  sampleSize: 0,
  windowDays: WINDOW_DAYS,
});

/** One type's source failed. S7/S10 render this KPI as unavailable; siblings keep their values. */
const unavailableKpi = (): CycleTimeKpi => ({ ...emptyKpi(), unavailable: true });

const kpiFrom = (samples: DurationSample[]): CycleTimeKpi => ({
  medianDays: computeMedianDays(samples),
  sampleSize: samples.length,
  windowDays: WINDOW_DAYS,
});

function interviewSamples(project: string, windowStart: string): Promise<DurationSample[]> {
  return db
    .select({ createdAt: interviews.createdAt, doneAt: artifactDoneEvents.doneAt })
    .from(artifactDoneEvents)
    .innerJoin(interviews, eq(interviews.id, artifactDoneEvents.artifactId))
    .where(
      and(
        eq(artifactDoneEvents.artifactType, 'interview'),
        gte(artifactDoneEvents.doneAt, windowStart),
        eq(interviews.project, project),
      ),
    );
}

function prdSamples(project: string, windowStart: string): Promise<DurationSample[]> {
  return db
    .select({ createdAt: prds.createdAt, doneAt: artifactDoneEvents.doneAt })
    .from(artifactDoneEvents)
    .innerJoin(prds, eq(prds.id, artifactDoneEvents.artifactId))
    .where(
      and(
        eq(artifactDoneEvents.artifactType, 'prd'),
        gte(artifactDoneEvents.doneAt, windowStart),
        eq(prds.project, project),
      ),
    );
}

/** `test_cases` carries no project column — scope comes from its parent PRD. */
function testCaseSamples(project: string, windowStart: string): Promise<DurationSample[]> {
  return db
    .select({ createdAt: testCases.createdAt, doneAt: artifactDoneEvents.doneAt })
    .from(artifactDoneEvents)
    .innerJoin(testCases, eq(testCases.id, artifactDoneEvents.artifactId))
    .innerJoin(prds, eq(prds.id, testCases.prdId))
    .where(
      and(
        eq(artifactDoneEvents.artifactType, 'test_case'),
        gte(artifactDoneEvents.doneAt, windowStart),
        eq(prds.project, project),
      ),
    );
}

/** `design_prototypes` carries no project column — scope comes from its parent PRD. */
function designPrototypeSamples(project: string, windowStart: string): Promise<DurationSample[]> {
  return db
    .select({ createdAt: designPrototypes.createdAt, doneAt: artifactDoneEvents.doneAt })
    .from(artifactDoneEvents)
    .innerJoin(designPrototypes, eq(designPrototypes.id, artifactDoneEvents.artifactId))
    .innerJoin(prds, eq(prds.id, designPrototypes.prdId))
    .where(
      and(
        eq(artifactDoneEvents.artifactType, 'design_prototype'),
        gte(artifactDoneEvents.doneAt, windowStart),
        eq(prds.project, project),
      ),
    );
}

function designDocSamples(project: string, windowStart: string): Promise<DurationSample[]> {
  return db
    .select({ createdAt: designDocs.createdAt, doneAt: artifactDoneEvents.doneAt })
    .from(artifactDoneEvents)
    .innerJoin(designDocs, eq(designDocs.id, artifactDoneEvents.artifactId))
    .where(
      and(
        eq(artifactDoneEvents.artifactType, 'design_doc'),
        gte(artifactDoneEvents.doneAt, windowStart),
        eq(designDocs.project, project),
      ),
    );
}

/**
 * BR-005: there is no project-level prototype setting, so the project counts as
 * prototype-enabled when any of its Interviews enables the stage. Every Interview
 * disabled — including a project with no Interviews — hides the KPI (U-4).
 */
async function prototypeStageEnabled(project: string): Promise<boolean> {
  const rows = await db
    .select({ id: interviews.id })
    .from(interviews)
    .where(and(eq(interviews.project, project), eq(interviews.prototypeStageEnabled, true)))
    .limit(1);
  return rows.length > 0;
}

async function kpiFor(
  type: string,
  load: () => Promise<DurationSample[]>,
): Promise<CycleTimeKpi> {
  try {
    return kpiFrom(await load());
  } catch (err) {
    console.error(`[artifactCycleTime] ${type} median query failed:`, err);
    return unavailableKpi();
  }
}

/** Null means the KPI is omitted per BR-005, not that it failed. */
async function prototypeKpi(project: string, windowStart: string): Promise<CycleTimeKpi | null> {
  let enabled: boolean;
  try {
    enabled = await prototypeStageEnabled(project);
  } catch (err) {
    console.error('[artifactCycleTime] prototype stage lookup failed:', err);
    return unavailableKpi();
  }
  if (!enabled) return null;
  return kpiFor('design_prototype', () => designPrototypeSamples(project, windowStart));
}

/**
 * Median creation-to-done days per artifact type for one project.
 *
 * @param now Evaluation instant for the trailing window; injectable so a
 * recomputation over the same events is reproducible.
 */
export async function getMedians(
  project: string,
  now: Date = new Date(),
): Promise<ArtifactCycleTimeData> {
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * MS_PER_DAY).toISOString();

  const [interview, prd, testCase, prototype, designDoc] = await Promise.all([
    kpiFor('interview', () => interviewSamples(project, windowStart)),
    kpiFor('prd', () => prdSamples(project, windowStart)),
    kpiFor('test_case', () => testCaseSamples(project, windowStart)),
    prototypeKpi(project, windowStart),
    kpiFor('design_doc', () => designDocSamples(project, windowStart)),
  ]);

  const data: ArtifactCycleTimeData = { interview, prd, testCase, designDoc };
  if (prototype) data.prototype = prototype;
  return data;
}
