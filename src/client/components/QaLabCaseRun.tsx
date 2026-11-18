import React, { useMemo, useRef, useState } from 'react';
import type {
  QaLabCaseRun as QaLabCaseRunRecord,
  QaLabRunAttachment,
  QaLabRunOutcome,
  QaLabRunStepResult,
} from '../../shared/types/qaLab';
import { caseRunUrl, useCaseRun, useCaseRunActions } from '../hooks/useQaLab';
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
    steps: new Map((run?.stepResults ?? []).map(({ order, outcome, comment }) => [order, { order, outcome, comment }])),
  };
}

/** Failed when any step failed, Passed when every step passed, otherwise no suggestion. */
export function suggestedOutcome(orders: number[], steps: Map<number, QaLabRunStepResult>): QaLabRunOutcome | null {
  const outcomes = orders.map((order) => steps.get(order)?.outcome ?? null);
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
  fileUrl: (id: string) => string;
  onAdd: (file: File) => void;
  onRemove: (id: string) => void;
  testId: string;
  disabled: boolean;
}> = ({ attachments, fileUrl, onAdd, onRemove, testId, disabled }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={styles.attachments}>
      {attachments.map((attachment) => (
        <span key={attachment.id} className={styles.attachment}>
          <a
            href={fileUrl(attachment.id)}
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
  open: boolean;
  onClose: () => void;
}

/**
 * Records a manual run of a case in Apex; the results go to Azure DevOps when the case is published.
 * Stays mounted while closed so unsaved results survive hiding the panel.
 */
export const QaLabCaseRun: React.FC<QaLabCaseRunProps> = ({ suiteId, localCaseId, open, onClose }) => {
  const runQuery = useCaseRun(suiteId, localCaseId, open);
  const actions = useCaseRunActions(suiteId, localCaseId);
  const [form, setForm] = useState(() => formFrom(null));
  const [dirty, setDirty] = useState(false);
  const [confirmingBug, setConfirmingBug] = useState(false);
  const testId = `qa-lab-run-${localCaseId}`;

  const state = runQuery.data;
  const draft = state?.draft ?? null;
  const steps = useMemo(() => state?.steps ?? [], [state]);
  const orders = useMemo(() => steps.map((step) => step.order), [steps]);
  const adoTestCase = state?.adoTestCase ?? null;

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

  const updateStep = (order: number, next: Partial<QaLabRunStepResult>) => {
    setForm((current) => {
      const stepResults = new Map(current.steps);
      const previous = stepResults.get(order) ?? { order, outcome: null, comment: '' };
      stepResults.set(order, { ...previous, ...next });
      const outcome = current.outcome ?? suggestedOutcome(orders, stepResults);
      return { ...current, steps: stepResults, outcome: next.outcome === 'failed' ? 'failed' : outcome };
    });
    setDirty(true);
  };

  const saveForm = async () => {
    await actions.save.mutateAsync({
      outcome: form.outcome,
      comment: form.comment,
      stepResults: orders.flatMap((order) => {
        const step = form.steps.get(order);
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

  if (!open) return null;

  const fileUrl = (id: string) => `${caseRunUrl(suiteId, localCaseId)}/attachments/${encodeURIComponent(id)}`;
  const attachmentsFor = (stepOrder?: number) => (draft?.attachments ?? [])
    .filter((attachment) => attachment.stepOrder === stepOrder);
  const attach = (stepOrder?: number) => (file: File) => {
    void saveThen(() => actions.attach.mutateAsync({ file, ...(stepOrder !== undefined ? { stepOrder } : {}) }));
  };
  const removeAttachment = (id: string) => {
    void actions.removeAttachment.mutateAsync(id).catch(() => undefined);
  };
  const lastPublished = state?.lastPublished ?? null;
  // With nothing recorded since the last publish, a Bug is filed against that run.
  const bugRun = draft || dirty ? null : lastPublished;
  const bugs = (draft ?? bugRun)?.bugs ?? [];
  const showCreateBug = canFileBug(bugRun ? formFrom(bugRun) : form);
  const changedSteps = state?.changedSteps ?? [];

  return (
    <section className={styles.run} {...{ 'data-testid': testId }}>
      <header className={styles.runHeader}>
        <h4 className={styles.runTitle}>Run this test</h4>
        {adoTestCase && (
          <span className={styles.runWhere}>
            <a href={adoTestCase.url} target="_blank" rel="noreferrer" {...{ 'data-testid': `${testId}-case-link` }}>
              Test Case #{adoTestCase.id}
            </a>
          </span>
        )}
        <button
          type="button"
          className={styles.linkBtn}
          onClick={onClose}
          {...{ 'data-testid': `${testId}-close` }}
        >
          Close
        </button>
      </header>

      {runQuery.isLoading && <p className={styles.note}>Loading the run…</p>}
      {state && !adoTestCase && (
        <p className={styles.note} {...{ 'data-testid': `${testId}-unpublished` }}>
          Results are saved in Apex. They go to Azure DevOps with the case when you publish.
        </p>
      )}
      {changedSteps.length > 0 && (
        <p className={styles.note} {...{ 'data-testid': `${testId}-changed` }}>
          Step {changedSteps.join(', ')} changed since you tested {changedSteps.length === 1 ? 'it' : 'them'}. Record {changedSteps.length === 1 ? 'it' : 'them'} again.
        </p>
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

      {state && (
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
              {steps.map((step) => {
                const result = form.steps.get(step.order);
                const stepTestId = `${testId}-step-${step.order}`;
                return (
                  <tr key={step.order} className={result?.outcome === 'failed' ? styles.rowFailed : undefined}>
                    <td className={styles.numberCol}>{step.order}</td>
                    <td className={styles.multiline}>{step.action}</td>
                    <td className={styles.multiline}>{step.expected}</td>
                    <td className={styles.resultCol}>
                      <OutcomeButtons
                        value={result?.outcome ?? null}
                        onChange={(outcome) => updateStep(step.order, { outcome })}
                        data-testid={stepTestId}
                        disabled={busy}
                      />
                      <textarea
                        className={styles.comment}
                        rows={2}
                        maxLength={4000}
                        placeholder={result?.outcome === 'failed' ? 'What happened instead?' : 'Comment'}
                        value={result?.comment ?? ''}
                        onChange={(event) => updateStep(step.order, { comment: event.target.value })}
                        aria-label={`Comment on step ${step.order}`}
                        {...{ 'data-testid': `${stepTestId}-comment` }}
                      />
                      <Attachments
                        attachments={attachmentsFor(step.order)}
                        fileUrl={fileUrl}
                        onAdd={attach(step.order)}
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
              fileUrl={fileUrl}
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

          {confirmingBug && (
            <div className={styles.confirm} role="group" aria-label="Create Bug" {...{ 'data-testid': `${testId}-bug-confirm` }}>
              <p className={styles.confirmText}>
                This creates a Bug in Azure DevOps now, as a child of the PBI, with the failed steps, comments and attachments.
                {adoTestCase ? '' : ' It is linked to the Test Case when you publish.'}
              </p>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  disabled={busy}
                  onClick={() => setConfirmingBug(false)}
                  {...{ 'data-testid': `${testId}-bug-cancel` }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={styles.bugBtn}
                  disabled={busy}
                  onClick={() => {
                    void saveThen(async () => {
                      await actions.createBug.mutateAsync();
                      setConfirmingBug(false);
                    });
                  }}
                  {...{ 'data-testid': `${testId}-bug-submit` }}
                >
                  {actions.createBug.isPending ? 'Creating…' : 'Create Bug in Azure DevOps'}
                </button>
              </div>
            </div>
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
            {showCreateBug && !confirmingBug && (
              <button
                type="button"
                className={styles.bugBtn}
                disabled={busy}
                onClick={() => setConfirmingBug(true)}
                {...{ 'data-testid': `${testId}-create-bug` }}
              >
                Create Bug
              </button>
            )}
            {adoTestCase && (
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
            )}
          </div>
        </>
      )}
    </section>
  );
};
