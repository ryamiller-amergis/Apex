import React, { useState } from 'react';
import { CalendarClock, Ticket, Webhook, Zap, type LucideIcon } from 'lucide-react';
import { playbookApexEventTypes } from '../../shared/utils/playbookTriggerMapping';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlaybookApiError } from '../hooks/usePlaybookDefinitions';
import styles from './PlaybookTriggersPanel.module.css';

type TriggerKind = 'schedule' | 'apex_event' | 'webhook' | 'azure_devops';

interface PlaybookTriggerRow {
  id: string;
  name: string;
  enabled: boolean;
  kind: TriggerKind;
  scheduleHour: number | null;
  scheduleMinute: number | null;
  eventType: string | null;
  eventFilter: { eventType?: string; workItemType?: string } | null;
  publicId: string | null;
}

interface CreatedTrigger extends PlaybookTriggerRow {
  webhookSecret?: string | null;
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  if (!response.ok && response.status !== 204) {
    const body = await response.json().catch(() => ({}));
    throw new PlaybookApiError(
      (body as { error?: string }).error ?? `Request failed: ${response.status}`,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

interface PlaybookTriggersPanelProps {
  project: string;
  definitionId: string;
  canManage: boolean;
  /** False when a surrounding drawer already titles the panel. */
  showHeading?: boolean;
  'data-testid'?: string;
}

const TRIGGER_ICONS: Record<TriggerKind, LucideIcon> = {
  schedule: CalendarClock,
  apex_event: Zap,
  webhook: Webhook,
  azure_devops: Ticket,
};

function triggerSummary(trigger: PlaybookTriggerRow): string {
  if (trigger.kind === 'schedule') {
    return `Daily at ${String(trigger.scheduleHour).padStart(2, '0')}:${String(trigger.scheduleMinute).padStart(2, '0')} UTC`;
  }
  if (trigger.kind === 'apex_event') return `When ${trigger.eventType ?? 'an Apex event'} happens`;
  if (trigger.kind === 'azure_devops') {
    return trigger.eventFilter?.workItemType
      ? `When a ${trigger.eventFilter.workItemType} is created in Azure DevOps`
      : 'When an Azure DevOps work item is created';
  }
  return 'When a signed webhook call arrives';
}

export const PlaybookTriggersPanel: React.FC<PlaybookTriggersPanelProps> = ({
  project,
  definitionId,
  canManage,
  showHeading = true,
  'data-testid': testId = 'playbook-triggers',
}) => {
  const queryClient = useQueryClient();
  const [name, setName] = useState('Daily');
  const [kind, setKind] = useState<TriggerKind>('schedule');
  const [eventType, setEventType] = useState<string>(playbookApexEventTypes[0]);
  const [hour, setHour] = useState(2);
  const [minute, setMinute] = useState(0);
  const [workItemType, setWorkItemType] = useState('Production Bug');
  const [createdSecret, setCreatedSecret] = useState<CreatedTrigger | null>(null);
  const triggers = useQuery<{ triggers: PlaybookTriggerRow[] }>({
    queryKey: ['playbook-triggers', project, definitionId],
    queryFn: () => apiRequest(
      `/api/playbooks/triggers?project=${encodeURIComponent(project)}&definitionId=${encodeURIComponent(definitionId)}`,
    ),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['playbook-triggers', project, definitionId] });
  };
  const create = useMutation({
    mutationFn: () => apiRequest<CreatedTrigger>(`/api/playbooks/triggers?project=${encodeURIComponent(project)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project,
        definitionId,
        name,
        kind,
        enabled: true,
        scheduleHour: kind === 'schedule' ? hour : null,
        scheduleMinute: kind === 'schedule' ? minute : null,
        eventType: kind === 'apex_event' ? eventType : null,
        eventFilter: kind === 'azure_devops'
          ? { eventType: 'workitem.created', workItemType: workItemType.trim() }
          : null,
        versionPolicy: 'current_published',
        concurrencyPolicy: 'skip_if_active',
        dedupeKeyTemplate: kind === 'schedule'
          ? 'schedule:{occurrence}'
          : kind === 'apex_event'
            ? '{event.type}:{event.entityId}'
            : '{event.entityId}',
        runInputTemplate: {},
        inputMapping: kind === 'apex_event' && eventType === 'design-doc.validation-requested'
          ? [
            { to: 'documentId', from: { kind: 'event.data', field: 'documentId' } },
            { to: 'validationThreadId', from: { kind: 'event.data', field: 'validationThreadId' } },
            { to: 'ownerUserId', from: { kind: 'event.data', field: 'ownerUserId' } },
          ]
          : [],
      }),
    }),
    onSuccess: (created) => {
      if (created.webhookSecret && created.publicId) setCreatedSecret(created);
      refresh();
    },
  });
  const pause = useMutation({
    mutationFn: (triggerId: string) => apiRequest(
      `/api/playbooks/triggers/${encodeURIComponent(triggerId)}/pause?project=${encodeURIComponent(project)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) },
    ),
    onSuccess: refresh,
  });

  const rows = triggers.data?.triggers ?? [];
  return (
    <section aria-labelledby="playbook-triggers-heading" {...{ 'data-testid': testId }} className={styles.panel}>
      {showHeading ? <h2 id="playbook-triggers-heading">Triggers</h2> : null}
      <p className={styles.note}>
        A trigger starts the latest published version on its own. Pausing it does not unpublish the Playbook.
      </p>
      {triggers.isError ? <p role="alert">{triggers.error.message}</p> : null}
      {triggers.isSuccess && rows.length === 0 ? (
        <p className={styles.empty} {...{ 'data-testid': "playbook-triggers-empty" }}>
          No triggers yet. This Playbook runs only when someone starts it.
        </p>
      ) : null}
      <ul className={styles.list}>
        {rows.map((trigger) => {
          const Icon = TRIGGER_ICONS[trigger.kind];
          return (
            <li key={trigger.id} className={styles.row}>
              <span className={styles.rowIcon} aria-hidden><Icon size={15} /></span>
              <span className={styles.rowText}>
                <span className={styles.rowName}>{trigger.name}</span>
                <span className={styles.rowDetail}>{triggerSummary(trigger)}</span>
              </span>
              <span className={`${styles.pill} ${trigger.enabled ? styles.pillOn : ''}`}>
                {trigger.enabled ? 'On' : 'Paused'}
              </span>
              {canManage && trigger.enabled ? (
                <button
                  type="button"
                  className={styles.rowAction}
                  onClick={() => pause.mutate(trigger.id)}
                  {...{ 'data-testid': `playbook-trigger-pause-${trigger.id}` }}
                >
                  Pause
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {canManage ? (
        <form
          className={styles.form}
          {...{ 'data-testid': "playbook-trigger-form" }}
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} {...{ 'data-testid': "playbook-trigger-name" }} />
          </label>
          <label>
            Type
            <select value={kind} onChange={(event) => setKind(event.target.value as TriggerKind)} {...{ 'data-testid': "playbook-trigger-kind" }}>
              <option value="schedule">UTC schedule</option>
              <option value="apex_event">Apex event</option>
              <option value="webhook">Webhook</option>
              <option value="azure_devops">Azure DevOps</option>
            </select>
          </label>
          {kind === 'apex_event' ? (
            <label>
              Event
              <select value={eventType} onChange={(event) => setEventType(event.target.value)} {...{ 'data-testid': "playbook-trigger-event" }}>
                {playbookApexEventTypes.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </label>
          ) : null}
          {kind === 'azure_devops' ? (
            <label>
              Work item type
              <input
                value={workItemType}
                onChange={(event) => setWorkItemType(event.target.value)}
                required
                {...{ 'data-testid': "playbook-trigger-work-item-type" }}
              />
            </label>
          ) : null}
          {kind === 'schedule' ? (
            <>
              <label>
                Hour UTC
                <input type="number" min={0} max={23} value={hour} onChange={(event) => setHour(Number(event.target.value))} {...{ 'data-testid': "playbook-trigger-hour" }} />
              </label>
              <label>
                Minute
                <input type="number" min={0} max={59} value={minute} onChange={(event) => setMinute(Number(event.target.value))} {...{ 'data-testid': "playbook-trigger-minute" }} />
              </label>
            </>
          ) : null}
          <button type="submit" className={styles.save} disabled={create.isPending} {...{ 'data-testid': "playbook-trigger-save" }}>
            {create.isPending ? 'Saving…' : 'Save trigger'}
          </button>
          {create.isError ? <p role="alert">{create.error.message}</p> : null}
          {createdSecret?.webhookSecret && createdSecret.publicId ? (
            <p className={styles.secret}>
              {createdSecret.kind === 'azure_devops'
                ? `Service hook password ${createdSecret.webhookSecret}. URL path /api/public/playbooks/triggers/${createdSecret.publicId}. Username can be apex. Send resource details All. The run receives workItemId, workItemType, title, and state. This secret is shown once.`
                : `Signing secret ${createdSecret.webhookSecret}. Public path /api/public/playbooks/triggers/${createdSecret.publicId}. Send X-Apex-Signature as sha256 of the raw body. This secret is shown once.`}
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );
};
