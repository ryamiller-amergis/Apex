import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { PlaybookStepRun, PlaybookSuspensionDetail } from '../../shared/types/playbook';
import { usePlaybookStepOutput } from '../hooks/usePlaybookRuns';
import { absoluteTime, stepStatusLabel } from './playbookStatusFormat';
import { PlaybookSuspensionDetail as SuspensionDetail } from './PlaybookSuspensionDetail';
import styles from './PlaybookStepDetailDrawer.module.css';

interface PlaybookStepDetailDrawerProps {
  project: string;
  runId: string;
  step: PlaybookStepRun;
  suspension?: PlaybookSuspensionDetail | null;
  onClose: () => void;
  'data-testid'?: string;
}

export const PlaybookStepDetailDrawer: React.FC<PlaybookStepDetailDrawerProps> = ({
  project,
  runId,
  step,
  suspension,
  onClose,
  'data-testid': testId = 'playbook-step-detail',
}) => {
  const [loadFullOutput, setLoadFullOutput] = useState(false);
  const output = usePlaybookStepOutput(project, runId, step.id, loadFullOutput);
  const outputUrl = `/api/playbooks/runs/${encodeURIComponent(runId)}`
    + `/steps/${encodeURIComponent(step.id)}`
    + `/output?project=${encodeURIComponent(project)}&part=full`;

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={onClose}>
      <aside
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-labelledby="playbook-step-detail-title"
        onMouseDown={(event) => event.stopPropagation()}
        data-testid={testId}
      >
        <header className={styles.header}>
          <div>
            <h2 id="playbook-step-detail-title" className={styles.title}>{step.stepId}</h2>
            <p className={styles.meta}>
              {step.stepType} · {stepStatusLabel(step.status)}
            </p>
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close step detail"
            data-testid="playbook-step-detail-close"
          >
            <X size={16} aria-hidden />
          </button>
        </header>

        <section className={styles.section}>
          <h3>Timing</h3>
          <p>
            {step.startedAt ? `Started ${absoluteTime(step.startedAt)}` : 'Not started'}
            {step.completedAt ? ` · Finished ${absoluteTime(step.completedAt)}` : ''}
          </p>
        </section>

        <section className={styles.section}>
          <h3>Resolved input</h3>
          <pre className={styles.code}>{JSON.stringify(step.inputInline ?? {}, null, 2)}</pre>
        </section>

        <section className={styles.section}>
          <h3>Output summary</h3>
          <pre className={styles.code}>{JSON.stringify(step.outputInline ?? {}, null, 2)}</pre>
          <p>
            {step.outputBlobRef
              ? `${step.outputBlobRef.sizeBytes.toLocaleString()} bytes · ${
                  output.data ? 'checksum verified' : 'checksum verified when opened'
                }`
              : 'Stored inline'}
          </p>
          {step.status === 'completed' ? (
            <div>
              <button
                type="button"
                className={styles.action}
                onClick={() => setLoadFullOutput(true)}
                disabled={output.isFetching}
                data-testid="playbook-step-output-preview"
              >
                {output.isFetching ? 'Loading…' : 'Preview full output'}
              </button>
              {' '}
              <a
                className={styles.action}
                href={outputUrl}
                download
                data-testid="playbook-step-output-download"
              >
                Download
              </a>
            </div>
          ) : null}
          {output.isError ? (
            <p className={styles.error}>Full output is unavailable or the output feature is disabled.</p>
          ) : null}
          {output.data ? (
            <>
              <h3>Full output</h3>
              <pre className={styles.code}>{JSON.stringify(output.data, null, 2)}</pre>
            </>
          ) : null}
        </section>

        {step.agentRunId ? (
          <section className={styles.section}>
            <h3>Agent run</h3>
            <code>{step.agentRunId}</code>
          </section>
        ) : null}

        {suspension?.stepId === step.stepId ? (
          <section className={styles.section}>
            <SuspensionDetail suspension={suspension} />
          </section>
        ) : null}
      </aside>
    </div>
  );
};

export default PlaybookStepDetailDrawer;
