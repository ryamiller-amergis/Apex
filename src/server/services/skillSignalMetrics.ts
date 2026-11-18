/**
 * Turns raw skill signals into per-surface metrics for Skill Health. Pure: the caller loads rows.
 *
 * Gate approvals count as accepted and gate rejections as rejected, so every surface reports the
 * same acceptance rate. Rates carry a Wilson interval because most surfaces see few decisions.
 */
import {
  SKILL_LEARNING_SURFACES,
  type SkillLearningSurface,
  type SkillSignalKind,
} from '../../shared/constants/skillLearningSurfaces';
import type {
  SkillHealthProjectSignals,
  SkillHealthSignalSurface,
  SkillHealthSignalVersion,
} from '../../shared/types/skillHealth';
import { MIN_VERSION_SAMPLE, wilsonInterval } from './skillLearningStats';

export interface SkillSignalRowInput {
  project: string;
  surface: SkillLearningSurface;
  kind: SkillSignalKind;
  value: number | null;
  skillSha256: string | null;
  metadata: Record<string, unknown> | null;
  subjectType?: string | null;
  subjectId?: string | null;
}

type Decision = 'accept' | 'reject' | null;

function decisionOf(kind: SkillSignalKind): Decision {
  switch (kind) {
    case 'accepted':
    case 'gate_approved':
      return 'accept';
    case 'rejected':
    case 'gate_rejected':
      return 'reject';
    case 'rating':
    case 'regenerated':
    case 'rolled_back':
    case 'handoff_completed':
    case 'handoff_failed':
    case 'run_failed':
    case 'completed':
    case 'abandoned':
    case 'judged':
      return null;
    default: {
      const unhandled: never = kind;
      throw new Error(`Unhandled skill signal kind: ${String(unhandled)}`);
    }
  }
}

function isFailure(kind: SkillSignalKind): boolean {
  return kind === 'run_failed' || kind === 'handoff_failed';
}

function isFinished(kind: SkillSignalKind): boolean {
  return isFailure(kind) || kind === 'completed' || kind === 'handoff_completed';
}

function wasEdited(row: SkillSignalRowInput): boolean {
  const meta = row.metadata ?? {};
  return meta.editedBeforeApply === true || meta.editedBeforeApprove === true;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function acceptance(rows: readonly SkillSignalRowInput[]) {
  let accepted = 0;
  let decisions = 0;
  for (const row of rows) {
    const decision = decisionOf(row.kind);
    if (decision === null) continue;
    decisions += 1;
    if (decision === 'accept') accepted += 1;
  }
  return {
    accepted,
    decisions,
    acceptanceRate: ratio(accepted, decisions),
    acceptanceInterval: wilsonInterval(accepted, decisions),
    sufficientSample: decisions >= MIN_VERSION_SAMPLE,
  };
}

function buildVersions(rows: readonly SkillSignalRowInput[]): SkillHealthSignalVersion[] {
  const byVersion = new Map<string | null, SkillSignalRowInput[]>();
  for (const row of rows) {
    const list = byVersion.get(row.skillSha256);
    if (list) list.push(row);
    else byVersion.set(row.skillSha256, [row]);
  }
  return [...byVersion.entries()]
    .map(([skillSha256, versionRows]) => {
      const { decisions, acceptanceRate, acceptanceInterval, sufficientSample } = acceptance(versionRows);
      return { skillSha256, decisions, acceptanceRate, acceptanceInterval, sufficientSample };
    })
    .filter((version) => version.decisions > 0)
    .sort((a, b) => b.decisions - a.decisions);
}

export function buildSignalSurface(
  surface: SkillLearningSurface,
  rows: readonly SkillSignalRowInput[],
): SkillHealthSignalSurface {
  const definition = SKILL_LEARNING_SURFACES.find((entry) => entry.key === surface);
  const counts: Partial<Record<SkillSignalKind, number>> = {};
  for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1;

  const { accepted, decisions, acceptanceRate, acceptanceInterval, sufficientSample } = acceptance(rows);
  const editedAccepts = rows.filter((row) => decisionOf(row.kind) === 'accept' && wasEdited(row)).length;
  const ratings = rows.filter((row) => row.kind === 'rating' && row.value !== null);
  const finished = rows.filter((row) => isFinished(row.kind));
  const judgedScores = rows.flatMap((row) => {
    const overall = row.kind === 'judged' ? row.metadata?.overall : undefined;
    return typeof overall === 'number' ? [overall] : [];
  });

  return {
    surface,
    label: definition?.label ?? surface,
    rubricEvaluated: definition?.rubricEvaluated ?? false,
    signals: rows.length,
    counts,
    decisions,
    acceptanceRate,
    acceptanceInterval,
    editedBeforeAcceptRate: ratio(editedAccepts, accepted),
    ratings: ratings.length,
    ratingScore: ratings.length > 0
      ? ratings.reduce((sum, row) => sum + (row.value ?? 0), 0) / ratings.length
      : null,
    regenerationsPerAccepted: ratio(counts.regenerated ?? 0, accepted),
    failureRate: ratio(finished.filter((row) => isFailure(row.kind)).length, finished.length),
    sufficientSample,
    judged: judgedScores.length,
    judgedScore: judgedScores.length > 0 ? judgedScores.reduce((sum, v) => sum + v, 0) / judgedScores.length : null,
    versions: buildVersions(rows),
  };
}

/** One project's signals. Surfaces with no signals are left out; `coverage` says how many that is. */
export function buildProjectSignals(rows: readonly SkillSignalRowInput[]): SkillHealthProjectSignals {
  const bySurface = new Map<SkillLearningSurface, SkillSignalRowInput[]>();
  for (const row of rows) {
    const list = bySurface.get(row.surface);
    if (list) list.push(row);
    else bySurface.set(row.surface, [row]);
  }
  const surfaces = SKILL_LEARNING_SURFACES
    .filter((entry) => bySurface.has(entry.key))
    .map((entry) => buildSignalSurface(entry.key, bySurface.get(entry.key) ?? []));
  return {
    surfaces,
    coverage: { active: surfaces.length, total: SKILL_LEARNING_SURFACES.length },
  };
}
