/**
 * The Product Owner digest's AI synthesis runs on the V2 document worker as an
 * `observability-po-digest` run. App Service queries the telemetry, freezes the skill and the
 * rollup on the specification, and admits the run; the document harvest stores the checked
 * result in `observability_po_digest_runs`.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { observabilityPoDigestRuns } from '../db/schema';
import type { EffortLevel } from '../../shared/types/effort';
import {
  OBSERVABILITY_PO_DIGEST_RESULT_FILE,
  OBSERVABILITY_PO_DIGEST_SCRATCH_PATHS,
  type AiRunV2DocumentSpecification,
} from '../../shared/types/aiRunV2DocumentSpec';
import {
  OBSERVABILITY_PO_SKILL_PATH,
  type ObservabilityAdoptionSummary,
  type ObservabilityDigestSlot,
  type ObservabilityDropReasonsSummary,
  type ObservabilityDynamicSkillSection,
  type ObservabilityDynamicSkillSectionItem,
  type ObservabilityPoDigestRunStatus,
  type ObservabilityPoSkillSynthesis,
  type ObservabilityTrendWindow,
} from '../../shared/types/observability';
import {
  extractSynthesisSuggestions,
  mergeSynthesisSuggestions,
} from '../../shared/utils/observabilityPoDigest';
import { createV2AdmissionService } from './aiRunV2/v2AdmissionService';

const THREAD_PREFIX = 'observability-po-digest:';
const DEADLINE_MS = 10 * 60_000;
const QUEUE_ALLOWANCE_MS = 30 * 60_000;

const PROMPT = [
  'Follow the skill. Read `.ai-pilot/observability-po-digest/telemetry-rollup.md` and `.ai-pilot/observability-po-digest/output-schema.json`.',
  `Write exactly one file: \`.ai-pilot/output/${OBSERVABILITY_PO_DIGEST_RESULT_FILE}\`, a JSON object that matches the schema.`,
  'Do not read, search or change anything else, and do not use any tool that reaches outside the workspace.',
].join('\n');

const OBJECT_LIST = { type: 'array', items: { type: 'object' } } as const;

/** Extra telemetry arrays from the skill's full contract are accepted and ignored. */
export const OBSERVABILITY_PO_DIGEST_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'dropReasonsSummary', 'adoptionRecommendations'],
  properties: {
    headline: { type: 'string', minLength: 1 },
    dropReasonsSummary: {
      type: 'object',
      required: ['headline', 'narrative', 'findings'],
      properties: {
        headline: { type: 'string' },
        narrative: { type: 'string' },
        findings: OBJECT_LIST,
      },
    },
    adoptionRecommendations: {
      type: 'object',
      required: ['headline', 'narrative', 'recommendations'],
      properties: {
        headline: { type: 'string' },
        narrative: { type: 'string' },
        recommendations: OBJECT_LIST,
      },
    },
    customSections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          items: OBJECT_LIST,
        },
      },
    },
    topUsers: OBJECT_LIST,
    commonExceptions: OBJECT_LIST,
    moduleRetentionDrops: OBJECT_LIST,
    topModules: OBJECT_LIST,
  },
};

export function observabilityPoDigestThreadId(project: string, window: ObservabilityTrendWindow): string {
  return `${THREAD_PREFIX}${project}:${window}`;
}

export function ownsObservabilityPoDigestThread(threadId: string): boolean {
  return threadId.startsWith(THREAD_PREFIX);
}

export interface ObservabilityPoDigestRunRequest {
  project: string;
  window: ObservabilityTrendWindow;
  slot: ObservabilityDigestSlot;
  model: string;
  effort: EffortLevel;
  skillMarkdown: string;
  telemetryInput: string;
  previousSuggestions: ObservabilityDynamicSkillSectionItem[];
}

export interface ObservabilityPoDigestRunRecord {
  runId: string;
  project: string;
  window: ObservabilityTrendWindow;
  slot: ObservabilityDigestSlot;
  model: string;
  effort: EffortLevel;
  status: ObservabilityPoDigestRunStatus;
  previousSuggestions: ObservabilityDynamicSkillSectionItem[];
  synthesis: ObservabilityPoSkillSynthesis | null;
  failureDetail: string | null;
  requestedAt: string;
  completedAt: string | null;
}

/** The run never reached the document worker. The message is safe to show. */
export class ObservabilityPoDigestQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObservabilityPoDigestQueueError';
  }
}

export type ObservabilityPoDigestRunStart =
  | { status: 'admitted'; runId: string }
  | { status: 'already_running'; runId: string }
  | { status: 'not_started'; reason: string };

export interface ObservabilityPoDigestRunStore {
  start(request: ObservabilityPoDigestRunRequest): Promise<ObservabilityPoDigestRunStart>;
  latestRun(project: string, window: ObservabilityTrendWindow): Promise<ObservabilityPoDigestRunRecord | null>;
  latestCompleted(project: string, window: ObservabilityTrendWindow): Promise<ObservabilityPoDigestRunRecord | null>;
}

/** The suggestion baseline the next run and the page start from. */
export function trackedSuggestionsOf(
  run: ObservabilityPoDigestRunRecord | null,
): ObservabilityDynamicSkillSectionItem[] {
  if (!run) return [];
  const stored = extractSynthesisSuggestions(run.synthesis);
  return stored.length > 0 ? stored : run.previousSuggestions;
}

export function buildObservabilityPoDigestSpecification(
  request: ObservabilityPoDigestRunRequest,
): AiRunV2DocumentSpecification {
  return {
    workloadLane: 'document',
    prompt: PROMPT,
    model: request.model,
    effort: request.effort,
    skillPath: OBSERVABILITY_PO_SKILL_PATH,
    skillContent: request.skillMarkdown,
    skillSha256: createHash('sha256').update(request.skillMarkdown, 'utf8').digest('hex'),
    workflowClass: 'observability-po-digest',
    projectId: request.project,
    threadId: observabilityPoDigestThreadId(request.project, request.window),
    deadlineMs: DEADLINE_MS,
    scratchInputs: [
      { path: OBSERVABILITY_PO_DIGEST_SCRATCH_PATHS.input, content: request.telemetryInput },
      {
        path: OBSERVABILITY_PO_DIGEST_SCRATCH_PATHS.outputSchema,
        content: JSON.stringify(OBSERVABILITY_PO_DIGEST_OUTPUT_SCHEMA, null, 2),
      },
    ],
    outputSchema: OBSERVABILITY_PO_DIGEST_OUTPUT_SCHEMA,
  };
}

type RunRow = typeof observabilityPoDigestRuns.$inferSelect;

function toRecord(row: RunRow): ObservabilityPoDigestRunRecord {
  return {
    runId: row.runId,
    project: row.project,
    window: row.trendWindow,
    slot: row.slot,
    model: row.model,
    effort: row.effort,
    status: row.status,
    previousSuggestions: row.previousSuggestions ?? [],
    synthesis: row.synthesis ?? null,
    failureDetail: row.failureDetail ?? null,
    requestedAt: row.requestedAt,
    completedAt: row.completedAt ?? null,
  };
}

export function createObservabilityPoDigestRunStore(): ObservabilityPoDigestRunStore {
  const admission = createV2AdmissionService();

  return {
    async start(request) {
      const specification = buildObservabilityPoDigestSpecification(request);
      const runId = randomUUID();
      // The row exists before the run so the harvest always finds it.
      await db.insert(observabilityPoDigestRuns).values({
        runId,
        project: request.project,
        trendWindow: request.window,
        slot: request.slot,
        model: request.model,
        effort: request.effort,
        previousSuggestions: request.previousSuggestions,
      });
      try {
        const admitted = await admission.admit({
          runId,
          threadId: specification.threadId,
          projectId: request.project,
          workloadLane: 'document',
          capacityClass: 'batch',
          timeoutAt: new Date(Date.now() + QUEUE_ALLOWANCE_MS + specification.deadlineMs).toISOString(),
          specification: specification as unknown as Record<string, unknown>,
          executionSnapshot: {
            workflowClass: specification.workflowClass,
            projectId: request.project,
            model: specification.model,
            skillPath: specification.skillPath,
          },
        });
        if (admitted.status !== 'dispatched') {
          await db.delete(observabilityPoDigestRuns).where(eq(observabilityPoDigestRuns.runId, runId));
          return { status: 'already_running', runId: admitted.existingRunId };
        }
        return { status: 'admitted', runId };
      } catch (error) {
        await db.delete(observabilityPoDigestRuns).where(eq(observabilityPoDigestRuns.runId, runId));
        throw error;
      }
    },

    async latestRun(project, window) {
      const [row] = await db
        .select()
        .from(observabilityPoDigestRuns)
        .where(and(
          eq(observabilityPoDigestRuns.project, project),
          eq(observabilityPoDigestRuns.trendWindow, window),
        ))
        .orderBy(desc(observabilityPoDigestRuns.requestedAt))
        .limit(1);
      return row ? toRecord(row) : null;
    },

    async latestCompleted(project, window) {
      const [row] = await db
        .select()
        .from(observabilityPoDigestRuns)
        .where(and(
          eq(observabilityPoDigestRuns.project, project),
          eq(observabilityPoDigestRuns.trendWindow, window),
          eq(observabilityPoDigestRuns.status, 'completed'),
        ))
        .orderBy(desc(observabilityPoDigestRuns.completedAt))
        .limit(1);
      return row ? toRecord(row) : null;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Keeps only the parts of the worker's JSON the digest renders. */
export function toObservabilityPoSkillSynthesis(parsed: Record<string, unknown>): ObservabilityPoSkillSynthesis {
  const dropReasons = parsed.dropReasonsSummary;
  const adoption = parsed.adoptionRecommendations;
  const sections = Array.isArray(parsed.customSections)
    ? parsed.customSections
    : Array.isArray(parsed.sections)
      ? parsed.sections
      : undefined;
  return {
    headline: typeof parsed.headline === 'string' ? parsed.headline : undefined,
    dropReasonsSummary:
      isRecord(dropReasons)
      && typeof dropReasons.headline === 'string'
      && Array.isArray(dropReasons.findings)
        ? (dropReasons as unknown as ObservabilityDropReasonsSummary)
        : undefined,
    adoptionRecommendations:
      isRecord(adoption)
      && typeof adoption.headline === 'string'
      && Array.isArray(adoption.recommendations)
        ? (adoption as unknown as ObservabilityAdoptionSummary)
        : undefined,
    customSections: sections as ObservabilityDynamicSkillSection[] | undefined,
  };
}

export async function applyObservabilityPoDigestCompleted(input: {
  runId: string;
  outputDir: string;
  now?: Date;
}): Promise<void> {
  const [row] = await db
    .select()
    .from(observabilityPoDigestRuns)
    .where(eq(observabilityPoDigestRuns.runId, input.runId))
    .limit(1);
  if (!row) {
    console.warn(`[observabilityPoDigest] run ${input.runId} has no digest row; result dropped`);
    return;
  }
  const parsed: unknown = JSON.parse(
    await fs.readFile(path.join(input.outputDir, OBSERVABILITY_PO_DIGEST_RESULT_FILE), 'utf8'),
  );
  if (!isRecord(parsed)) {
    throw new Error(`${OBSERVABILITY_PO_DIGEST_RESULT_FILE} is not a JSON object`);
  }
  const now = input.now ?? new Date();
  const { synthesis } = mergeSynthesisSuggestions({
    synthesis: toObservabilityPoSkillSynthesis(parsed),
    previous: row.previousSuggestions ?? [],
    now,
  });
  await db
    .update(observabilityPoDigestRuns)
    .set({ status: 'completed', synthesis, failureDetail: null, completedAt: now.toISOString() })
    .where(eq(observabilityPoDigestRuns.runId, input.runId));
}

export async function applyObservabilityPoDigestFailed(input: {
  runId: string;
  reason: string;
}): Promise<void> {
  await db
    .update(observabilityPoDigestRuns)
    .set({ status: 'failed', failureDetail: input.reason, completedAt: new Date().toISOString() })
    .where(eq(observabilityPoDigestRuns.runId, input.runId));
}
