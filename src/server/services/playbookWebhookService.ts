/**
 * External trigger admission. The signature is HMAC-SHA256 over the raw body.
 * The project comes from the subscription the signature verifies, never from the body.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { playbookTriggerSubscriptions } from '../db/schema';
import { verifyRawKey } from './apiKeyLifecycleService';
import { dispatchPlaybookTrigger } from './playbookTriggerDispatchService';

export const PLAYBOOK_WEBHOOK_MAX_BYTES = 256 * 1024;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const hits = new Map<string, number[]>();

export function playbookWebhookSignature(secret: string, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function playbookWebhookSignatureMatches(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
): boolean {
  const presented = (header ?? '').replace(/^sha256=/i, '').trim();
  const expected = playbookWebhookSignature(secret, rawBody);
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function consumePlaybookWebhookRateLimit(publicId: string, now = Date.now()): boolean {
  const recent = (hits.get(publicId) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(publicId, recent);
    return false;
  }
  recent.push(now);
  hits.set(publicId, recent);
  return true;
}

const UNAUTHORIZED = { error: 'Unauthorized' };

export async function acceptExternalPlaybookTrigger(input: {
  publicId: string;
  rawBody: Buffer;
  signature: string | undefined;
  deliveryId: string | undefined;
  authorization: string | undefined;
  token?: string | undefined;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (input.rawBody.length > PLAYBOOK_WEBHOOK_MAX_BYTES) {
    return { status: 413, body: { error: 'Payload is too large.' } };
  }
  if (!consumePlaybookWebhookRateLimit(input.publicId)) {
    return { status: 429, body: { error: 'Too many requests.' } };
  }
  const subscription = await db.query.playbookTriggerSubscriptions.findFirst({
    where: eq(playbookTriggerSubscriptions.publicId, input.publicId),
  });
  if (!subscription?.webhookSecret || !subscription.enabled) {
    return { status: 401, body: UNAUTHORIZED };
  }
  const signed = playbookWebhookSignatureMatches(
    subscription.webhookSecret,
    input.rawBody,
    input.signature,
  );
  const serviceHook = subscription.kind === 'azure_devops' && adoServiceHookAuthorized(
    subscription.webhookSecret,
    input.authorization,
    input.token,
  );
  if (!signed && !serviceHook) {
    return { status: 401, body: UNAUTHORIZED };
  }
  if (input.authorization && !serviceHook) {
    const rawKey = /^Bearer\s+(.+)$/i.exec(input.authorization)?.[1]?.trim();
    const verified = rawKey ? await verifyRawKey(rawKey) : null;
    const allowed = verified
      && verified.projectId === subscription.project
      && verified.scopes.includes('playbooks:trigger');
    if (!allowed) return { status: 401, body: UNAUTHORIZED };
  }

  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(input.rawBody.toString('utf8')) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    return { status: 400, body: { error: 'Body must be JSON.' } };
  }

  const workItemType = subscription.kind === 'azure_devops'
    ? readAdoWorkItemTypeFilter(subscription.eventFilter)
    : null;
  const filtered = workItemType ? adoWorkItemCreatedReceipt(parsed, workItemType) : null;
  if (workItemType && filtered === 'skip') {
    return { status: 202, body: { status: 'skipped' } };
  }
  const ado = workItemType
    ? (filtered === 'skip' ? null : filtered)
    : (subscription.kind === 'azure_devops' ? adoServiceHookReceipt(parsed) : null);
  if (subscription.kind === 'azure_devops' && !ado) {
    return { status: 400, body: { error: 'Azure DevOps delivery has no id.' } };
  }
  const idempotencyKey = ado?.idempotencyKey ?? input.deliveryId?.trim() ?? '';
  if (!idempotencyKey) return { status: 400, body: { error: 'Delivery id is required.' } };

  const result = await dispatchPlaybookTrigger({
    subscriptionId: subscription.id,
    source: subscription.kind === 'azure_devops' ? 'azure_devops' : 'webhook',
    idempotencyKey,
    event: {
      entityId: ado?.entityId ?? idempotencyKey,
      actorUserId: null,
      data: ado?.data ?? { deliveryId: idempotencyKey },
    },
    payload: ado?.data ?? { deliveryId: idempotencyKey },
  });
  return { status: 202, body: { status: result.status, duplicate: result.duplicate } };
}

function secretEquals(expected: string, presented: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Basic password or X-Apex-Token. Azure DevOps service hooks can send either. */
export function adoServiceHookAuthorized(
  secret: string,
  authorization: string | undefined,
  token: string | undefined,
): boolean {
  const header = (token ?? '').trim();
  if (header && secretEquals(secret, header)) return true;
  const match = /^Basic\s+(.+)$/i.exec(authorization ?? '');
  if (!match) return false;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const splitAt = decoded.indexOf(':');
  if (splitAt < 0) return false;
  return secretEquals(secret, decoded.slice(splitAt + 1));
}

export function readAdoWorkItemTypeFilter(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const workItemType = (value as { workItemType?: unknown }).workItemType;
  if (typeof workItemType !== 'string') return null;
  const trimmed = workItemType.trim();
  return trimmed ? trimmed : null;
}

function resourceRecord(body: Record<string, unknown>): Record<string, unknown> {
  const resource = body.resource;
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return {};
  return resource as Record<string, unknown>;
}

function workItemFields(resource: Record<string, unknown>): Record<string, unknown> {
  const fields = resource.fields;
  if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
    return fields as Record<string, unknown>;
  }
  const revision = resource.revision;
  if (!revision || typeof revision !== 'object' || Array.isArray(revision)) return {};
  const revisionFields = (revision as Record<string, unknown>).fields;
  if (!revisionFields || typeof revisionFields !== 'object' || Array.isArray(revisionFields)) return {};
  return revisionFields as Record<string, unknown>;
}

/**
 * A created work item of the named type. `skip` is a delivery this subscription
 * does not start. `null` is a body with no work item id.
 */
export function adoWorkItemCreatedReceipt(
  body: Record<string, unknown>,
  workItemType: string,
): {
  idempotencyKey: string;
  entityId: string;
  data: Record<string, unknown>;
} | 'skip' | null {
  if (body.eventType !== 'workitem.created') return 'skip';
  const resource = resourceRecord(body);
  const rawWorkItemId = resource.id ?? resource.workItemId;
  const workItemId = typeof rawWorkItemId === 'number'
    ? rawWorkItemId
    : typeof rawWorkItemId === 'string' && /^\d+$/.test(rawWorkItemId)
      ? Number(rawWorkItemId)
      : null;
  if (workItemId === null || !Number.isSafeInteger(workItemId) || workItemId <= 0) return null;
  const fields = workItemFields(resource);
  const actualType = fields['System.WorkItemType'];
  if (typeof actualType !== 'string' || actualType.trim().toLowerCase() !== workItemType.trim().toLowerCase()) {
    return 'skip';
  }
  const rawEventId = body.id ?? body.eventId;
  const eventId = typeof rawEventId === 'string' || typeof rawEventId === 'number'
    ? String(rawEventId)
    : `workitem.created:${workItemId}`;
  const title = typeof fields['System.Title'] === 'string' ? fields['System.Title'] : '';
  const state = typeof fields['System.State'] === 'string' ? fields['System.State'] : '';
  return {
    idempotencyKey: `ado:${eventId}`,
    entityId: String(workItemId),
    data: {
      eventType: 'workitem.created',
      id: String(workItemId),
      workItemId,
      workItemType: actualType.trim(),
      title,
      state,
    },
  };
}

export function adoServiceHookReceipt(body: Record<string, unknown>): {
  idempotencyKey: string;
  entityId: string;
  data: Record<string, unknown>;
} | null {
  const resource = body.resource && typeof body.resource === 'object'
    ? body.resource as Record<string, unknown>
    : {};
  const rawId = body.id ?? body.eventId ?? resource.id ?? resource.workItemId;
  if (typeof rawId !== 'string' && typeof rawId !== 'number') return null;
  const id = String(rawId);
  return {
    idempotencyKey: `ado:${id}`,
    entityId: id,
    data: {
      eventType: typeof body.eventType === 'string' ? body.eventType : 'azure_devops',
      id,
    },
  };
}
