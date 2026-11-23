import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { IncidentTriageSettings as IncidentTriageSettingsView } from '../../shared/types/incidentTriage';
import {
  useIncidentTriageSettings,
  useSendIncidentTriageTestPost,
  useUpdateIncidentTriageSettings,
  useUpdateIncidentTriageWebhook,
} from '../hooks/useIncidentTriage';
import { IncidentTriageApiError } from '../services/incidentTriageApi';
import { formatIncidentTime } from '../utils/incidentTriageDisplay';
import gridStyles from './DataGrid.module.css';
import styles from './IncidentTriagePage.module.css';

const GROUP_SYS_ID = /^[0-9a-f]{32}$/i;
const BACKFILL_DAYS_MESSAGE = 'Enter a whole number of days from 1 to 30.';
const WEBHOOK_URL_MESSAGE = 'Enter the webhook URL. It must start with https://.';
const NO_WEBHOOK_MESSAGE = 'No webhook set';

function isHttpsUrl(text: string): boolean {
  try {
    return new URL(text).protocol === 'https:';
  } catch {
    return false;
  }
}

const webhookSchema = z.object({
  webhookUrl: z.string().trim().refine(isHttpsUrl, WEBHOOK_URL_MESSAGE),
});

type WebhookFormValues = z.infer<typeof webhookSchema>;

interface WebhookNotice {
  kind: 'ok' | 'error';
  text: string;
}

function parseGroupIds(text: string): string[] {
  const ids = text.split(/[\s,]+/).map((id) => id.trim()).filter(Boolean);
  return Array.from(new Set(ids));
}

const settingsSchema = z
  .object({
    enabled: z.boolean(),
    assignmentGroups: z.string().refine(
      (text) => parseGroupIds(text).every((id) => GROUP_SYS_ID.test(id)),
      'Enter each assignment group as a 32-character sys_id, one per line.',
    ),
    backfillDays: z
      .number({ error: BACKFILL_DAYS_MESSAGE })
      .int(BACKFILL_DAYS_MESSAGE)
      .min(1, BACKFILL_DAYS_MESSAGE)
      .max(30, BACKFILL_DAYS_MESSAGE),
  })
  .refine((values) => !values.enabled || parseGroupIds(values.assignmentGroups).length > 0, {
    path: ['assignmentGroups'],
    message: 'Add at least one assignment group sys_id before you turn this on.',
  });

type SettingsFormValues = z.infer<typeof settingsSchema>;

function toFormValues(settings: IncidentTriageSettingsView): SettingsFormValues {
  return {
    enabled: settings.enabled,
    assignmentGroups: settings.assignmentGroupIds.join('\n'),
    backfillDays: settings.backfillDays,
  };
}

interface WebhookControlsProps {
  project: string;
  maskedWebhook: string | null;
}

/** The webhook URL is write-only: it goes out on save and never comes back into the form, the cache or an error. */
const WebhookControls: React.FC<WebhookControlsProps> = ({ project, maskedWebhook }) => {
  const [notice, setNotice] = useState<WebhookNotice | null>(null);
  const webhook = useUpdateIncidentTriageWebhook();
  const testPost = useSendIncidentTriageTestPost();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<WebhookFormValues>({
    resolver: zodResolver(webhookSchema),
    defaultValues: { webhookUrl: '' },
  });

  const send = (teamsWebhookUrl: string | null) => {
    setNotice(null);
    webhook.mutate({ project, teamsWebhookUrl }, {
      onSuccess: () => {
        reset({ webhookUrl: '' });
        setNotice({ kind: 'ok', text: teamsWebhookUrl === null ? 'Webhook removed.' : 'Webhook saved.' });
        webhook.reset();
      },
      onError: (error) => {
        setNotice({ kind: 'error', text: error.message });
        webhook.reset();
      },
    });
  };

  const onSave = handleSubmit((values) => send(values.webhookUrl));

  const onRemove = () => {
    if (!window.confirm('Remove the Teams webhook? Cards stop posting until you add another.')) return;
    send(null);
  };

  const onTestPost = () => {
    testPost.reset();
    testPost.mutate(project);
  };

  const testResult = testPost.isSuccess
    ? 'Posted'
    : testPost.error instanceof IncidentTriageApiError && testPost.error.status === 409
      ? NO_WEBHOOK_MESSAGE
      : testPost.error?.message ?? null;

  return (
    <form className={styles.form} onSubmit={onSave} noValidate {...{ 'data-testid': 'incident-triage-settings-webhook-form' }}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Teams webhook</span>
        <input
          type="password"
          className={styles.input}
          autoComplete="off"
          spellCheck={false}
          placeholder={maskedWebhook ?? 'Not set'}
          {...register('webhookUrl')}
          {...{ 'data-testid': 'incident-triage-settings-webhook' }}
        />
        {errors.webhookUrl ? (
          <span className={styles.fieldError} role="alert" {...{ 'data-testid': 'incident-triage-settings-webhook-error' }}>
            {errors.webhookUrl.message}
          </span>
        ) : null}
      </label>
      {notice ? (
        <p
          className={notice.kind === 'error' ? styles.fieldError : styles.sweepResult}
          role={notice.kind === 'error' ? 'alert' : 'status'}
          {...{ 'data-testid': 'incident-triage-settings-webhook-notice' }}
        >
          {notice.text}
        </p>
      ) : null}
      <div className={styles.webhookRow}>
        <button
          type="submit"
          className={gridStyles.buttonPrimary}
          disabled={webhook.isPending}
          {...{ 'data-testid': 'incident-triage-settings-webhook-save' }}
        >
          {webhook.isPending ? 'Saving…' : 'Save webhook'}
        </button>
        <button
          type="button"
          className={gridStyles.buttonGhost}
          disabled={webhook.isPending || !maskedWebhook}
          onClick={onRemove}
          {...{ 'data-testid': 'incident-triage-settings-webhook-remove' }}
        >
          Remove webhook
        </button>
        <button
          type="button"
          className={gridStyles.buttonGhost}
          disabled={testPost.isPending}
          onClick={onTestPost}
          {...{ 'data-testid': 'incident-triage-settings-test-post' }}
        >
          {testPost.isPending ? 'Sending…' : 'Send test card'}
        </button>
      </div>
      {testResult ? (
        <p
          className={testPost.isError ? styles.fieldError : styles.sweepResult}
          role={testPost.isError ? 'alert' : 'status'}
          {...{ 'data-testid': 'incident-triage-settings-test-post-result' }}
        >
          {testResult}
        </p>
      ) : null}
    </form>
  );
};

interface IncidentTriageSettingsProps {
  project: string;
}

export const IncidentTriageSettings: React.FC<IncidentTriageSettingsProps> = ({ project }) => {
  const settingsQuery = useIncidentTriageSettings(project);
  const update = useUpdateIncidentTriageSettings();
  const settings = settingsQuery.data;
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: { enabled: false, assignmentGroups: '', backfillDays: 7 },
    values: settings ? toFormValues(settings) : undefined,
    resetOptions: { keepDirtyValues: true },
  });

  const onSave = handleSubmit((values) => {
    update.reset();
    update.mutate({
      project,
      update: {
        enabled: values.enabled,
        assignmentGroupIds: parseGroupIds(values.assignmentGroups),
        backfillDays: values.backfillDays,
      },
    });
  });

  return (
    <section
      className={gridStyles.section}
      aria-labelledby="incident-triage-settings-heading"
      {...{ 'data-testid': 'incident-triage-settings' }}
    >
      <div className={gridStyles.header}>
        <div>
          <h2 id="incident-triage-settings-heading" className={gridStyles.title}>Settings</h2>
          <p className={gridStyles.hint}>
            {settings
              ? `Last checked ${formatIncidentTime(settings.lastSweepAt)}.`
              : 'Choose which ServiceNow assignment groups this project reads.'}
          </p>
        </div>
      </div>
      {settingsQuery.isLoading ? <p className={gridStyles.loading}>Loading settings…</p> : null}
      {settingsQuery.isError ? (
        <p className={gridStyles.error} role="alert" {...{ 'data-testid': 'incident-triage-settings-error' }}>
          {settingsQuery.error.message}
        </p>
      ) : null}
      {settings?.lastSweepError ? (
        <p className={styles.sweepError} role="alert" {...{ 'data-testid': 'incident-triage-settings-sweep-error' }}>
          Last check failed: {settings.lastSweepError}
        </p>
      ) : null}
      {settings ? (
        <form className={styles.form} onSubmit={onSave} noValidate {...{ 'data-testid': 'incident-triage-settings-form' }}>
          <label className={styles.checkField}>
            <input
              type="checkbox"
              {...register('enabled')}
              {...{ 'data-testid': 'incident-triage-settings-enabled' }}
            />
            <span>Check ServiceNow for this project</span>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Assignment group sys_ids</span>
            <textarea
              className={styles.input}
              rows={3}
              spellCheck={false}
              {...register('assignmentGroups')}
              {...{ 'data-testid': 'incident-triage-settings-groups' }}
            />
            {errors.assignmentGroups ? (
              <span className={styles.fieldError} role="alert">{errors.assignmentGroups.message}</span>
            ) : null}
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Backfill days</span>
            <input
              type="number"
              className={styles.input}
              min={1}
              max={30}
              {...register('backfillDays', { valueAsNumber: true })}
              {...{ 'data-testid': 'incident-triage-settings-backfill' }}
            />
            {errors.backfillDays ? (
              <span className={styles.fieldError} role="alert">{errors.backfillDays.message}</span>
            ) : null}
          </label>
          {update.isError ? (
            <p className={styles.fieldError} role="alert" {...{ 'data-testid': 'incident-triage-settings-save-error' }}>
              {update.error.message}
            </p>
          ) : null}
          {update.isSuccess ? (
            <p className={styles.sweepResult} role="status" {...{ 'data-testid': 'incident-triage-settings-saved' }}>
              Settings saved.
            </p>
          ) : null}
          <div className={styles.actions}>
            <button
              type="submit"
              className={gridStyles.buttonPrimary}
              disabled={update.isPending}
              {...{ 'data-testid': 'incident-triage-settings-save' }}
            >
              {update.isPending ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </form>
      ) : null}
      {settings ? <WebhookControls project={project} maskedWebhook={settings.teamsWebhookMasked} /> : null}
    </section>
  );
};
