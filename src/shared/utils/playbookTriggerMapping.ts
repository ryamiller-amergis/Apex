import { z } from 'zod';

export const playbookApexEventTypes = [
  'design-doc.validation-requested',
  'interview.brief-completed',
  'document.approved',
  'feature-request.triaged',
  'cloud-agent.run-finished',
] as const;

export type PlaybookApexEventType = (typeof playbookApexEventTypes)[number];

/** Events with a producer. Subscriptions may name only these. */
export const producedPlaybookApexEventTypes = playbookApexEventTypes;

export const playbookTriggerKinds = ['schedule', 'apex_event', 'webhook', 'azure_devops'] as const;
export const playbookTriggerVersionPolicies = ['current_published', 'pinned'] as const;
export const playbookTriggerConcurrencyPolicies = ['allow', 'skip_if_active'] as const;
export const playbookTriggerReceiptStatuses = [
  'pending',
  'started',
  'skipped',
  'retryable',
  'failed',
  'dead_letter',
] as const;

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const plainValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const playbookTriggerMappingSchema = z.object({
  to: identifier,
  from: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('literal'), value: plainValue }),
    z.object({ kind: z.literal('event.entityId') }),
    z.object({ kind: z.literal('event.actorUserId') }),
    z.object({ kind: z.literal('event.data'), field: identifier }),
    z.object({ kind: z.literal('template'), key: identifier }),
  ]),
});

export type PlaybookTriggerMapping = z.infer<typeof playbookTriggerMappingSchema>;

export interface PlaybookTriggerEventView {
  entityId: string;
  actorUserId: string | null;
  data: Record<string, unknown>;
}

const DEDUPE_TOKEN = /\{([A-Za-z0-9_.]+)\}/g;

export function assertNoTemplateLanguage(value: unknown, label: string): void {
  if (typeof value === 'string' && (value.includes('${') || value.includes('{{'))) {
    throw new Error(`${label} cannot contain a template expression.`);
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoTemplateLanguage(entry, label);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) assertNoTemplateLanguage(entry, label);
  }
}

export function applyPlaybookTriggerMapping(input: {
  mapping: PlaybookTriggerMapping[];
  template: Record<string, unknown>;
  event: PlaybookTriggerEventView;
}): Record<string, unknown> {
  assertNoTemplateLanguage(input.template, 'Run input template');
  const output: Record<string, unknown> = { ...input.template };
  for (const entry of input.mapping) {
    const parsed = playbookTriggerMappingSchema.parse(entry);
    if (parsed.from.kind === 'literal') {
      assertNoTemplateLanguage(parsed.from.value, parsed.to);
      output[parsed.to] = parsed.from.value;
    } else if (parsed.from.kind === 'event.entityId') {
      output[parsed.to] = input.event.entityId;
    } else if (parsed.from.kind === 'event.actorUserId') {
      output[parsed.to] = input.event.actorUserId;
    } else if (parsed.from.kind === 'event.data') {
      output[parsed.to] = input.event.data[parsed.from.field];
    } else {
      output[parsed.to] = input.template[parsed.from.key];
    }
  }
  return output;
}

export function renderPlaybookDedupeKey(
  template: string,
  tokens: Record<string, string>,
): string {
  assertNoTemplateLanguage(template, 'Dedupe key');
  const rendered = template.replace(DEDUPE_TOKEN, (_whole, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(tokens, key)) {
      throw new Error(`Unknown dedupe token {${key}}.`);
    }
    return tokens[key];
  });
  if (!rendered.trim()) throw new Error('Dedupe key rendered empty.');
  return rendered;
}
