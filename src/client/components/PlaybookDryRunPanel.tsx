import React, { useState } from 'react';
import { CircleCheck, CircleX, FlaskConical, X } from 'lucide-react';
import type { PlaybookDryRunResult } from '../../shared/types/playbook';
import { PLAYBOOK_DRY_RUN_LIMIT } from '../../shared/types/playbook';
import { usePlaybookDryRun } from '../hooks/usePlaybookCanvas';
import styles from './PlaybookBuilder.module.css';

interface PlaybookDryRunPanelProps {
  project: string;
  definitionId: string;
  /** True when the canvas has edits the server has not seen. */
  dirty: boolean;
  /** Saves pending edits first, because the check runs against the saved draft. */
  onBeforeRun: () => Promise<boolean>;
  onSelectNode: (nodeId: string) => void;
  onClose: () => void;
  'data-testid'?: string;
}

const ISSUE_KIND_LABELS: Record<string, string> = {
  graph: 'Structure',
  stub: 'Stub output',
  branch: 'Branch',
};

export const PlaybookDryRunPanel: React.FC<PlaybookDryRunPanelProps> = ({
  project,
  definitionId,
  dirty,
  onBeforeRun,
  onSelectNode,
  onClose,
  'data-testid': testId = 'playbook-dry-run-panel',
}) => {
  const dryRun = usePlaybookDryRun(project, definitionId);
  const [stubsJson, setStubsJson] = useState('{}');
  const [result, setResult] = useState<PlaybookDryRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runDryRun = async () => {
    setError(null);
    setResult(null);
    let stubs: Record<string, unknown> = {};
    try {
      stubs = JSON.parse(stubsJson) as Record<string, unknown>;
    } catch {
      setError('Stub outputs must be valid JSON.');
      return;
    }
    if (dirty && !(await onBeforeRun())) return;
    try {
      setResult(await dryRun.mutateAsync(stubs));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test run failed.');
    }
  };

  return (
    <aside
      className={styles.drawer}
      aria-labelledby="playbook-dry-run-heading"
      {...{ 'data-testid': testId }}
    >
      <header className={styles.drawerHeader}>
        <FlaskConical size={16} aria-hidden className={styles.drawerIcon} />
        <h2 id="playbook-dry-run-heading" className={styles.drawerTitle}>Test run</h2>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onClose}
          aria-label="Close test run"
          {...{ 'data-testid': 'playbook-dry-run-close' }}
        >
          <X size={16} aria-hidden />
        </button>
      </header>

      <p className={styles.drawerLead}>
        Walks the saved draft without running anything: structure, permissions, and which branches
        can be reached.
      </p>

      <button
        type="button"
        className={styles.primaryButton}
        disabled={dryRun.isPending}
        onClick={() => void runDryRun()}
        {...{ 'data-testid': 'playbook-dry-run-submit' }}
      >
        {dryRun.isPending ? 'Checking…' : dirty ? 'Save and check' : 'Run check'}
      </button>

      {error ? <p className={styles.inlineError} role="alert">{error}</p> : null}

      {result ? (
        <div
          className={styles.verdict}
          {...{ 'data-testid': 'playbook-dry-run-result', 'data-verdict': result.verdict }}
        >
          <p className={styles.verdictLine}>
            {result.verdict === 'passed' ? (
              <CircleCheck size={16} aria-hidden />
            ) : (
              <CircleX size={16} aria-hidden />
            )}
            {result.verdict === 'passed'
              ? 'Passed — ready to publish.'
              : `Failed — ${result.issues.length} issue${result.issues.length === 1 ? '' : 's'} to fix.`}
          </p>
          {result.issues.length ? (
            <ul className={styles.issueList}>
              {result.issues.map((issue) => (
                <li key={`${issue.nodeId}-${issue.kind}-${issue.message}`} className={styles.issue}>
                  <span className={styles.issueKind}>{ISSUE_KIND_LABELS[issue.kind] ?? issue.kind}</span>
                  {issue.nodeId ? (
                    <button
                      type="button"
                      className={styles.issueNode}
                      onClick={() => onSelectNode(issue.nodeId)}
                      title="Show this step"
                      {...{ 'data-testid': `playbook-dry-run-issue-${issue.nodeId}` }}
                    >
                      {issue.nodeId}
                    </button>
                  ) : null}
                  <span className={styles.issueMessage}>{issue.message}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {result.authorFootnote.missing.length ? (
            <p className={styles.inlineError}>
              You are missing: {result.authorFootnote.missing.join(', ')}
            </p>
          ) : null}
        </div>
      ) : null}

      <details className={styles.disclosure}>
        <summary {...{ 'data-testid': 'playbook-dry-run-advanced' }}>Stub step outputs</summary>
        <p className={styles.fieldHint}>A JSON map of step id to the output it should pretend to return.</p>
        <textarea
          className={`${styles.fieldInput} ${styles.fieldCode}`}
          rows={5}
          spellCheck={false}
          value={stubsJson}
          onChange={(event) => setStubsJson(event.target.value)}
          aria-label="Stub step outputs"
          {...{ 'data-testid': 'playbook-dry-run-stubs' }}
        />
      </details>

      <details className={styles.disclosure}>
        <summary {...{ 'data-testid': 'playbook-dry-run-limits' }}>What this cannot check</summary>
        <p className={styles.fieldHint}>{PLAYBOOK_DRY_RUN_LIMIT}</p>
      </details>
    </aside>
  );
};

export default PlaybookDryRunPanel;
