import React, { useMemo, useRef, useState } from 'react';
import type {
  QaLabCaseRun as QaLabCaseRunRecord,
  QaLabRunAttachment,
  QaLabRunOutcome,
  QaLabRunStepResult,
} from '../../shared/types/qaLab';
import { useCaseRun, useCaseRunActions } from '../hooks/useQaLab';
import styles from './QaLabCaseRun.module.css';

interface RunForm {
  outcome: QaLabRunOutcome | null;
  comment: string;
  steps: Map<number, QaLabRunStepResult>;
}

function formFrom(run: QaLabCaseRunRecord | null): RunForm {
  return {
    outcome: run?.outcome ?? null,
    comment: run?.comment ?? '',
    steps: new Map((run?.stepResults ?? []).map((step) => [step.stepId, step])),
  };
}

/** Failed when any step failed, Passed when every step passed, otherwise no suggestion. */
export function suggestedOutcome(stepIds: number[], steps: Map<number, QaLabRunStepResult>): QaLabRunOutcome | null {
  const outcomes = stepIds.map((id) => steps.get(id)?.outcome ?? null);
  if (outcomes.includes('failed')) return 'failed';
  return outcomes.length > 0 && outcomes.every((outcome) => outcome === 'passed') ? 'passed' : null;
}

export function canFileBug(form: RunForm): boolean {
  const failedSteps = [...form.steps.values()].filter((step) => step.outcome === 'failed');
  if (form.outcome !== 'failed' && failedSteps.length === 0) return false;
  return form.comment.trim().length > 0 || failedSteps.some((step) => step.comment.trim().length > 0);
}

const OutcomeButtons: React.FC<{
  value: QaLabRunOutcome | null;
  onChange: (next: QaLabRunOutcome | null) => void;
  'data-testid': string;
  disabled: boolean;
}> = ({ value, onChange, 'data-testid': testId, disabled }) => (
  <span className={styles.outcomeButtons}>
    <button
      type="button"
      className={`${styles.outcomeBtn} ${value === 'passed' ? styles.outcomePassed : ''}`}
      aria-pressed={value === 'passed'}
      disabled={disabled}
      onClick={() => onChange(value === 'passed' ? null : 'passed')}
      {...{ 'data-testid': `${testId}-pass` }}
    >
      Pass
    </button>
    <button
      type="button"
      className={`${styles.outcomeBtn} ${value === 'failed' ? styles.outcomeFailed : ''}`}
      aria-pressed={value === 'failed'}
      disabled={disabled}
      onClick={() => onChange(value === 'failed' ? null : 'failed')}
      {...{ 'data-testid': `${testId}-fail` }}
    >
      Fail
    </button>
  </span>
);

const Attachments: React.FC<{
  attachments: QaLabRunAttachment[];
  onAdd: (file: File) => void;
  onRemove: (id: string) => void;
  testId: string;
  disabled: boolean;
}> = ({ attachments, onAdd, onRemove, testId, disabled }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={styles.attachments}>
      {attachments.map((attachment) => (
        <span key={attachment.id} className={styles.attachment}>
          <a
            href={attachment.url}
            target="_blank"
            rel="noreferrer"
            {...{ 'data-testid': `${testId}-file-${attachment.id}` }}
          >
            {attachment.fileName}
          </a>
          <button
            type="button"
            className={styles.attachmentRemove}
            aria-label={`Remove ${attachment.fileName}`}
            disabled={disabled}
            onClick={() => onRemove(attachment.id)}
            {...{ 'data-testid': `${testId}-file-remove-${attachment.id}` }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="file"
        className={styles.fileInput}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onAdd(file);
          event.target.value = '';
        }}
        {...{ 'data-testid': `${testId}-file-input` }}
      />
      <button
        type="button"
        className={styles.linkBtn}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        {...{ 'data-testid': `${testId}-attach` }}
      >
        + Attach file
      </button>
    </div>
  );
};

interface QaLabCaseRunProps {
  suiteId: string;
  localCaseId: string;
}

/** Runs a published Test Case and records the result in Azure DevOps. */
export const QaLabCaseRun: React.FC<QaLabCaseRunProps> = ({ suiteId, localCaseId }) => {
  const [open, setOpen] = useState(false);
  const runQuery = useCaseRun(suiteId, localCaseId, open);
  const actions = useCaseRunActions(suiteId, localCaseId);
  const [form, setForm] = useState(() => formFrom(null));
  const [dirty, setDirty] = useState(false);
  const testId = `qa-lab-run-${localCaseId}`;

  const state = runQuery.data;
  const draft = state?.draft ?? null;
  const target = state?.target ?? null;
  const stepIds = useMemo(() => (target?.steps ?? []).map((step) => step.stepId), [target]);

  const draftKey = draft ? `${draft.id}:${draft.updatedAt}` : '';
  const [syncedKey, setSyncedKey] = useState('');
  if (!dirty && draftKey !== syncedKey) {
    setSyncedKey(draftKey);
    setForm(formFrom(draft));
  }

  const busy = actions.save.isPending || actions.attach.isPending || actions.removeAttachment.isPending
    || actions.createBug.isPending || actions.publish.isPending;
  const error = [actions.save, actions.attach, actions.removeAttachment, actions.createBug, actions.publish]
    .find((mutation) => mutation.error)?.error?.message ?? runQuery.error?.message;

  const update = (next: { outcome: QaLabRunOutcome | null } | { comment: string }) => {
    setForm((current) => ({ ...current, ...next }));
    setDirty(true);
  };

  const updateStep = (stepId: number, next: Partial<QaLabRunStepResult>) => {
    setForm((current) => {
      const steps = new Map(current.steps);
      const previous = steps.get(stepId) ?? { stepId, outcome: null, comment: '' };
      steps.set(stepId, { ...previous, ...next });
      const outcome = current.outcome ?? suggestedOutcome(stepIds, steps);
      return { ...current, steps, outcome: next.outcome === 'failed' ? 'failed' : outcome };
    });
    setDirty(true);
  };

  const saveForm = async () => {
    await actions.save.mutateAsync({
      outcome: form.outcome,
      comment: form.comment,
      stepResults: stepIds.flatMap((id) => {
        const step = form.steps.get(id);
        return step && (step.outcome || step.comment.trim()) ? [step] : [];
      }),
    });
    setDirty(false);
  };

  const saveThen = async (next: () => Promise<unknown>) => {
    try {
      if (dirty) await saveForm();
      await next();
    } catch {
      // The failed mutation's error is shown below.
    }
  };

  if (!open) {
    return (
      <div className={styles.runClosed}>
        <button
          type="button"
          className={styles.secondaryBtn}
          onClick={() => setOpen(true)}
          {...{ 'data-testid': `${testId}-open` }}
        >
          Run this test
        </button>
      </div>
    );
  }

  const attachmentsFor = (stepId?: number) => (draft?.attachments ?? [])
    .filter((attachment) => attachment.stepId === stepId);
  const attach = (stepId?: number) => (file: File) => {
    void saveThen(() => actions.attach.mutateAsync({ file, ...(stepId !== undefined ? { stepId } : {}) }));
  };
  const removeAttachment = (id: string) => {
    void actions.removeAttachment.mutateAsync(id).catch(() => undefined);
  };
  const lastPublished = state?.lastPublished ?? null;
  // With nothing recorded since the last publish, a Bug is filed against that run.
  const bugRun = draft || dirty ? null : lastPublished;
  const bugs = (draft ?? bugRun)?.bugs ?? [];
  const showCreateBug = canFileBug(bugRun ? formFrom(bugRun) : form);

  return (
    <section className={styles.run} {...{ 'data-testid': testId }}>
      <header className={styles.runHeader}>
        <h4 className={styles.runTitle}>Run this test</h4>
        {target && (
          <span className={styles.runWhere}>
            <a href={target.adoTestCaseUrl} target="_blank" rel="noreferrer" {...{ 'data-testid': `${testId}-case-link` }}>
              Test Case #{target.adoTestCaseId}
            </a>
            {` in ${target.planName} > ${target.suiteName}`}
          </span>
        )}
        <button
          type="button"
          className={styles.linkBtn}
          onClick={() => setOpen(false)}
          {...{ 'data-testid': `${testId}-close` }}
        >
          Close
        </button>
      </header>

      {runQuery.isLoading && <p className={styles.note}>Loading the Test Case from Azure DevOps…</p>}
      {state && !target && (
        <p className={styles.note} {...{ 'data-testid': `${testId}-unavailable` }}>{state.unavailableReason}</p>
      )}
      {lastPublished && (
        <p className={styles.note} {...{ 'data-testid': `${testId}-last` }}>
          Last run: {lastPublished.outcome === 'failed' ? 'Failed' : 'Passed'}
          {lastPublished.publishedAt ? ` on ${new Date(lastPublished.publishedAt).toLocaleString()}` : ''}
          {lastPublished.adoRunUrl && (
            <>
              {' · '}
              <a href={lastPublished.adoRunUrl} target="_blank" rel="noreferrer" {...{ 'data-testid': `${testId}-last-link` }}>
                View in Azure DevOps
              </a>
            </>
          )}
        </p>
      )}

      {target && (
        <>
          <table className={styles.runTable}>
            <thead>
              <tr>
                <th scope="col" className={styles.numberCol}>Step</th>
                <th scope="col">Action</th>
                <th scope="col">Expected</th>
                <th scope="col" className={styles.resultCol}>Result</th>
              </tr>
            </thead>
            <tbody>
              {target.steps.map((step) => {
                const result = form.steps.get(step.stepId);
                const stepTestId = `${testId}-step-${step.stepId}`;
                return (
                  <tr key={step.stepId} className={result?.outcome === 'failed' ? styles.rowFailed : undefined}>
                    <td className={styles.numberCol}>{step.order}</td>
                    <td className={styles.multiline}>{step.action}</td>
                    <td className={styles.multiline}>{step.expected}</td>
                    <td className={styles.resultCol}>
                      <OutcomeButtons
                        value={result?.outcome ?? null}
                        onChange={(outcome) => updateStep(step.stepId, { outcome })}
                        data-testid={stepTestId}
                        disabled={busy}
                      />
                      <textarea
                        className={styles.comment}
                        rows={2}
                        maxLength={4000}
                        placeholder={result?.outcome === 'failed' ? 'What happened instead?' : 'Comment'}
                        value={result?.comment ?? ''}
                        onChange={(event) => updateStep(step.stepId, { comment: event.target.value })}
                        aria-label={`Comment on step ${step.order}`}
                        {...{ 'data-testid': `${stepTestId}-comment` }}
                      />
                      <Attachments
                        attachments={attachmentsFor(step.stepId)}
                        onAdd={attach(step.stepId)}
                        onRemove={removeAttachment}
                        testId={stepTestId}
                        disabled={busy}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className={styles.caseResult}>
            <div className={styles.caseResultRow}>
              <span className={styles.label}>Test case result</span>
              <OutcomeButtons
                value={form.outcome}
                onChange={(outcome) => update({ outcome })}
                data-testid={`${testId}-case`}
                disabled={busy}
              />
            </div>
            <textarea
              className={styles.comment}
              rows={3}
              maxLength={4000}
              placeholder="Comment on the whole test case"
              value={form.comment}
              onChange={(event) => update({ comment: event.target.value })}
              aria-label="Comment on the test case"
              {...{ 'data-testid': `${testId}-case-comment` }}
            />
            <Attachments
              attachments={attachmentsFor(undefined)}
              onAdd={attach(undefined)}
              onRemove={removeAttachment}
              testId={`${testId}-case`}
              disabled={busy}
            />
          </div>

          {bugs.length > 0 && (
            <ul className={styles.bugs} {...{ 'data-testid': `${testId}-bugs` }}>
              {bugs.map((bug) => (
                <li key={bug.id}>
                  <a href={bug.url} target="_blank" rel="noreferrer" {...{ 'data-testid': `${testId}-bug-${bug.id}` }}>
                    Bug #{bug.id}
                  </a>
                  {` ${bug.title}`}
                </li>
              ))}
            </ul>
          )}

          {error && <p className={styles.error} role="alert">{error}</p>}

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondaryBtn}
              disabled={busy || !dirty}
              onClick={() => { void saveThen(async () => undefined); }}
              {...{ 'data-testid': `${testId}-save` }}
            >
              Save progress
            </button>
            {showCreateBug && (
              <button
                type="button"
                className={styles.bugBtn}
                disabled={busy}
                onClick={() => { void saveThen(() => actions.createBug.mutateAsync()); }}
                {...{ 'data-testid': `${testId}-create-bug` }}
              >
                Create Bug
              </button>
            )}
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={busy || !form.outcome}
              title={form.outcome ? undefined : 'Mark the test case Passed or Failed first'}
              onClick={() => { void saveThen(() => actions.publish.mutateAsync()); }}
              {...{ 'data-testid': `${testId}-publish` }}
            >
              {actions.publish.isPending ? 'Publishing…' : 'Publish results to Azure DevOps'}
            </button>
          </div>
        </>
      )}
    </section>
  );
};
