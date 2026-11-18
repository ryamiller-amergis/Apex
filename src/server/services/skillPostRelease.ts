/**
 * After a Skill change is promoted, compare live documents made with the new SKILL.md against
 * documents made with the old one. The repository file keeps its own line endings, so the new
 * version is matched by both its LF and CRLF hashes.
 */
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { designDocs, prds, skillExperiments } from '../db/schema';
import type {
  SkillExperimentSubjectType,
  SkillPostReleaseArm,
  SkillPostReleaseReport,
  SkillPostReleaseStatus,
} from '../../shared/types/skillExperiment';
import { meanInterval, wilsonInterval } from './skillLearningStats';
import { skillContentSha256 } from './skillReplaySpec';
import { createNotification } from './notificationService';

export const POST_RELEASE_MIN_DOCUMENTS = 10;
/** How long after promotion the sweep keeps checking a change. */
const WATCH_WINDOW_MS = 60 * 24 * 60 * 60_000;
const ACCEPTED_STATUSES = ['approved', 'reviewer_approved'];

export interface LiveDocument {
  sha: string | null;
  status: string;
  validationScore: number | null;
}

export function candidateShas(candidateContent: string): string[] {
  const lf = candidateContent.replace(/\r\n/g, '\n');
  return [...new Set([skillContentSha256(candidateContent), skillContentSha256(lf), skillContentSha256(lf.replace(/\n/g, '\r\n'))])];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function summarizeArm(docs: readonly LiveDocument[]): SkillPostReleaseArm {
  const scores = docs.map((d) => d.validationScore).filter((s): s is number => typeof s === 'number');
  const accepted = docs.filter((d) => ACCEPTED_STATUSES.includes(d.status)).length;
  const scoreInterval = meanInterval(scores);
  const acceptanceInterval = wilsonInterval(accepted, docs.length);
  return {
    documents: docs.length,
    averageScore: scores.length ? round(scores.reduce((s, v) => s + v, 0) / scores.length) : null,
    scoreInterval: scoreInterval && { low: round(scoreInterval.low), high: round(scoreInterval.high) },
    acceptanceRate: docs.length ? round(accepted / docs.length) : null,
    acceptanceInterval: acceptanceInterval && { low: round(acceptanceInterval.low), high: round(acceptanceInterval.high) },
  };
}

export function postReleaseStatus(baseline: SkillPostReleaseArm, candidate: SkillPostReleaseArm): SkillPostReleaseStatus {
  if (candidate.documents === 0) return 'waiting';
  if (candidate.documents < POST_RELEASE_MIN_DOCUMENTS || baseline.documents < POST_RELEASE_MIN_DOCUMENTS) return 'collecting';
  const scoreDropped = !!(candidate.scoreInterval && baseline.scoreInterval
    && candidate.scoreInterval.high < baseline.scoreInterval.low);
  const acceptanceDropped = !!(candidate.acceptanceInterval && baseline.acceptanceInterval
    && candidate.acceptanceInterval.high < baseline.acceptanceInterval.low);
  return scoreDropped || acceptanceDropped ? 'regressed' : 'holding';
}

async function loadLiveDocuments(
  project: string,
  subjectType: SkillExperimentSubjectType,
  shas: string[],
  since: string,
): Promise<LiveDocument[]> {
  const table = subjectType === 'prd' ? prds : designDocs;
  return db.select({ sha: table.skillSha256, status: table.status, validationScore: table.validationScore })
    .from(table)
    .where(and(eq(table.project, project), inArray(table.skillSha256, shas), gte(table.createdAt, since)));
}

export async function buildPostReleaseReport(experiment: {
  project: string;
  subjectType: SkillExperimentSubjectType;
  baselineSha256: string;
  candidateContent: string;
  updatedAt: string;
}): Promise<SkillPostReleaseReport> {
  const baselineSince = new Date(Date.parse(experiment.updatedAt) - 90 * 24 * 60 * 60_000).toISOString();
  const [baselineDocs, candidateDocs] = await Promise.all([
    loadLiveDocuments(experiment.project, experiment.subjectType, [experiment.baselineSha256], baselineSince),
    loadLiveDocuments(experiment.project, experiment.subjectType, candidateShas(experiment.candidateContent), baselineSince),
  ]);
  const baseline = summarizeArm(baselineDocs);
  const candidate = summarizeArm(candidateDocs);
  return { status: postReleaseStatus(baseline, candidate), minimumDocuments: POST_RELEASE_MIN_DOCUMENTS, baseline, candidate };
}

/** Alerts the experiment owner once when a promoted change does worse in live use. */
export async function sweepPostRelease(now = Date.now()): Promise<void> {
  const since = new Date(now - WATCH_WINDOW_MS).toISOString();
  const promoted = await db.select().from(skillExperiments)
    .where(and(eq(skillExperiments.status, 'promoted'), gte(skillExperiments.updatedAt, since), sql`${skillExperiments.pullRequestUrl} IS NOT NULL`));
  for (const experiment of promoted) {
    if (experiment.candidateContent === null) continue;
    const report = await buildPostReleaseReport({ ...experiment, candidateContent: experiment.candidateContent });
    if (report.status !== 'regressed') continue;
    await createNotification(experiment.createdBy, {
      type: 'ai',
      title: 'A promoted Skill change is doing worse in live use',
      body: `${experiment.skillPath}: live score ${report.candidate.averageScore ?? '—'} vs ${report.baseline.averageScore ?? '—'}, `
        + `acceptance ${report.candidate.acceptanceRate ?? '—'} vs ${report.baseline.acceptanceRate ?? '—'}.`,
      link: `/platform-admin/skill-health?experiment=${experiment.id}`,
    }, { dedupeKey: `skill-experiment-regressed:${experiment.id}` }).catch(() => undefined);
  }
}
