/**
 * The best few candidates tried so far for one Skill: those no other candidate beats on every
 * measure at once (overall change, each criterion, failure rate). Only experiments run against the
 * same current Skill are compared, because their score changes share a baseline.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { skillExperiments } from '../db/schema';
import type {
  SkillCandidateFrontierEntry,
  SkillExperimentStatus,
} from '../../shared/types/skillExperiment';

export const FRONTIER_SIZE = 5;
const SCANNED_EXPERIMENTS = 50;
const FINISHED: SkillExperimentStatus[] = ['completed', 'awaiting_approval', 'approved', 'rejected', 'promoted'];

function measures(entry: SkillCandidateFrontierEntry): number[] {
  const or = (v: number | null | undefined) => (typeof v === 'number' ? v : Number.NEGATIVE_INFINITY);
  return [
    or(entry.devMeanDiff),
    ...entry.criteria.map((c) => or(c.meanDiff)),
    entry.candidateFailureRate == null ? Number.NEGATIVE_INFINITY : -entry.candidateFailureRate,
  ];
}

function dominates(a: number[], b: number[]): boolean {
  let better = false;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? Number.NEGATIVE_INFINITY;
    const y = b[i] ?? Number.NEGATIVE_INFINITY;
    if (x < y) return false;
    if (x > y) better = true;
  }
  return better;
}

export function paretoFrontier(entries: readonly SkillCandidateFrontierEntry[], size = FRONTIER_SIZE): SkillCandidateFrontierEntry[] {
  const unique = [...new Map(entries.map((e) => [e.candidateSha256, e])).values()];
  const vectors = unique.map(measures);
  return unique
    .filter((_, i) => !vectors.some((other, j) => j !== i && dominates(other, vectors[i])))
    .sort((a, b) => (b.devMeanDiff ?? Number.NEGATIVE_INFINITY) - (a.devMeanDiff ?? Number.NEGATIVE_INFINITY))
    .slice(0, size);
}

export async function listCandidateFrontier(project: string, skillPath: string): Promise<SkillCandidateFrontierEntry[]> {
  const rows = await db.select().from(skillExperiments)
    .where(and(
      eq(skillExperiments.project, project),
      eq(skillExperiments.skillPath, skillPath),
      inArray(skillExperiments.status, FINISHED),
    ))
    .orderBy(desc(skillExperiments.createdAt))
    .limit(SCANNED_EXPERIMENTS);
  const scored = rows.filter((r) => r.result && r.result.verdict !== 'insufficient_data');
  if (scored.length === 0) return [];
  const baselineSha256 = scored[0].baselineSha256;
  return paretoFrontier(scored
    .filter((r) => r.baselineSha256 === baselineSha256)
    .flatMap((r) => (r.candidateContent !== null && r.candidateSha256 !== null
      ? [{ ...r, candidateContent: r.candidateContent, candidateSha256: r.candidateSha256 }]
      : []))
    .map((r) => ({
      experimentId: r.id,
      candidateSha256: r.candidateSha256,
      candidateSource: r.candidateSource,
      candidateContent: r.candidateContent,
      changeNotes: r.changeNotes,
      verdict: r.result!.verdict,
      devMeanDiff: r.result!.dev.meanDiff,
      criteria: r.result!.criteria,
      candidateFailureRate: r.result!.candidateFailureRate,
      createdAt: r.createdAt,
    })));
}
