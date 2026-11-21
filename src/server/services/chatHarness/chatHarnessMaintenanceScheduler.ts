/**
 * Shared chat harness maintenance scheduler (S9 / TBI-013).
 *
 * Runs every 15 minutes under a single-flight guard:
 *  1. Nulls `chat_thread_commands.payload` for rows older than 24 hours in
 *     batches of 1,000 while keeping `command_id`, `kind`, `status`, `reason`,
 *     and `run_id` readable so purged rows still dedupe retries.
 *  2. Reconciles stale `accepted` commands older than 60 seconds whose thread
 *     has no active run:
 *     - `steer` becomes a follow-up send under the same `command_id` (`queued`,
 *       reason `'Turn had finished, sent as a new message'`) when payload text
 *       is present.
 *     - `summarize` and `cancel` (or payload-less stale steers) become
 *       `rejected` with reason `'Did not reach the agent'`.
 *
 * Logs counts only and emits `chat.harness.maintenance` telemetry — never logs
 * command payloads or user text.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import type { ChatThread } from '../../../shared/types/chat';
import {
  isHarnessCommandKind,
  isHarnessReceiptReason,
  isHarnessReceiptStatus,
} from '../../../shared/types/chatHarness';
import type { InteractiveTurnAcceptedResponse } from '../../../shared/types/durableInteractiveTurn';
import { loadFullThread } from '../chatThreadRepository';
import {
  durableInteractiveTurnService,
  DurableInteractiveTurnError,
  type AdmitDurableInteractiveTurnInput,
} from '../durableInteractiveTurnService';
import { trackEvent as defaultTrackEvent } from '../telemetry';
import { createSingleFlight, stuckAfterForInterval } from '../../utils/singleFlight';
import {
  resolveAreaProfile as defaultResolveAreaProfile,
  toFrozenHarnessSpec,
  type ResolveAreaProfileOptions,
  type ResolvedAreaProfile,
} from './areaProfileResolver';
import { inferHarnessAreaFromThread } from './chatHarnessCommandHandler';
import {
  chatHarnessCommandRepository,
  type ChatHarnessCommandRepository,
  type ChatHarnessCommandRow,
} from './chatHarnessCommandRepository';

export const CHAT_HARNESS_MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;
export const CHAT_HARNESS_PAYLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;
export const CHAT_HARNESS_STALE_ACCEPTED_MS = 60 * 1000;
export const CHAT_HARNESS_PAYLOAD_PURGE_BATCH_SIZE = 1_000;
const STALE_ACCEPTED_LIMIT = 200;
const INITIAL_STAGGER_MS = 2 * 60 * 1000;

export interface ChatHarnessMaintenanceResult {
  payloadsCleared: number;
  receiptsReconciled: number;
}

export interface ChatHarnessMaintenanceDeps {
  purgePayloadBatch?: (cutoffIso: string, batchSize: number) => Promise<number>;
  findStaleAcceptedCommands?: (
    cutoffIso: string,
    limit: number,
  ) => Promise<ChatHarnessCommandRow[]>;
  repository?: Pick<ChatHarnessCommandRepository, 'updateReceipt'>;
  loadThread?: (threadId: string) => Promise<ChatThread | null>;
  resolveAreaProfile?: (
    area: string,
    project: string,
    options?: ResolveAreaProfileOptions,
  ) => Promise<ResolvedAreaProfile>;
  admitTurn?: (
    input: AdmitDurableInteractiveTurnInput,
  ) => Promise<InteractiveTurnAcceptedResponse>;
  trackEvent?: (
    name: string,
    props?: Record<string, string>,
    measurements?: Record<string, number>,
  ) => void;
  logInfo?: (message: string) => void;
  logError?: (message: string) => void;
  now?: () => Date;
  batchSize?: number;
}

interface RawStaleCommandRow {
  id: string;
  thread_id: string;
  command_id: string;
  run_id: string | null;
  kind: string;
  status: string;
  reason: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function extractRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result &&
    typeof result === 'object' &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

async function defaultPurgePayloadBatch(
  cutoffIso: string,
  batchSize: number,
): Promise<number> {
  const result = await db.execute(sql`
    UPDATE chat_thread_commands
       SET payload = NULL,
           updated_at = NOW()
     WHERE id IN (
       SELECT id
         FROM chat_thread_commands
        WHERE payload IS NOT NULL
          AND created_at < ${cutoffIso}::timestamptz
        ORDER BY id
        LIMIT ${batchSize}
     )
    RETURNING id
  `);
  return extractRows<{ id: string }>(result).length;
}

async function defaultFindStaleAcceptedCommands(
  cutoffIso: string,
  limit: number,
): Promise<ChatHarnessCommandRow[]> {
  const result = await db.execute(sql`
    SELECT c.id,
           c.thread_id,
           c.command_id,
           c.run_id,
           c.kind,
           c.status,
           c.reason,
           c.payload,
           c.created_at,
           c.updated_at
      FROM chat_thread_commands c
     WHERE c.status = 'accepted'
       AND c.kind IN ('steer', 'summarize', 'cancel')
       AND c.updated_at < ${cutoffIso}::timestamptz
       AND NOT EXISTS (
         SELECT 1
           FROM agent_runs ar
          WHERE ar.thread_id = c.thread_id::text
            AND ar.status IN ('queued', 'dispatched', 'running')
       )
     ORDER BY c.updated_at ASC
     LIMIT ${limit}
  `);

  const rows: ChatHarnessCommandRow[] = [];
  for (const raw of extractRows<RawStaleCommandRow>(result)) {
    if (!isHarnessCommandKind(raw.kind) || !isHarnessReceiptStatus(raw.status)) {
      continue;
    }
    rows.push({
      id: raw.id,
      threadId: raw.thread_id,
      commandId: raw.command_id,
      runId: raw.run_id ?? null,
      kind: raw.kind,
      status: raw.status,
      reason:
        raw.reason && isHarnessReceiptReason(raw.reason) ? raw.reason : null,
      payload: raw.payload ?? null,
      createdAt:
        typeof raw.created_at === 'string'
          ? raw.created_at
          : new Date(raw.created_at).toISOString(),
      updatedAt:
        typeof raw.updated_at === 'string'
          ? raw.updated_at
          : new Date(raw.updated_at).toISOString(),
    });
  }
  return rows;
}

/**
 * Execute one deterministic maintenance pass:
 *  1) Batched 24h payload purge
 *  2) Stale >60s `accepted` receipt reconciliation
 */
export async function runChatHarnessMaintenanceTick(
  deps: ChatHarnessMaintenanceDeps = {},
): Promise<ChatHarnessMaintenanceResult> {
  const now = deps.now ?? (() => new Date());
  const batchSize = Math.max(
    1,
    deps.batchSize ?? CHAT_HARNESS_PAYLOAD_PURGE_BATCH_SIZE,
  );
  const purgeBatch = deps.purgePayloadBatch ?? defaultPurgePayloadBatch;
  const findStale =
    deps.findStaleAcceptedCommands ?? defaultFindStaleAcceptedCommands;
  const repository = deps.repository ?? chatHarnessCommandRepository;
  const loadThread = deps.loadThread ?? loadFullThread;
  const resolveProfile =
    deps.resolveAreaProfile ??
    ((area: string, project: string, options?: ResolveAreaProfileOptions) =>
      defaultResolveAreaProfile(area, project, undefined, options));
  const admitTurn =
    deps.admitTurn ??
    ((input: AdmitDurableInteractiveTurnInput) =>
      durableInteractiveTurnService.admit(input));
  const track = deps.trackEvent ?? defaultTrackEvent;
  const logInfo = deps.logInfo ?? ((msg: string) => console.log(msg));
  const logError = deps.logError ?? ((msg: string) => console.error(msg));

  const nowMs = now().getTime();

  // Task 1: Null payloads older than 24 hours in batches of `batchSize`
  const purgeCutoffIso = new Date(
    nowMs - CHAT_HARNESS_PAYLOAD_RETENTION_MS,
  ).toISOString();
  let payloadsCleared = 0;
  for (;;) {
    const clearedInBatch = await purgeBatch(purgeCutoffIso, batchSize);
    payloadsCleared += clearedInBatch;
    if (clearedInBatch < batchSize) break;
  }

  // Task 2: Reconcile stale `accepted` commands (>60s) with no active run
  const staleCutoffIso = new Date(
    nowMs - CHAT_HARNESS_STALE_ACCEPTED_MS,
  ).toISOString();
  const staleRows = await findStale(staleCutoffIso, STALE_ACCEPTED_LIMIT);
  let receiptsReconciled = 0;

  for (const row of staleRows) {
    if (row.kind === 'steer') {
      const text =
        row.payload && typeof row.payload.text === 'string' && row.payload.text.trim().length > 0
          ? row.payload.text
          : null;
      const thread = text ? await loadThread(row.threadId) : null;

      if (text && thread) {
        const userId =
          row.payload &&
          typeof row.payload.userId === 'string' &&
          row.payload.userId.trim().length > 0
            ? row.payload.userId
            : thread.userId;
        try {
          const area = inferHarnessAreaFromThread(thread);
          const resolved = await resolveProfile(area, thread.kickoff.project, {
            settingsId: thread.kickoff.skillSettingsId ?? undefined,
            skillPath: thread.kickoff.skillPath ?? null,
          });
          const admitted = await admitTurn({
            turnId: row.commandId,
            threadId: row.threadId,
            userId,
            workflowClass: resolved.workflowClass,
            text,
            modelOverride: resolved.model,
            effort: resolved.effort,
            harness: toFrozenHarnessSpec(resolved),
          });
          const updated = await repository.updateReceipt(
            row.threadId,
            row.commandId,
            {
              status: 'queued',
              reason: 'Turn had finished, sent as a new message',
              runId: admitted.runId,
              expectedStatus: 'accepted',
            },
          );
          if (updated) receiptsReconciled += 1;
          continue;
        } catch (err) {
          if (
            err instanceof DurableInteractiveTurnError &&
            err.code === 'TURN_ID_CONFLICT'
          ) {
            const updated = await repository.updateReceipt(
              row.threadId,
              row.commandId,
              {
                status: 'rejected',
                reason: 'Did not reach the agent',
                expectedStatus: 'accepted',
              },
            );
            if (updated) receiptsReconciled += 1;
            continue;
          }
          logError(
            `[ChatHarnessMaintenance] Failed to reconcile stale steer commandId=${row.commandId}: ${
              err instanceof Error ? err.name : 'UnknownError'
            }`,
          );
          continue;
        }
      }

      const updated = await repository.updateReceipt(
        row.threadId,
        row.commandId,
        {
          status: 'rejected',
          reason: 'Did not reach the agent',
          expectedStatus: 'accepted',
        },
      );
      if (updated) receiptsReconciled += 1;
      continue;
    }

    if (row.kind === 'summarize' || row.kind === 'cancel') {
      const updated = await repository.updateReceipt(
        row.threadId,
        row.commandId,
        {
          status: 'rejected',
          reason: 'Did not reach the agent',
          expectedStatus: 'accepted',
        },
      );
      if (updated) receiptsReconciled += 1;
    }
  }

  track(
    'chat.harness.maintenance',
    {},
    { payloadsCleared, receiptsReconciled },
  );
  logInfo(
    `[ChatHarnessMaintenance] tick complete: payloadsCleared=${payloadsCleared} receiptsReconciled=${receiptsReconciled}`,
  );

  return { payloadsCleared, receiptsReconciled };
}

export interface ChatHarnessMaintenanceScheduler {
  start(): void;
  stop(): void;
  runNow(): Promise<boolean>;
}

export function createChatHarnessMaintenanceScheduler(
  deps: ChatHarnessMaintenanceDeps = {},
): ChatHarnessMaintenanceScheduler {
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  const runGuard = createSingleFlight({
    name: 'ChatHarnessMaintenanceScheduler',
    stuckAfterMs: stuckAfterForInterval(CHAT_HARNESS_MAINTENANCE_INTERVAL_MS),
  });
  const logError = deps.logError ?? ((msg: string) => console.error(msg));

  const runNow = async (): Promise<boolean> => {
    return runGuard.run(async () => {
      try {
        await runChatHarnessMaintenanceTick(deps);
      } catch (err) {
        logError(
          `[ChatHarnessMaintenance] tick failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
  };

  return {
    start() {
      if (intervalId) return;
      initialTimer = setTimeout(() => {
        initialTimer = null;
        void runNow();
      }, INITIAL_STAGGER_MS);
      initialTimer.unref?.();
      intervalId = setInterval(() => {
        void runNow();
      }, CHAT_HARNESS_MAINTENANCE_INTERVAL_MS);
      intervalId.unref?.();
    },
    stop() {
      if (initialTimer) {
        clearTimeout(initialTimer);
        initialTimer = null;
      }
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },
    runNow,
  };
}

export const chatHarnessMaintenanceScheduler =
  createChatHarnessMaintenanceScheduler();
