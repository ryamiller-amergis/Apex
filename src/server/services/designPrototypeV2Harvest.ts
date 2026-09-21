/**
 * Closes the loop for prototypes generated on the durable V2 transport.
 *
 * A visual worker uploads `prototype.html` to Blob and the orchestrator
 * finalizes the attempt; neither of them knows what a prototype is, by
 * design. This is the other half: the owning service reads the manifest the
 * attempt recorded, verifies it, and writes the same row the in-process path
 * writes in `generateSinglePrototype`.
 *
 * Driven by the recovery sweep in `startupRecovery`, which already runs every
 * minute behind a single-owner lease and already resets prototypes orphaned in
 * `generating`. Harvesting there means a finished run is applied by whichever
 * instance holds the lease, not by the instance that happened to admit it.
 *
 * Exactly-once has two independent guards, because delivery is at least once
 * and a sweep can see the same finished attempt on consecutive cycles:
 *
 *  - a durable claim per attempt in `ai_run_inbox`, which also stops a
 *    superseded attempt being re-applied over a later in-process retry;
 *  - a compare-and-set on the prototype row, so the apply and the "has this
 *    already been applied?" question are answered by one statement. Only the
 *    writer that wins it records usage, so cost cannot be charged twice, and
 *    the history entry is a replacement rather than an append.
 */
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { designPrototypes } from '../db/schema';
import type { DesignPrototypeHistoryEntry } from '../../shared/types/designPrototype';
import { VISUAL_USAGE_FILE_NAME } from '../../shared/types/aiRunV2VisualSpec';
import type { AiRunV2ArtifactManifest } from '../../shared/types/aiRunV2';
import { sanitizeMockHtml } from '../utils/htmlSanitizer';
import { notifyAiCompletion } from './aiCompletionNotifier';
import { prototypeUsageCtx } from './artifactUsageContext';
import { computeCost, recordAiUsage } from './aiUsageService';
import {
  ArtifactVerificationError,
  createArtifactReader,
  type ArtifactReader,
} from './aiRunV2/artifactReader';
import {
  createFinishedAttemptReader,
  type FinishedAttemptReader,
  type FinishedV2Attempt,
} from './aiRunV2/finishedAttemptReader';
import { visualRunThreadId } from './aiRunV2/v2AdmissionService';
import { PROTOTYPE_OUTPUT_PATH } from './aiRunV2/visualSpecificationBuilder';

const HARVEST_BATCH_SIZE = 100;

export type PrototypeHarvestDependencies = Readonly<{
  finishedAttempts?: FinishedAttemptReader;
  artifacts?: ArtifactReader;
  batchSize?: number;
}>;

type TransientPrototype = Readonly<{ id: string; featureName: string }>;

/** What the visual worker wrote to `usage.json` when the model reported it. */
type ReportedUsage = Readonly<{
  modelId: string;
  project?: string;
  userId?: string;
  inputTokens: number;
  outputTokens: number;
  durationMs?: number;
}>;

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseReportedUsage(body: string): ReportedUsage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.modelId !== 'string' || !candidate.modelId.trim()) return null;
  if (
    !isNonNegativeNumber(candidate.inputTokens)
    || !isNonNegativeNumber(candidate.outputTokens)
  ) {
    return null;
  }
  return {
    modelId: candidate.modelId,
    project: typeof candidate.project === 'string' ? candidate.project : undefined,
    userId: typeof candidate.userId === 'string' ? candidate.userId : undefined,
    inputTokens: candidate.inputTokens,
    outputTokens: candidate.outputTokens,
    durationMs: isNonNegativeNumber(candidate.durationMs) ? candidate.durationMs : undefined,
  };
}

async function readReportedUsage(
  artifacts: ArtifactReader,
  manifest: AiRunV2ArtifactManifest,
): Promise<ReportedUsage | null> {
  // A model that reported no token counts produces no usage artifact.
  if (!manifest.files.some((file) => file.path === VISUAL_USAGE_FILE_NAME)) {
    return null;
  }
  return parseReportedUsage(await artifacts.readText(manifest, VISUAL_USAGE_FILE_NAME));
}

/**
 * The success write from `generateSinglePrototype`, guarded so that only the
 * first writer applies it. Restricted to `generating` on purpose: the V2 lane
 * admits initial generation only, and a version-1 replacement would discard a
 * regeneration's history.
 */
async function applyPrototypeHtml(
  prototypeId: string,
  html: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const historyEntry: DesignPrototypeHistoryEntry = { version: 1, html, createdAt: now };
  const applied = await db
    .update(designPrototypes)
    .set({
      mockHtml: html,
      mockVersion: 1,
      history: [historyEntry],
      status: 'pending_review',
      generationError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(designPrototypes.id, prototypeId),
        eq(designPrototypes.status, 'generating'),
      ),
    )
    .returning({ id: designPrototypes.id });
  return applied.length === 1;
}

async function failPrototype(prototypeId: string, reason: string): Promise<void> {
  await db
    .update(designPrototypes)
    .set({
      status: 'generation_failed',
      generationError: reason,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(designPrototypes.id, prototypeId),
        eq(designPrototypes.status, 'generating'),
      ),
    );
}

function recordReportedUsage(
  usage: ReportedUsage,
  prototypeId: string,
  runId: string,
): void {
  computeCost({
    provider: 'bedrock',
    modelId: usage.modelId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  })
    .then((costUsd) => {
      recordAiUsage({
        ...prototypeUsageCtx(usage.project, prototypeId),
        provider: 'bedrock',
        modelId: usage.modelId,
        userId: usage.userId,
        runId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        tokenSource: 'exact',
        costUsd,
        costSource: 'computed',
        durationMs: usage.durationMs,
        status: 'success',
      });
    })
    .catch(() => {
      // Cost reporting must never hold up an applied prototype.
    });
}

/** Terminal-status reason text, mirroring the in-process failure message. */
function failureReason(attempt: FinishedV2Attempt): string {
  const detail = attempt.failureDetail?.trim();
  if (attempt.status === 'cancelled') {
    return detail
      ? `Generation was cancelled: ${detail}`
      : 'Generation was cancelled. Click Retry to run it again.';
  }
  return detail ?? 'Generation failed on the durable transport. Click Retry to run it again.';
}

/** True when the attempt reached a settled outcome for this prototype. */
async function harvestOne(
  prototype: TransientPrototype,
  attempt: FinishedV2Attempt,
  artifacts: ArtifactReader,
): Promise<boolean> {
  if (attempt.status !== 'completed') {
    await failPrototype(prototype.id, failureReason(attempt));
    return true;
  }
  if (!attempt.manifestRef) {
    await failPrototype(
      prototype.id,
      'The generation run finished without producing a prototype. Click Retry to run it again.',
    );
    return true;
  }

  let html: string;
  let usage: ReportedUsage | null;
  try {
    const manifest = await artifacts.readManifest(attempt.manifestRef);
    html = sanitizeMockHtml(await artifacts.readText(manifest, PROTOTYPE_OUTPUT_PATH));
    usage = await readReportedUsage(artifacts, manifest);
  } catch (err) {
    if (err instanceof ArtifactVerificationError) {
      // The bytes will never match on a later read, so surface it instead of
      // leaving the prototype in `generating` until the staleness sweep.
      await failPrototype(
        prototype.id,
        `The generated prototype could not be verified (${err.message}). Click Retry to run it again.`,
      );
      return true;
    }
    throw err;
  }

  if (!(await applyPrototypeHtml(prototype.id, html))) {
    // Another writer moved the row first — its output stands, and recording
    // usage here would charge a prototype this attempt did not produce.
    return false;
  }

  if (usage) recordReportedUsage(usage, prototype.id, attempt.runId);
  notifyAiCompletion('design_prototype_generated', prototype.id, {
    title: prototype.featureName,
  }).catch((err) => {
    console.error(
      `[designPrototypeV2Harvest] AI notification failed (id=${prototype.id}):`,
      err,
    );
  });
  return true;
}

/**
 * Apply every finished V2 visual run whose prototype is still waiting.
 * Returns how many prototypes reached a settled status.
 */
export async function harvestFinishedV2Prototypes(
  dependencies: PrototypeHarvestDependencies = {},
): Promise<number> {
  const finishedAttempts =
    dependencies.finishedAttempts ?? createFinishedAttemptReader();
  const artifacts = dependencies.artifacts ?? createArtifactReader();

  // Keyed off the prototypes that are still waiting rather than off finished
  // attempts: the working set is then self-draining, because every harvest
  // moves its row out of `generating`.
  const waiting: TransientPrototype[] = await db
    .select({
      id: designPrototypes.id,
      featureName: designPrototypes.featureName,
    })
    .from(designPrototypes)
    .where(eq(designPrototypes.status, 'generating'))
    .orderBy(asc(designPrototypes.updatedAt))
    .limit(dependencies.batchSize ?? HARVEST_BATCH_SIZE);
  if (waiting.length === 0) return 0;

  const byThread = await finishedAttempts.listFinishedByThread(
    waiting.map((prototype) => visualRunThreadId('design-prototype', prototype.id)),
  );
  if (byThread.size === 0) return 0;

  let harvested = 0;
  for (const prototype of waiting) {
    const attempt = byThread.get(visualRunThreadId('design-prototype', prototype.id));
    if (!attempt) continue;

    try {
      if ((await finishedAttempts.claimHarvest(attempt)) === 'already_harvested') {
        continue;
      }
      if (await harvestOne(prototype, attempt, artifacts)) harvested += 1;
      await finishedAttempts.completeHarvest(attempt.attemptId);
    } catch (err) {
      // The claim stays open, so the next sweep retries this attempt.
      console.error(
        `[designPrototypeV2Harvest] Could not apply run ${attempt.runId} to prototype ${prototype.id}:`,
        err,
      );
    }
  }
  return harvested;
}
