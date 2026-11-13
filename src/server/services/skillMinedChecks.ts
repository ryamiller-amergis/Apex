/**
 * Promptfoo checks mined from reviewer corrections. When most corrections of a stage's documents
 * add a `## Heading` the original lacked (and the built-in suite does not require), that heading
 * is proposed as a check. Without a stored original, every heading in the corrected copy counts.
 * Nothing changes until a person accepts it; accepted checks join the stage's suite for that project.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { skillMinedChecks } from '../db/schema';
import type { WorkflowEvaluationPromptfooTest } from '../../shared/types/aiRunV2EvaluationSpec';
import {
  WORKFLOW_EVALUATION_DESIGN_DOC_STAGE_KEY,
  WORKFLOW_EVALUATION_PRD_STAGE_KEY,
  workflowEvaluationPromptfooSuiteRef,
} from '../../shared/types/workflowEvaluation';
import type { SkillMinedCheck, SkillMinedCheckDecision } from '../../shared/types/skillExperiment';
import { getWorkflowEvaluationSuite } from './workflowEvaluationSuites';
import { type CorrectionPair, diffCorrection, headingKey, headingsOf, loadStageCorrections } from './skillCorrections';

export { headingsOf };

export const MINED_STAGE_KEYS = [
  WORKFLOW_EVALUATION_PRD_STAGE_KEY,
  WORKFLOW_EVALUATION_DESIGN_DOC_STAGE_KEY,
  'test_cases_human_review',
] as const;
export const MIN_SUPPORT = 3;
export const MIN_SHARE = 0.6;
const LOOKBACK_DAYS = 180;
/** Each correction costs up to two Blob reads. */
const EVENTS_PER_STAGE = 60;
const CORRECTIONS_CACHE_MS = 10 * 60_000;

const correctionsCache = new Map<string, { at: number; pairs: CorrectionPair[] }>();

async function stageCorrections(project: string, stageKey: string, now: number): Promise<CorrectionPair[]> {
  const cacheKey = `${project}\u0000${stageKey}`;
  const cached = correctionsCache.get(cacheKey);
  if (cached && now - cached.at < CORRECTIONS_CACHE_MS) return cached.pairs;
  const since = new Date(now - LOOKBACK_DAYS * 24 * 60 * 60_000).toISOString();
  const pairs = await loadStageCorrections(project, stageKey, since, EVENTS_PER_STAGE);
  correctionsCache.set(cacheKey, { at: now, pairs });
  return pairs;
}

export function clearMinedChecksCache(): void {
  correctionsCache.clear();
}

/** Headings the reviewer added, or every heading when the original is unknown. */
export function correctionHeadings(pair: Pick<CorrectionPair, 'original' | 'corrected'>): string[] {
  return pair.original === null ? headingsOf(pair.corrected) : diffCorrection(pair.original, pair.corrected).addedHeadings;
}

/** `## X` headings the stage's built-in suite already requires. */
export function requiredHeadings(stageKey: string): Set<string> {
  const suite = getWorkflowEvaluationSuite(workflowEvaluationPromptfooSuiteRef(stageKey));
  const required = new Set<string>();
  for (const test of suite?.tests ?? []) {
    for (const assertion of test.assert) {
      const values = Array.isArray(assertion.value) ? assertion.value : [assertion.value];
      for (const value of values) {
        const match = typeof value === 'string' ? /^##\s+(.+)$/.exec(value) : null;
        if (match) required.add(headingKey(match[1]));
      }
    }
  }
  return required;
}

export function mineHeadingProposals(
  corrections: ReadonlyArray<Pick<CorrectionPair, 'original' | 'corrected'>>,
  required: ReadonlySet<string>,
): Array<{ heading: string; support: number; share: number }> {
  if (corrections.length === 0) return [];
  const counts = new Map<string, { heading: string; support: number }>();
  for (const pair of corrections) {
    for (const heading of correctionHeadings(pair)) {
      const key = headingKey(heading);
      if (required.has(key)) continue;
      const entry = counts.get(key) ?? { heading, support: 0 };
      entry.support += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()]
    .map((entry) => ({ ...entry, share: entry.support / corrections.length }))
    .filter((entry) => entry.support >= MIN_SUPPORT && entry.share >= MIN_SHARE)
    .sort((a, b) => b.support - a.support || a.heading.localeCompare(b.heading));
}

export function minedTest(heading: string): WorkflowEvaluationPromptfooTest {
  return {
    description: `Has the "${heading}" section (learned from reviewer corrections)`,
    target: 'artifact',
    assert: [{ type: 'icontains', value: `## ${heading}` }],
  };
}

export async function listMinedChecks(project: string, now = Date.now()): Promise<SkillMinedCheck[]> {
  const decisions = await db.select().from(skillMinedChecks).where(eq(skillMinedChecks.project, project));
  const checks: SkillMinedCheck[] = [];
  for (const stageKey of MINED_STAGE_KEYS) {
    const pairs = await stageCorrections(project, stageKey, now);
    const stageDecisions = decisions.filter((d) => d.stageKey === stageKey);
    const decided = new Map(stageDecisions.map((d) => [headingKey(d.heading), d]));
    for (const proposal of mineHeadingProposals(pairs, requiredHeadings(stageKey))) {
      const decision = decided.get(headingKey(proposal.heading));
      checks.push({ stageKey, ...proposal, corrections: pairs.length, status: decision?.status ?? 'proposed' });
      decided.delete(headingKey(proposal.heading));
    }
    for (const decision of decided.values()) {
      checks.push({
        stageKey,
        heading: decision.heading,
        support: decision.support,
        share: null,
        corrections: pairs.length,
        status: decision.status,
      });
    }
  }
  return checks;
}

export async function decideMinedCheck(
  project: string,
  userId: string,
  input: { stageKey: string; heading: string; support: number; decision: SkillMinedCheckDecision },
): Promise<void> {
  const now = new Date().toISOString();
  await db.insert(skillMinedChecks)
    .values({
      project,
      stageKey: input.stageKey,
      heading: input.heading.trim(),
      status: input.decision,
      support: input.support,
      decidedBy: userId,
      decidedAt: now,
    })
    .onConflictDoUpdate({
      target: [skillMinedChecks.project, skillMinedChecks.stageKey, skillMinedChecks.heading],
      set: { status: input.decision, support: input.support, decidedBy: userId, decidedAt: now },
    });
}

/** Accepted mined checks for one stage, as Promptfoo tests. */
export async function loadAcceptedMinedTests(project: string, stageKey: string): Promise<WorkflowEvaluationPromptfooTest[]> {
  const rows = await db.select({ heading: skillMinedChecks.heading })
    .from(skillMinedChecks)
    .where(and(
      eq(skillMinedChecks.project, project),
      eq(skillMinedChecks.stageKey, stageKey),
      eq(skillMinedChecks.status, 'accepted'),
    ));
  return rows.map((row) => minedTest(row.heading)).sort((a, b) => a.description.localeCompare(b.description));
}
