/**
 * Playbook trigger subscriptions. Pause leaves the Playbook published.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/drizzle';
import { playbookTriggerReceipts, playbookTriggerSubscriptions } from '../db/schema';
import {
  playbookTriggerMappingSchema,
  producedPlaybookApexEventTypes,
} from '../../shared/utils/playbookTriggerMapping';
import { assertNoTemplateLanguage } from '../../shared/utils/playbookTriggerMapping';

const adoWorkItemFilterSchema = z.object({
  eventType: z.literal('workitem.created'),
  workItemType: z.string().trim().min(1).max(128),
});

const subscriptionSchema = z.object({
  name: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  kind: z.enum(['schedule', 'apex_event', 'webhook', 'azure_devops']),
  scheduleHour: z.number().int().min(0).max(23).nullable().optional(),
  scheduleMinute: z.number().int().min(0).max(59).nullable().optional(),
  eventType: z.enum(producedPlaybookApexEventTypes).nullable().optional(),
  eventFilter: adoWorkItemFilterSchema.nullable().optional(),
  versionPolicy: z.enum(['current_published', 'pinned']).default('current_published'),
  pinnedVersionId: z.string().uuid().nullable().optional(),
  concurrencyPolicy: z.enum(['allow', 'skip_if_active']).default('skip_if_active'),
  dedupeKeyTemplate: z.string().trim().min(1),
  runInputTemplate: z.record(z.string(), z.unknown()).default({}),
  inputMapping: z.array(playbookTriggerMappingSchema).default([]),
}).superRefine((value, ctx) => {
  if (value.kind === 'schedule' && (value.scheduleHour == null || value.scheduleMinute == null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A schedule needs an hour and a minute.' });
  }
  if (value.kind === 'schedule' && !value.dedupeKeyTemplate.includes('{occurrence}')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A schedule dedupe key must include {occurrence}.' });
  }
  if (value.kind === 'apex_event' && !value.eventType) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose an Apex event.' });
  }
  if ((value.kind === 'webhook' || value.kind === 'azure_devops') && value.eventType) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'An external trigger does not use an Apex event type.' });
  }
  if (value.kind !== 'azure_devops' && value.eventFilter) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Only an Azure DevOps trigger can filter on a work item type.' });
  }
  if (value.versionPolicy === 'pinned' && !value.pinnedVersionId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A pinned trigger needs a version.' });
  }
  try {
    assertNoTemplateLanguage(value.dedupeKeyTemplate, 'Dedupe key');
    assertNoTemplateLanguage(value.runInputTemplate, 'Run input template');
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'Invalid trigger input.',
    });
  }
});

export type PlaybookTriggerSubscriptionInput = z.infer<typeof subscriptionSchema>;

export class PlaybookTriggerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookTriggerValidationError';
  }
}

function externalIdentity(kind: string): { publicId: string; webhookSecret: string } | null {
  if (kind !== 'webhook' && kind !== 'azure_devops') return null;
  return { publicId: randomUUID(), webhookSecret: randomBytes(32).toString('hex') };
}

function presentTrigger<T extends { webhookSecret?: string | null }>(
  row: T,
  revealSecret: boolean,
): T {
  if (revealSecret) return row;
  return { ...row, webhookSecret: null };
}

export async function listPlaybookTriggers(project: string, definitionId: string) {
  const rows = await db.select().from(playbookTriggerSubscriptions).where(and(
    eq(playbookTriggerSubscriptions.project, project),
    eq(playbookTriggerSubscriptions.definitionId, definitionId),
  )).orderBy(desc(playbookTriggerSubscriptions.createdAt));
  return rows.map((row) => presentTrigger(row, false));
}

export async function listPlaybookTriggerReceipts(subscriptionId: string) {
  return db.select().from(playbookTriggerReceipts).where(
    eq(playbookTriggerReceipts.subscriptionId, subscriptionId),
  ).orderBy(desc(playbookTriggerReceipts.createdAt)).limit(50);
}

function parseSubscription(input: unknown): PlaybookTriggerSubscriptionInput {
  const parsed = subscriptionSchema.safeParse(input);
  if (!parsed.success) {
    throw new PlaybookTriggerValidationError(parsed.error.issues[0]?.message ?? 'Check the trigger and try again.');
  }
  return parsed.data;
}

export async function createPlaybookTrigger(input: {
  project: string;
  definitionId: string;
  actorUserId: string;
  body: unknown;
}) {
  const draft = parseSubscription(input.body);
  const external = externalIdentity(draft.kind);
  const [row] = await db.insert(playbookTriggerSubscriptions).values({
    project: input.project,
    definitionId: input.definitionId,
    name: draft.name,
    enabled: draft.enabled,
    kind: draft.kind,
    scheduleHour: draft.kind === 'schedule' ? draft.scheduleHour ?? null : null,
    scheduleMinute: draft.kind === 'schedule' ? draft.scheduleMinute ?? null : null,
    eventType: draft.kind === 'apex_event' ? draft.eventType ?? null : null,
    versionPolicy: draft.versionPolicy,
    pinnedVersionId: draft.versionPolicy === 'pinned' ? draft.pinnedVersionId ?? null : null,
    initiatorUserId: input.actorUserId,
    runInputTemplate: draft.runInputTemplate,
    inputMapping: draft.inputMapping,
    concurrencyPolicy: draft.concurrencyPolicy,
    dedupeKeyTemplate: draft.dedupeKeyTemplate,
    createdBy: input.actorUserId,
    publicId: external?.publicId ?? null,
    webhookSecret: external?.webhookSecret ?? null,
    eventFilter: draft.kind === 'azure_devops' ? draft.eventFilter ?? null : null,
  }).returning();
  return presentTrigger(row, true);
}

export async function updatePlaybookTrigger(input: {
  project: string;
  triggerId: string;
  body: unknown;
}) {
  const draft = parseSubscription(input.body);
  const [row] = await db.update(playbookTriggerSubscriptions).set({
    name: draft.name,
    enabled: draft.enabled,
    kind: draft.kind,
    scheduleHour: draft.kind === 'schedule' ? draft.scheduleHour ?? null : null,
    scheduleMinute: draft.kind === 'schedule' ? draft.scheduleMinute ?? null : null,
    eventType: draft.kind === 'apex_event' ? draft.eventType ?? null : null,
    versionPolicy: draft.versionPolicy,
    pinnedVersionId: draft.versionPolicy === 'pinned' ? draft.pinnedVersionId ?? null : null,
    runInputTemplate: draft.runInputTemplate,
    inputMapping: draft.inputMapping,
    concurrencyPolicy: draft.concurrencyPolicy,
    dedupeKeyTemplate: draft.dedupeKeyTemplate,
    eventFilter: draft.kind === 'azure_devops' ? draft.eventFilter ?? null : null,
    updatedAt: new Date().toISOString(),
  }).where(and(
    eq(playbookTriggerSubscriptions.id, input.triggerId),
    eq(playbookTriggerSubscriptions.project, input.project),
  )).returning();
  if (!row) throw new PlaybookTriggerValidationError('Trigger not found.');
  return row;
}

export async function setPlaybookTriggerEnabled(input: {
  project: string;
  triggerId: string;
  enabled: boolean;
}) {
  const [row] = await db.update(playbookTriggerSubscriptions).set({
    enabled: input.enabled,
    updatedAt: new Date().toISOString(),
  }).where(and(
    eq(playbookTriggerSubscriptions.id, input.triggerId),
    eq(playbookTriggerSubscriptions.project, input.project),
  )).returning();
  if (!row) throw new PlaybookTriggerValidationError('Trigger not found.');
  return row;
}

export async function deletePlaybookTrigger(project: string, triggerId: string): Promise<void> {
  await db.delete(playbookTriggerSubscriptions).where(and(
    eq(playbookTriggerSubscriptions.id, triggerId),
    eq(playbookTriggerSubscriptions.project, project),
  ));
}
