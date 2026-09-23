import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { uiLabDesigns } from '../db/schema';
import type { UiLabHistoryEntry } from '../../shared/types/uiLab';
import type { AiRunV2ArtifactManifest } from '../../shared/types/aiRunV2';
import { VISUAL_USAGE_FILE_NAME } from '../../shared/types/aiRunV2VisualSpec';
import { sanitizeMockHtml } from '../utils/htmlSanitizer';
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
import { UI_LAB_OUTPUT_PATH } from './aiRunV2/visualSpecificationBuilder';

const HARVEST_BATCH_SIZE = 100;

export type UiLabHarvestDesign = Readonly<{
  id: string;
  title: string;
  prompt: string;
  generationStartedAt: string;
  status?: string;
  html?: string | null;
  generationError?: string | null;
}>;

type WaitingUiLabDesign = UiLabHarvestDesign;

type ReportedUsage = Readonly<{
  modelId: string;
  project: string;
  userId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs?: number;
  tokenSource: 'exact' | 'estimated';
}>;

export type UiLabHarvestDependencies = Readonly<{
  finishedAttempts?: FinishedAttemptReader;
  artifacts?: ArtifactReader;
  batchSize?: number;
  loadDesign?: (designId: string) => Promise<UiLabHarvestDesign | null>;
}>;

export type UiLabRunHarvestResult =
  | Readonly<{
      status: 'settled';
      outcome: 'ready';
      html: string;
    }>
  | Readonly<{
      status: 'settled';
      outcome: 'failed';
      error: string;
    }>
  | Readonly<{ status: 'pending' }>
  | Readonly<{ status: 'superseded' }>
  | Readonly<{ status: 'already_harvested' }>;

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseUsage(body: string): ReportedUsage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ArtifactVerificationError('Artifact usage.json is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ArtifactVerificationError('Artifact usage.json is not an object');
  }
  const usage = parsed as Record<string, unknown>;
  if (
    typeof usage.modelId !== 'string'
    || !usage.modelId.trim()
    || usage.feature !== 'ui-lab'
    || typeof usage.project !== 'string'
    || !usage.project.trim()
    || !isNonNegativeNumber(usage.inputTokens)
    || !isNonNegativeNumber(usage.outputTokens)
    || (
      usage.cacheReadTokens !== undefined
      && !isNonNegativeNumber(usage.cacheReadTokens)
    )
    || (
      usage.cacheWriteTokens !== undefined
      && !isNonNegativeNumber(usage.cacheWriteTokens)
    )
    || (
      usage.durationMs !== undefined
      && !isNonNegativeNumber(usage.durationMs)
    )
    || (
      usage.tokenSource !== undefined
      && usage.tokenSource !== 'exact'
      && usage.tokenSource !== 'estimated'
    )
  ) {
    throw new ArtifactVerificationError(
      'Artifact usage.json does not match the UI Lab usage contract',
    );
  }
  return {
    modelId: usage.modelId,
    project: usage.project,
    userId: typeof usage.userId === 'string' ? usage.userId : undefined,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens:
      isNonNegativeNumber(usage.cacheReadTokens) ? usage.cacheReadTokens : 0,
    cacheWriteTokens:
      isNonNegativeNumber(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0,
    durationMs:
      isNonNegativeNumber(usage.durationMs) ? usage.durationMs : undefined,
    tokenSource:
      usage.tokenSource === 'estimated' ? 'estimated' : 'exact',
  };
}

async function readUsage(
  artifacts: ArtifactReader,
  manifest: AiRunV2ArtifactManifest,
): Promise<ReportedUsage> {
  if (!manifest.files.some((file) => file.path === VISUAL_USAGE_FILE_NAME)) {
    throw new ArtifactVerificationError(
      `Artifact manifest has no file at ${VISUAL_USAGE_FILE_NAME}`,
    );
  }
  return parseUsage(
    await artifacts.readText(manifest, VISUAL_USAGE_FILE_NAME),
  );
}

async function applyHtml(
  design: WaitingUiLabDesign,
  html: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const historyEntry: UiLabHistoryEntry = {
    version: 1,
    html,
    prompt: design.prompt,
    createdAt: now,
  };
  const applied = await db
    .update(uiLabDesigns)
    .set({
      status: 'ready',
      html,
      version: 1,
      history: [historyEntry],
      generationError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(uiLabDesigns.id, design.id),
        eq(uiLabDesigns.status, 'streaming'),
        eq(uiLabDesigns.updatedAt, design.generationStartedAt),
      ),
    )
    .returning({ id: uiLabDesigns.id });
  return applied.length === 1;
}

async function failDesign(
  design: WaitingUiLabDesign,
  reason: string,
): Promise<boolean> {
  const failed = await db
    .update(uiLabDesigns)
    .set({
      status: 'generation_failed',
      generationError: reason,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(uiLabDesigns.id, design.id),
        eq(uiLabDesigns.status, 'streaming'),
        eq(uiLabDesigns.updatedAt, design.generationStartedAt),
      ),
    )
    .returning({ id: uiLabDesigns.id });
  return failed.length === 1;
}

async function recordUsage(
  usage: ReportedUsage,
  runId: string,
): Promise<void> {
  try {
    const costUsd = await computeCost({
      provider: 'bedrock',
      modelId: usage.modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    });
    await recordAiUsage({
      provider: 'bedrock',
      modelId: usage.modelId,
      feature: 'ui-lab',
      project: usage.project,
      userId: usage.userId,
      runId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      tokenSource: usage.tokenSource,
      costUsd,
      costSource:
        usage.tokenSource === 'exact' ? 'computed' : 'estimated',
      durationMs: usage.durationMs,
      status: 'success',
    });
  } catch {
    // Usage reporting cannot roll back HTML already applied to the design.
  }
}

function failureReason(attempt: FinishedV2Attempt): string {
  const detail = attempt.failureDetail?.trim();
  if (attempt.status === 'cancelled') {
    return detail
      ? `Generation was cancelled: ${detail}`
      : 'Generation was cancelled. Click Retry to run it again.';
  }
  return detail ?? 'Generation failed. Click Retry to run it again.';
}

function attemptOwnsDesign(
  design: WaitingUiLabDesign,
  attempt: FinishedV2Attempt,
): boolean {
  return (
    attempt.generationOwner?.subjectId === design.id
    && Number.isFinite(Date.parse(design.generationStartedAt))
    && Date.parse(design.generationStartedAt)
      === Date.parse(attempt.generationOwner.generationStartedAt)
  );
}

async function harvestOne(
  design: WaitingUiLabDesign,
  attempt: FinishedV2Attempt,
  finishedAttempts: FinishedAttemptReader,
  artifacts: ArtifactReader,
): Promise<UiLabRunHarvestResult> {
  if ((await finishedAttempts.claimHarvest(attempt)) === 'already_harvested') {
    return { status: 'already_harvested' };
  }
  if (!attemptOwnsDesign(design, attempt)) {
    await finishedAttempts.completeHarvest(attempt.attemptId);
    return { status: 'superseded' };
  }

  if (attempt.status !== 'completed') {
    const error = failureReason(attempt);
    await failDesign(design, error);
    await finishedAttempts.completeHarvest(attempt.attemptId);
    return { status: 'settled', outcome: 'failed', error };
  }
  if (!attempt.manifestRef) {
    const error =
      'The generation run finished without producing a design. Click Retry to run it again.';
    await failDesign(
      design,
      error,
    );
    await finishedAttempts.completeHarvest(attempt.attemptId);
    return { status: 'settled', outcome: 'failed', error };
  }

  let html: string;
  let usage: ReportedUsage;
  try {
    const manifest = await artifacts.readManifest(attempt.manifestRef);
    html = sanitizeMockHtml(
      await artifacts.readText(manifest, UI_LAB_OUTPUT_PATH),
    );
    usage = await readUsage(artifacts, manifest);
  } catch (error) {
    if (!(error instanceof ArtifactVerificationError)) throw error;
    const detail =
      `The generated design could not be verified (${error.message}). Click Retry to run it again.`;
    await failDesign(
      design,
      detail,
    );
    await finishedAttempts.completeHarvest(attempt.attemptId);
    return { status: 'settled', outcome: 'failed', error: detail };
  }

  if (await applyHtml(design, html)) {
    await recordUsage(usage, attempt.runId);
  }
  await finishedAttempts.completeHarvest(attempt.attemptId);
  return { status: 'settled', outcome: 'ready', html };
}

async function waitingDesigns(
  limit: number,
): Promise<WaitingUiLabDesign[]> {
  return db
    .select({
      id: uiLabDesigns.id,
      title: uiLabDesigns.title,
      prompt: uiLabDesigns.prompt,
      generationStartedAt: uiLabDesigns.updatedAt,
    })
    .from(uiLabDesigns)
    .where(eq(uiLabDesigns.status, 'streaming'))
    .orderBy(asc(uiLabDesigns.updatedAt))
    .limit(limit);
}

async function loadUiLabDesignForHarvest(
  designId: string,
): Promise<UiLabHarvestDesign | null> {
  const rows = await db
    .select({
      id: uiLabDesigns.id,
      title: uiLabDesigns.title,
      prompt: uiLabDesigns.prompt,
      generationStartedAt: uiLabDesigns.updatedAt,
      status: uiLabDesigns.status,
      html: uiLabDesigns.html,
      generationError: uiLabDesigns.generationError,
    })
    .from(uiLabDesigns)
    .where(eq(uiLabDesigns.id, designId))
    .limit(1);
  return rows[0] ?? null;
}

export async function harvestUiLabV2Run(
  input: Readonly<{
    designId: string;
    runId: string;
    generationStartedAt: string;
  }>,
  dependencies: UiLabHarvestDependencies = {},
): Promise<UiLabRunHarvestResult> {
  const waiting = await (
    dependencies.loadDesign ?? loadUiLabDesignForHarvest
  )(input.designId);
  if (!waiting) return { status: 'already_harvested' };
  if (waiting.status === 'ready' && typeof waiting.html === 'string') {
    return { status: 'settled', outcome: 'ready', html: waiting.html };
  }
  if (waiting.status === 'generation_failed') {
    return {
      status: 'settled',
      outcome: 'failed',
      error: waiting.generationError ?? 'Generation failed',
    };
  }
  if (waiting.status && waiting.status !== 'streaming') {
    return { status: 'already_harvested' };
  }
  if (
    Date.parse(waiting.generationStartedAt)
    !== Date.parse(input.generationStartedAt)
  ) {
    return { status: 'superseded' };
  }
  const finishedAttempts =
    dependencies.finishedAttempts ?? createFinishedAttemptReader();
  const byThread = await finishedAttempts.listFinishedByThread([
    visualRunThreadId('ui-lab-screen', waiting.id),
  ]);
  const attempt = byThread.get(visualRunThreadId('ui-lab-screen', waiting.id));
  if (!attempt || attempt.runId !== input.runId) return { status: 'pending' };
  return harvestOne(
    waiting,
    attempt,
    finishedAttempts,
    dependencies.artifacts ?? createArtifactReader(),
  );
}

export async function harvestFinishedV2UiLabDesigns(
  dependencies: UiLabHarvestDependencies = {},
): Promise<number> {
  const waiting = await waitingDesigns(
    dependencies.batchSize ?? HARVEST_BATCH_SIZE,
  );
  if (waiting.length === 0) return 0;
  const finishedAttempts =
    dependencies.finishedAttempts ?? createFinishedAttemptReader();
  const artifacts = dependencies.artifacts ?? createArtifactReader();
  const byThread = await finishedAttempts.listFinishedByThread(
    waiting.map((design) => visualRunThreadId('ui-lab-screen', design.id)),
  );
  let settled = 0;
  for (const design of waiting) {
    const attempt = byThread.get(
      visualRunThreadId('ui-lab-screen', design.id),
    );
    if (!attempt) continue;
    try {
      const result = await harvestOne(
        design,
        attempt,
        finishedAttempts,
        artifacts,
      );
      if (result.status === 'settled') settled += 1;
    } catch (error) {
      console.error(
        `[uiLabV2Harvest] Could not apply run ${attempt.runId} to design ${design.id}:`,
        error,
      );
    }
  }
  return settled;
}
