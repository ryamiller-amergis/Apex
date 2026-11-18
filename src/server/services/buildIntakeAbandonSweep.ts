/**
 * Records a Build intake as abandoned once its brief has sat unapproved (or was never drafted)
 * with no change for ABANDON_AFTER_MS. One signal per intake; the idempotency key keeps reruns quiet.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { BUILD_INTAKE_OPTION_KEY } from '../../shared/types/buildPreflight';
import { SKILL_LEARNING_FLAG } from '../../shared/types/featureFlags';
import { isFeatureEnabled, isFeatureOperational } from './featureFlagService';
import { recordSkillSignal } from './skillSignalService';

export const ABANDON_AFTER_MS = 14 * 24 * 60 * 60_000;
const BATCH = 100;

interface StaleIntakeRow {
  interview_id: string;
  project: string;
  author_id: string;
  brief_id: string | null;
  brief_version: number | null;
  last_activity: string;
}

export function abandonedIntakeKey(interviewId: string): string {
  return `abandoned:build_intake:${interviewId}`;
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) ?? [];
}

function staleCondition(cutoff: string) {
  return sql`i.playbook_profile_key = ${BUILD_INTAKE_OPTION_KEY}
      AND (b.id IS NULL OR b.status = 'draft')
      AND GREATEST(i.updated_at, COALESCE(b.updated_at, i.updated_at)) < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM skill_signals s WHERE s.idempotency_key = 'abandoned:build_intake:' || i.id::text
      )`;
}

export async function sweepAbandonedBuildIntakes(now = Date.now()): Promise<number> {
  if (!(await isFeatureOperational(SKILL_LEARNING_FLAG))) return 0;
  const cutoff = new Date(now - ABANDON_AFTER_MS).toISOString();
  const projectRows = rowsOf<{ project: string }>(await db.execute(sql`
    SELECT DISTINCT i.project FROM interviews i
    LEFT JOIN interview_briefs b ON b.interview_id = i.id
    WHERE ${staleCondition(cutoff)}
  `));
  const enabled: string[] = [];
  for (const { project } of projectRows) {
    if (await isFeatureEnabled(SKILL_LEARNING_FLAG, { userId: '', project })) enabled.push(project);
  }
  if (enabled.length === 0) return 0;

  const rows = rowsOf<StaleIntakeRow>(await db.execute(sql`
    SELECT i.id AS interview_id, i.project, i.author_id, b.id AS brief_id, b.version AS brief_version,
           GREATEST(i.updated_at, COALESCE(b.updated_at, i.updated_at)) AS last_activity
    FROM interviews i
    LEFT JOIN interview_briefs b ON b.interview_id = i.id
    WHERE ${staleCondition(cutoff)}
      AND i.project IN (${sql.join(enabled.map((p) => sql`${p}`), sql`, `)})
    ORDER BY i.updated_at
    LIMIT ${BATCH}
  `));
  let recorded = 0;
  for (const row of rows) {
    const written = await recordSkillSignal({
      project: row.project,
      surface: 'build_intake',
      subjectType: row.brief_id ? 'build_brief' : 'build_intake',
      subjectId: row.brief_id ?? row.interview_id,
      kind: 'abandoned',
      actorId: row.author_id,
      metadata: {
        interviewId: row.interview_id,
        briefVersion: row.brief_version,
        neverDrafted: row.brief_id === null,
        lastActivity: String(row.last_activity),
      },
      idempotencyKey: abandonedIntakeKey(row.interview_id),
    });
    if (written) recorded += 1;
  }
  return recorded;
}
