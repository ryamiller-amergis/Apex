/**
 * Reviewer corrections paired with the document the reviewer saw. New corrections live only in
 * Blob storage (corrected_artifact_text is left null); the original comes from the regression
 * case snapshot, which exists only when the document had not changed by the time it was copied.
 */
import { and, desc, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { skillRegressionCases, workflowEvaluationEvents } from '../db/schema';
import type { AiRunBlobRef } from '../../shared/types/aiRunV2';
import { readCorrectedArtifact, readRegressionSnapshot, snapshotText } from './workflowEvaluationArtifactStore';

export interface CorrectionPair {
  eventId: string;
  /** Null when no snapshot was stored. */
  original: string | null;
  corrected: string;
}

export interface CorrectionDiff {
  addedHeadings: string[];
  removedHeadings: string[];
  addedLines: string[];
  removedLines: string[];
}

const READ_CONCURRENCY = 8;
const MAX_HEADING_CHARS = 80;

export function headingKey(heading: string): string {
  return heading.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Level-2 headings in markdown, once each, without trailing #s. */
export function headingsOf(text: string): string[] {
  const found = new Map<string, string>();
  for (const match of text.matchAll(/^##[ \t]+(.+?)[ \t#]*$/gm)) {
    const heading = match[1].trim();
    if (heading && heading.length <= MAX_HEADING_CHARS) found.set(headingKey(heading), heading);
  }
  return [...found.values()];
}

function contentLines(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0))];
}

/** Order-insensitive: a line counts as added when the original has no identical line. */
export function diffCorrection(original: string, corrected: string): CorrectionDiff {
  const originalHeadings = new Set(headingsOf(original).map(headingKey));
  const correctedHeadings = headingsOf(corrected);
  const correctedKeys = new Set(correctedHeadings.map(headingKey));
  const originalLines = contentLines(original);
  const correctedLines = contentLines(corrected);
  const originalSet = new Set(originalLines);
  const correctedSet = new Set(correctedLines);
  return {
    addedHeadings: correctedHeadings.filter((h) => !originalHeadings.has(headingKey(h))),
    removedHeadings: headingsOf(original).filter((h) => !correctedKeys.has(headingKey(h))),
    addedLines: correctedLines.filter((l) => !originalSet.has(l)),
    removedLines: originalLines.filter((l) => !correctedSet.has(l)),
  };
}

const MAX_DIFF_LINES = 20;

/** Null when the correction changed nothing line-for-line. */
export function formatCorrectionDiff(diff: CorrectionDiff): string | null {
  const parts = [
    diff.addedHeadings.length > 0 ? `Sections added: ${diff.addedHeadings.join('; ')}` : null,
    diff.removedHeadings.length > 0 ? `Sections removed: ${diff.removedHeadings.join('; ')}` : null,
    ...diff.addedLines.slice(0, MAX_DIFF_LINES).map((l) => `+ ${l}`),
    ...diff.removedLines.slice(0, MAX_DIFF_LINES).map((l) => `- ${l}`),
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join('\n') : null;
}

interface CorrectionRow {
  eventId: string;
  correctedText: string | null;
  correctedRef: AiRunBlobRef | null;
  originalRef: AiRunBlobRef | null;
}

async function loadPair(row: CorrectionRow): Promise<CorrectionPair | null> {
  try {
    const corrected = row.correctedText ?? (row.correctedRef ? await readCorrectedArtifact(row.correctedRef) : null);
    if (!corrected) return null;
    const original = row.originalRef ? snapshotText(await readRegressionSnapshot(row.originalRef)) : null;
    return { eventId: row.eventId, original, corrected };
  } catch (err) {
    console.warn(`[skill-learning] correction read failed (eventId=${row.eventId}):`, err instanceof Error ? err.message : err);
    return null;
  }
}

async function loadPairs(rows: readonly CorrectionRow[]): Promise<CorrectionPair[]> {
  const pairs: CorrectionPair[] = [];
  for (let i = 0; i < rows.length; i += READ_CONCURRENCY) {
    const batch = await Promise.all(rows.slice(i, i + READ_CONCURRENCY).map(loadPair));
    pairs.push(...batch.filter((p): p is CorrectionPair => p !== null));
  }
  return pairs;
}

const hasCorrection = or(
  isNotNull(workflowEvaluationEvents.correctedArtifactText),
  isNotNull(workflowEvaluationEvents.correctedArtifactBlobRef),
);

function correctionQuery() {
  return db.select({
    eventId: workflowEvaluationEvents.id,
    correctedText: workflowEvaluationEvents.correctedArtifactText,
    correctedRef: workflowEvaluationEvents.correctedArtifactBlobRef,
    originalRef: skillRegressionCases.originalBlobRef,
  })
    .from(workflowEvaluationEvents)
    .leftJoin(skillRegressionCases, and(
      eq(skillRegressionCases.eventId, workflowEvaluationEvents.id),
      sql`${skillRegressionCases.snapshotStatus} = 'stored'`,
    ));
}

/** The newest corrections for one stage. */
export async function loadStageCorrections(
  project: string,
  stageKey: string,
  since: string,
  limit: number,
): Promise<CorrectionPair[]> {
  const rows = await correctionQuery()
    .where(and(
      eq(workflowEvaluationEvents.project, project),
      eq(workflowEvaluationEvents.stageKey, stageKey),
      gte(workflowEvaluationEvents.createdAt, since),
      hasCorrection,
    ))
    .orderBy(desc(workflowEvaluationEvents.createdAt))
    .limit(limit);
  return loadPairs(rows);
}

/** Corrections for specific events, keyed by event id. */
export async function loadEventCorrections(eventIds: readonly string[]): Promise<Map<string, CorrectionPair>> {
  if (eventIds.length === 0) return new Map();
  const rows = await correctionQuery()
    .where(and(inArray(workflowEvaluationEvents.id, [...eventIds]), hasCorrection));
  return new Map((await loadPairs(rows)).map((p) => [p.eventId, p]));
}
