/**
 * Claims a trigger receipt and starts one ordinary Playbook run.
 * The receipt insert is the idempotency boundary.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  playbookDefinitionVersions,
  playbookRuns,
  playbookTriggerReceipts,
  playbookTriggerSubscriptions,
} from '../db/schema';
import {
  applyPlaybookTriggerMapping,
  playbookTriggerMappingSchema,
  renderPlaybookDedupeKey,
  type PlaybookTriggerEventView,
  type PlaybookTriggerMapping,
} from '../../shared/utils/playbookTriggerMapping';
import { getUserPermissions } from './rbacService';
import { playbookSpendPolicyService } from './playbookSpendPolicyService';
import { startRun } from './playbookRunService';

const TRIGGER_SOURCES = ['schedule', 'apex_event', 'manual', 'replay', 'webhook', 'azure_devops'] as const;
type TriggerSource = (typeof TRIGGER_SOURCES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Rebuilds the event a receipt stored, including the work-item fields a retry has to keep.
 * New receipts store `{ source, entityId, actorUserId, data }`. Older Azure DevOps receipts
 * stored the work-item fields themselves, so those use the receipt row's source.
 */
export function storedPlaybookTriggerDispatch(
  payload: Record<string, unknown>,
  fallbackSource?: string,
): {
  source: TriggerSource;
  event: PlaybookTriggerEventView;
} {
  const nested = isRecord(payload.data) ? payload.data : null;
  const raw = typeof payload.source === 'string' ? payload.source : fallbackSource ?? 'replay';
  const source = (TRIGGER_SOURCES as readonly string[]).includes(raw) ? raw as TriggerSource : 'replay';
  return {
    source,
    event: {
      entityId: String(payload.entityId ?? dataWorkItemId(nested ?? payload)),
      actorUserId: typeof payload.actorUserId === 'string' ? payload.actorUserId : null,
      data: nested ?? (typeof payload.source === 'string' ? {} : payload),
    },
  };
}

function dataWorkItemId(data: Record<string, unknown>): string {
  return data.workItemId === undefined ? '' : String(data.workItemId);
}

const MAX_ATTEMPTS = 5;
const RETRY_MS = 5 * 60_000;
const LIVE = ['running', 'suspended'] as const;

export function recordPlaybookTriggerEvent(
  event: 'dispatch' | 'duplicate' | 'skip' | 'start' | 'retry' | 'dead-letter' | 'replay',
  fields: Record<string, unknown>,
): void {
  console.info('[playbook-trigger]', JSON.stringify({ event, ...fields }));
}

function hashPayload(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function initiatorCanRun(userId: string, project: string): Promise<boolean> {
  const permissions = await getUserPermissions(userId, project);
  return permissions.has('playbooks:run');
}

async function hasLiveRun(definitionId: string): Promise<boolean> {
  const [live] = await db
    .select({ id: playbookRuns.id })
    .from(playbookRuns)
    .innerJoin(
      playbookDefinitionVersions,
      eq(playbookRuns.definitionVersionId, playbookDefinitionVersions.id),
    )
    .where(and(
      eq(playbookDefinitionVersions.definitionId, definitionId),
      inArray(playbookRuns.status, [...LIVE]),
    ))
    .limit(1);
  return Boolean(live);
}

async function markReceipt(
  receiptId: string,
  patch: {
    status: string;
    runId?: string | null;
    attempts?: number;
    nextRetryAt?: string | null;
    error?: string | null;
  },
): Promise<void> {
  await db.update(playbookTriggerReceipts).set({
    status: patch.status,
    ...(patch.runId !== undefined ? { runId: patch.runId } : {}),
    ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
    ...(patch.nextRetryAt !== undefined ? { nextRetryAt: patch.nextRetryAt } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
    updatedAt: new Date().toISOString(),
  }).where(eq(playbookTriggerReceipts.id, receiptId));
}

export async function testPlaybookTrigger(input: {
  project: string;
  subscriptionId: string;
  event: PlaybookTriggerEventView;
}): Promise<{ ok: true; runInput: Record<string, unknown> } | { ok: false; error: string }> {
  const subscription = await db.query.playbookTriggerSubscriptions.findFirst({
    where: and(
      eq(playbookTriggerSubscriptions.id, input.subscriptionId),
      eq(playbookTriggerSubscriptions.project, input.project),
    ),
  });
  if (!subscription) return { ok: false, error: 'Trigger not found.' };
  try {
    const mapping = playbookTriggerMappingSchema.array().parse(subscription.inputMapping);
    const runInput = applyPlaybookTriggerMapping({
      mapping,
      template: subscription.runInputTemplate ?? {},
      event: input.event,
    });
    const allowed = await initiatorCanRun(subscription.initiatorUserId, subscription.project);
    if (!allowed) return { ok: false, error: 'The trigger initiator cannot start Playbook runs.' };
    await playbookSpendPolicyService.assertAdmission(subscription.project);
    return { ok: true, runInput };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Trigger test failed.' };
  }
}

export async function dispatchPlaybookTrigger(input: {
  subscriptionId: string;
  source: TriggerSource;
  idempotencyKey: string;
  event: PlaybookTriggerEventView;
}): Promise<{ status: string; runId: string | null; definitionVersionId: string | null; duplicate: boolean }> {
  const subscription = await db.query.playbookTriggerSubscriptions.findFirst({
    where: eq(playbookTriggerSubscriptions.id, input.subscriptionId),
  });
  if (!subscription) return { status: 'skipped', runId: null, definitionVersionId: null, duplicate: false };

  const payload = {
    source: input.source,
    entityId: input.event.entityId,
    actorUserId: input.event.actorUserId,
    data: input.event.data,
  };
  const inserted = await db.insert(playbookTriggerReceipts).values({
    subscriptionId: subscription.id,
    idempotencyKey: input.idempotencyKey,
    source: input.source,
    payloadHash: hashPayload(payload),
    payload,
    status: 'pending',
  }).onConflictDoNothing().returning({ id: playbookTriggerReceipts.id });

  let receiptId: string;

  if (!inserted[0]) {
    const [existing] = await db.select().from(playbookTriggerReceipts).where(and(
      eq(playbookTriggerReceipts.subscriptionId, subscription.id),
      eq(playbookTriggerReceipts.idempotencyKey, input.idempotencyKey),
    ));
    const stalePending = existing?.status === 'pending' && pendingReceiptIsStale(existing.updatedAt);
    if (!existing || (existing.status !== 'retryable' && !stalePending)) {
      recordPlaybookTriggerEvent('duplicate', {
        subscriptionId: subscription.id,
        idempotencyKey: input.idempotencyKey,
      });
      return { status: existing?.status ?? 'started', runId: existing?.runId ?? null, definitionVersionId: null, duplicate: true };
    }
    if (
      existing.status === 'retryable'
      && existing.nextRetryAt
      && Date.parse(existing.nextRetryAt) > Date.now()
      && input.source !== 'replay'
    ) {
      return { status: 'retryable', runId: null, definitionVersionId: null, duplicate: true };
    }
    const claimed = await db.update(playbookTriggerReceipts).set({
      status: 'pending',
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(playbookTriggerReceipts.id, existing.id),
      eq(playbookTriggerReceipts.status, existing.status),
    )).returning({ id: playbookTriggerReceipts.id });
    if (!claimed[0]) {
      recordPlaybookTriggerEvent('duplicate', {
        subscriptionId: subscription.id,
        idempotencyKey: input.idempotencyKey,
      });
      return { status: 'pending', runId: existing.runId ?? null, definitionVersionId: null, duplicate: true };
    }
    receiptId = existing.id;
  } else {
    receiptId = inserted[0].id;
  }

  if (!subscription.enabled) {
    await markReceipt(receiptId, { status: 'skipped', error: 'Trigger is paused.' });
    recordPlaybookTriggerEvent('skip', { subscriptionId: subscription.id, receiptId });
    return { status: 'skipped', runId: null, definitionVersionId: null, duplicate: false };
  }

  try {
    const mapping = playbookTriggerMappingSchema.array().parse(subscription.inputMapping) as PlaybookTriggerMapping[];
    const runInput = withAdoWorkItemRunInput(
      input.source,
      applyPlaybookTriggerMapping({
        mapping,
        template: subscription.runInputTemplate ?? {},
        event: input.event,
      }),
      input.event.data,
    );
    const allowed = await initiatorCanRun(subscription.initiatorUserId, subscription.project);
    if (!allowed) {
      await markReceipt(receiptId, { status: 'failed', error: 'Initiator cannot start Playbook runs.' });
      recordPlaybookTriggerEvent('dispatch', { subscriptionId: subscription.id, receiptId, status: 'failed' });
      return { status: 'failed', runId: null, definitionVersionId: null, duplicate: false };
    }
    if (subscription.concurrencyPolicy === 'skip_if_active' && await hasLiveRun(subscription.definitionId)) {
      await markReceipt(receiptId, { status: 'skipped', error: 'A run is already active.' });
      recordPlaybookTriggerEvent('skip', { subscriptionId: subscription.id, receiptId, reason: 'active-run' });
      return { status: 'skipped', runId: null, definitionVersionId: null, duplicate: false };
    }
    await playbookSpendPolicyService.assertAdmission(subscription.project);
    const started = await startRun({
      project: subscription.project,
      definitionId: subscription.definitionId,
      initiatorUserId: subscription.initiatorUserId,
      runInput,
      ...(subscription.versionPolicy === 'pinned' && subscription.pinnedVersionId
        ? {
          definitionVersionId: subscription.pinnedVersionId,
          versionPinReason: 'Pinned by a Playbook trigger.',
        }
        : {}),
      triggerSubscriptionId: subscription.id,
      triggerReceiptId: receiptId,
    });
    await markReceipt(receiptId, { status: 'started', runId: started.runId, error: null });
    recordPlaybookTriggerEvent('start', {
      subscriptionId: subscription.id,
      receiptId,
      runId: started.runId,
    });
    return { status: 'started', runId: started.runId, definitionVersionId: started.definitionVersionId, duplicate: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Trigger dispatch failed.';
    const [current] = await db.select({ attempts: playbookTriggerReceipts.attempts })
      .from(playbookTriggerReceipts)
      .where(eq(playbookTriggerReceipts.id, receiptId));
    const attempts = (current?.attempts ?? 0) + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    await markReceipt(receiptId, {
      status: dead ? 'dead_letter' : 'retryable',
      attempts,
      nextRetryAt: dead ? null : new Date(Date.now() + RETRY_MS).toISOString(),
      error: message,
    });
    recordPlaybookTriggerEvent(dead ? 'dead-letter' : 'retry', {
      subscriptionId: subscription.id,
      receiptId,
      attempts,
    });
    return { status: dead ? 'dead_letter' : 'retryable', runId: null, definitionVersionId: null, duplicate: false };
  }
}

/** A pending receipt older than this is a crashed dispatch, not one still in flight. */
export const STALE_PENDING_RECEIPT_MS = 2 * 60 * 1000;

export function pendingReceiptIsStale(updatedAt: string, now = Date.now()): boolean {
  const at = Date.parse(updatedAt);
  return Number.isFinite(at) && now - at >= STALE_PENDING_RECEIPT_MS;
}

const ADO_WORK_ITEM_FIELDS = ['workItemId', 'workItemType', 'title', 'state'] as const;

/** Copies the created work item onto the run when the graph did not map it. */
export function withAdoWorkItemRunInput(
  source: string,
  runInput: Record<string, unknown>,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (source !== 'azure_devops') return runInput;
  const next = { ...runInput };
  for (const key of ADO_WORK_ITEM_FIELDS) {
    if (next[key] === undefined && data[key] !== undefined) next[key] = data[key];
  }
  return next;
}

export function scheduleOccurrenceKey(instant: Date): string {
  return renderPlaybookDedupeKey('schedule:{occurrence}', {
    occurrence: instant.toISOString().slice(0, 16),
  });
}

export function latestScheduleInstant(now: Date, hour: number, minute: number): Date {
  const scheduled = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour,
    minute,
    0,
    0,
  ));
  if (now.getTime() >= scheduled.getTime()) return scheduled;
  return new Date(scheduled.getTime() - 24 * 60 * 60 * 1000);
}
