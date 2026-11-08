/**
 * Reads the planner's plan file. The plan is JSON committed on the integration
 * branch, not a block in the agent's final message.
 */
import type { PlanViolation } from '../../../shared/buildPlanSchema';
import { redactText } from '../buildRedactionService';

export const PLANNER_STOPPED_MESSAGE = 'The planning agent stopped before it wrote a plan.';

export function buildPlanFilePath(buildRunId: string): string {
  return `.apex/build/${buildRunId}/plan.json`;
}

export function buildContextNotesPath(buildRunId: string): string {
  return `.apex/build/${buildRunId}/context-notes.md`;
}

export interface RedactedPlanFile {
  plan: unknown;
  redactionCount: number;
}

export type PlanFileParse =
  | { ok: true; redacted: RedactedPlanFile }
  | { ok: false; violation: PlanViolation };

export function parsePlanFile(text: string | null | undefined): PlanFileParse {
  if (text == null || text.trim() === '') {
    return { ok: false, violation: unreadable() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, violation: unreadable() };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, violation: unreadable() };
  }
  const redacted = redactPlanStrings(parsed);
  return { ok: true, redacted };
}

export function redactPlanStrings(value: unknown): RedactedPlanFile {
  let redactionCount = 0;
  function walk(current: unknown): unknown {
    if (typeof current === 'string') {
      const next = redactText(current);
      if (next !== current) redactionCount += 1;
      return next;
    }
    if (current === null || typeof current === 'boolean' || typeof current === 'number') return current;
    if (Array.isArray(current)) return current.map((entry) => walk(entry));
    if (current && typeof current === 'object') {
      const next: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(current)) {
        next[key] = walk(entry);
      }
      return next;
    }
    return current;
  }
  return { plan: walk(value), redactionCount };
}

function unreadable(): PlanViolation {
  return {
    code: 'invalid_value',
    message: PLANNER_STOPPED_MESSAGE,
  };
}
