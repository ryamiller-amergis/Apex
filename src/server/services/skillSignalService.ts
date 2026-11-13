/**
 * Records Skill Learning signals from every covered surface. Callers are the
 * existing decision points (proposal applied, gate approved, handoff failed...),
 * so recording never throws into them: a failure is logged and dropped.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { chatThreads, skillSignals } from '../db/schema';
import { SKILL_LEARNING_FLAG } from '../../shared/types/featureFlags';
import { isEffortLevel, type EffortLevel } from '../../shared/types/effort';
import type { SkillLearningSurface, SkillSignalKind } from '../../shared/constants/skillLearningSurfaces';
import { isFeatureEnabled } from './featureFlagService';

export interface SkillSignalInput {
  project: string;
  surface: SkillLearningSurface;
  subjectType: string;
  subjectId: string;
  kind: SkillSignalKind;
  /** Chat thread that produced the output; its skill, model and effort are copied onto the signal. */
  threadId?: string | null;
  /** Only for `rating`: -1, 0 or 1. */
  value?: -1 | 0 | 1;
  actorId?: string | null;
  comment?: string | null;
  metadata?: Record<string, unknown>;
  /** Overrides thread provenance when the caller knows it directly. */
  provenance?: Partial<SkillSignalProvenance>;
  /** Same key records once; defaults to surface, kind, subject and actor. */
  idempotencyKey?: string;
}

export interface SkillSignalProvenance {
  skillPath: string | null;
  skillSha256: string | null;
  model: string | null;
  effort: EffortLevel | null;
}

const EMPTY_PROVENANCE: SkillSignalProvenance = { skillPath: null, skillSha256: null, model: null, effort: null };

export async function threadProvenance(threadId: string): Promise<SkillSignalProvenance> {
  const [row] = await db
    .select({ kickoff: chatThreads.kickoff, skillSha256: chatThreads.skillSha256 })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!row) return EMPTY_PROVENANCE;
  return {
    skillPath: row.kickoff.skillPath ?? null,
    skillSha256: row.skillSha256 ?? null,
    model: row.kickoff.model ?? null,
    effort: isEffortLevel(row.kickoff.effort) ? row.kickoff.effort : null,
  };
}

export function defaultSignalIdempotencyKey(input: SkillSignalInput): string {
  return [input.surface, input.kind, input.subjectType, input.subjectId, input.actorId ?? 'system'].join(':');
}

/** Returns true when a new signal row was written. */
export async function recordSkillSignal(input: SkillSignalInput): Promise<boolean> {
  try {
    // @feature-flag:skill-learning start winner=enabled
    if (!await isFeatureEnabled(SKILL_LEARNING_FLAG, { userId: input.actorId ?? '', project: input.project })) {
      // @feature-flag:skill-learning disabled-start
      return false;
      // @feature-flag:skill-learning disabled-end
    }
    // @feature-flag:skill-learning enabled-start
    const fromThread = input.threadId ? await threadProvenance(input.threadId) : EMPTY_PROVENANCE;
    const provenance = { ...fromThread, ...input.provenance };
    const rows = await db
      .insert(skillSignals)
      .values({
        project: input.project,
        surface: input.surface,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        threadId: input.threadId ?? null,
        skillPath: provenance.skillPath,
        skillSha256: provenance.skillSha256,
        model: provenance.model,
        effort: provenance.effort,
        kind: input.kind,
        value: input.kind === 'rating' ? (input.value ?? 0) : null,
        actorId: input.actorId ?? null,
        comment: input.comment ?? null,
        metadata: input.metadata ?? {},
        idempotencyKey: input.idempotencyKey ?? defaultSignalIdempotencyKey(input),
      })
      .onConflictDoNothing({ target: skillSignals.idempotencyKey })
      .returning({ id: skillSignals.id });
    return rows.length > 0;
    // @feature-flag:skill-learning enabled-end
    // @feature-flag:skill-learning end
  } catch (err) {
    console.error(`[skill-signal] record failed (surface=${input.surface}, kind=${input.kind}, subject=${input.subjectId})`, err);
    return false;
  }
}

/** Fire-and-forget form for request paths that must not wait on Skill Learning. */
export function emitSkillSignal(input: SkillSignalInput): void {
  void recordSkillSignal(input);
}

/**
 * Fire-and-forget form for callers that must look something up (usually the project) first.
 * `build` returning null skips the signal; a throw from `build` is logged, never rethrown.
 */
export function emitSkillSignalLater(label: string, build: () => Promise<SkillSignalInput | null>): void {
  build()
    .then((input) => (input ? recordSkillSignal(input) : false))
    .catch((err: unknown) => {
      console.error(`[skill-signal] could not build signal (${label})`, err);
    });
}
