import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent, Cursor } from '@cursor/sdk';
import type { EffortLevel } from '../../shared/types/effort';
import {
  isCursorModelBlockedMessage,
  resolveAvailableModelId,
} from '../../shared/utils/modelAvailability';
import {
  effortParameterFor,
  supportedEffortLevelsFor,
  type CursorModelParam,
  type CursorModelParameterDefinition,
} from './agentEffortResolver';

export interface AvailableModel {
  id: string;
  displayName: string;
  /** Effort levels accepted by this model per live `Cursor.models.list()` parameters. */
  supportedEffortLevels?: EffortLevel[];
  /** Raw parameter definitions from `Cursor.models.list()`. */
  parameters?: CursorModelParameterDefinition[];
}

export interface ResolvedCursorModelChoice {
  model: string;
  effort: EffortLevel | undefined;
  /**
   * Frozen Cursor SDK model parameters resolved from `Cursor.models.list()`.
   * Present when the catalog was consulted (`[]` means the model accepts no
   * effort parameter); omitted when the catalog was unavailable.
   */
  modelParams?: CursorModelParam[];
}

interface CatalogModel {
  id: string;
  displayName: string;
  parameters: CursorModelParameterDefinition[];
}

let catalogCache: CatalogModel[] | null = null;
let catalogCacheExpiry = 0;
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

/** Cursor lists `auto-smart` and `default` under the same name, "Auto". */
const HIDDEN_MODEL_IDS = new Set(['auto-smart']);

/**
 * `Cursor.models.list()` includes models the Cursor team admin has blocked;
 * only a run reports the block. Each listed model is sent a one-line prompt
 * on this schedule and hidden while it comes back blocked.
 */
const PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PROBE_RETRIGGER_MIN_GAP_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60 * 1000;
/**
 * Probe sequentially with a pause between models so background probing stays
 * well under Cursor's 30 req/min `get_models` rate limit and never starves
 * live user chats after a restart or deploy.
 */
const PROBE_CONCURRENCY = 1;
const DEFAULT_PROBE_DELAY_MS = process.env.NODE_ENV === 'test' ? 0 : 4_000;
const PROBE_PROMPT = 'Reply with the single word OK.';

let blockedModelIds = new Set<string>();
let lastProbeStartedAt = 0;
let probeInFlight: Promise<void> | null = null;
let probeDelayMs = DEFAULT_PROBE_DELAY_MS;

async function fetchModelCatalog(): Promise<CatalogModel[]> {
  const now = Date.now();
  if (catalogCache && now < catalogCacheExpiry) return catalogCache;

  try {
    const result = await Cursor.models.list();
    const models: CatalogModel[] = (result ?? []).map(
      (m: {
        id: string;
        displayName?: string;
        parameters?: CursorModelParameterDefinition[];
      }) => ({
        id: m.id,
        displayName: m.displayName ?? m.id,
        parameters: m.parameters ?? [],
      }),
    );
    catalogCache = models;
    catalogCacheExpiry = now + MODELS_CACHE_TTL_MS;
    return models;
  } catch {
    return catalogCache ?? [];
  }
}

export async function fetchAvailableModels(): Promise<AvailableModel[]> {
  const catalog = await fetchModelCatalog();
  scheduleModelProbe(catalog, PROBE_INTERVAL_MS);
  return catalog
    .filter((m) => !HIDDEN_MODEL_IDS.has(m.id) && !blockedModelIds.has(m.id))
    .map(({ id, displayName, parameters }) => ({
      id,
      displayName,
      supportedEffortLevels: supportedEffortLevelsFor(parameters),
      parameters,
    }));
}

/** The model's parameter definitions, or undefined when the catalog does not list it. */
export async function fetchModelParameters(
  model: string,
): Promise<CursorModelParameterDefinition[] | undefined> {
  return (await fetchModelCatalog()).find((m) => m.id === model)?.parameters;
}

/**
 * The model, effort, and exact Cursor SDK parameter pair a run should send.
 * A retired or blocked model falls back as `resolveAvailableModelId` describes.
 * Parameter names (`effort`, `reasoning_effort`, `reasoning`) are resolved from
 * the live `Cursor.models.list()` catalog so workers never guess.
 */
export async function resolveCursorModelChoice(
  model: string,
  effort: EffortLevel | undefined,
): Promise<ResolvedCursorModelChoice> {
  const resolvedModel = resolveAvailableModelId(model, await fetchAvailableModels());
  if (!effort) return { model: resolvedModel, effort: undefined };
  const parameters = await fetchModelParameters(resolvedModel);
  if (!parameters) return { model: resolvedModel, effort };
  const parameterId = effortParameterFor(parameters, effort);
  if (!parameterId) {
    return {
      model: resolvedModel,
      effort: undefined,
      modelParams: [],
    };
  }
  return {
    model: resolvedModel,
    effort,
    modelParams: [{ id: parameterId, value: effort }],
  };
}

/** Re-probe soon after a run reports a blocked model, instead of at the next scheduled probe. */
export function requestModelAvailabilityProbe(): void {
  void fetchModelCatalog().then((catalog) =>
    scheduleModelProbe(catalog, PROBE_RETRIGGER_MIN_GAP_MS),
  );
}

function scheduleModelProbe(catalog: CatalogModel[], minimumGapMs: number): void {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey || catalog.length === 0 || probeInFlight || runningProbeAttempts > 0) return;
  if (Date.now() - lastProbeStartedAt < minimumGapMs) return;
  lastProbeStartedAt = Date.now();
  probeInFlight = probeModels(
    apiKey,
    catalog.filter((m) => !HIDDEN_MODEL_IDS.has(m.id)),
  )
    .catch((error: unknown) => {
      console.warn('[modelsService] Model availability probe failed:', errorMessage(error));
    })
    .finally(() => {
      probeInFlight = null;
    });
}

function isCursorRateLimitMessage(message: string): boolean {
  return /rate[_ ]limit/i.test(message);
}

function delayProbe(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function probeModels(apiKey: string, models: CatalogModel[]): Promise<void> {
  const blocked = new Set(blockedModelIds);
  const queue = [...models];
  let roundStopped = false;
  const probeNext = async (): Promise<void> => {
    for (let model = queue.shift(); model && !roundStopped; model = queue.shift()) {
      const outcome = await probeModel(apiKey, model.id);
      if (outcome === 'timed-out' || outcome === 'rate-limited') {
        roundStopped = true;
        break;
      }
      if (outcome === 'blocked') blocked.add(model.id);
      if (outcome === 'available') blocked.delete(model.id);
      if (queue.length > 0 && probeDelayMs > 0) {
        await delayProbe(probeDelayMs);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, probeNext),
  );
  blockedModelIds = blocked;
}

type ProbeOutcome = 'available' | 'blocked' | 'unknown' | 'timed-out' | 'rate-limited';

/**
 * Attempts still running after a timeout. A new round waits for them, so a
 * hung `Agent.create` cannot pile up agents across rounds.
 */
let runningProbeAttempts = 0;

async function probeModel(apiKey: string, id: string): Promise<ProbeOutcome> {
  let timedOut = false;
  let agent: { [Symbol.asyncDispose](): Promise<void> } | undefined;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ProbeOutcome>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      void agent?.[Symbol.asyncDispose]().catch(() => {});
      resolve('timed-out');
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
  runningProbeAttempts += 1;
  const attempt = (async (): Promise<ProbeOutcome> => {
    let workspace: string | undefined;
    try {
      workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'apex-model-probe-'));
      const created = await Agent.create({
        apiKey,
        model: { id },
        local: { cwd: workspace },
        mcpServers: {},
      });
      agent = created;
      if (timedOut) return 'timed-out';
      const result = await (await created.send(PROBE_PROMPT)).wait();
      if (result.status === 'finished') return 'available';
      const detail = errorMessage(result.error);
      if (isCursorRateLimitMessage(detail)) return 'rate-limited';
      return isCursorModelBlockedMessage(detail) ? 'blocked' : 'unknown';
    } catch (error) {
      const detail = errorMessage(error);
      if (isCursorRateLimitMessage(detail)) return 'rate-limited';
      return isCursorModelBlockedMessage(detail) ? 'blocked' : 'unknown';
    } finally {
      await agent?.[Symbol.asyncDispose]().catch(() => {});
      if (workspace) await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
      runningProbeAttempts -= 1;
    }
  })();
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error ?? '');
}

export function resetModelsServiceForTests(): void {
  catalogCache = null;
  catalogCacheExpiry = 0;
  blockedModelIds = new Set();
  lastProbeStartedAt = 0;
  probeInFlight = null;
  runningProbeAttempts = 0;
  probeDelayMs = DEFAULT_PROBE_DELAY_MS;
}

export function setModelProbeDelayMsForTests(ms: number): void {
  probeDelayMs = ms;
}

export function modelProbeInFlightForTests(): Promise<void> | null {
  return probeInFlight;
}
