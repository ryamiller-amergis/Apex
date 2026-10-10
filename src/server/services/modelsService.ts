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
  type CursorModelParameterDefinition,
} from './agentEffortResolver';

export interface AvailableModel {
  id: string;
  displayName: string;
}

interface CatalogModel extends AvailableModel {
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
const PROBE_CONCURRENCY = 3;
const PROBE_PROMPT = 'Reply with the single word OK.';

let blockedModelIds = new Set<string>();
let lastProbeStartedAt = 0;
let probeInFlight: Promise<void> | null = null;

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
    .map(({ id, displayName }) => ({ id, displayName }));
}

/** The model's parameter definitions, or undefined when the catalog does not list it. */
export async function fetchModelParameters(
  model: string,
): Promise<CursorModelParameterDefinition[] | undefined> {
  return (await fetchModelCatalog()).find((m) => m.id === model)?.parameters;
}

/**
 * The model and effort a run should send. A retired or blocked model falls
 * back as `resolveAvailableModelId` describes. Workers send the effort under
 * the `effort` parameter without reading the catalog, so it is dropped when
 * the resolved model takes effort under another name or not at all.
 */
export async function resolveCursorModelChoice(
  model: string,
  effort: EffortLevel | undefined,
): Promise<{ model: string; effort: EffortLevel | undefined }> {
  const resolvedModel = resolveAvailableModelId(model, await fetchAvailableModels());
  if (!effort) return { model: resolvedModel, effort };
  const parameters = await fetchModelParameters(resolvedModel);
  if (!parameters) return { model: resolvedModel, effort };
  return {
    model: resolvedModel,
    effort: effortParameterFor(parameters, effort) === 'effort' ? effort : undefined,
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

async function probeModels(apiKey: string, models: CatalogModel[]): Promise<void> {
  const blocked = new Set(blockedModelIds);
  const queue = [...models];
  let roundTimedOut = false;
  const probeNext = async (): Promise<void> => {
    for (let model = queue.shift(); model && !roundTimedOut; model = queue.shift()) {
      const outcome = await probeModel(apiKey, model.id);
      if (outcome === 'timed-out') roundTimedOut = true;
      if (outcome === 'blocked') blocked.add(model.id);
      if (outcome === 'available') blocked.delete(model.id);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, probeNext),
  );
  blockedModelIds = blocked;
}

type ProbeOutcome = 'available' | 'blocked' | 'unknown' | 'timed-out';

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
      return isCursorModelBlockedMessage(errorMessage(result.error)) ? 'blocked' : 'unknown';
    } catch (error) {
      return isCursorModelBlockedMessage(errorMessage(error)) ? 'blocked' : 'unknown';
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
}

export function modelProbeInFlightForTests(): Promise<void> | null {
  return probeInFlight;
}
