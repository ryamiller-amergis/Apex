import React, { useState } from 'react';
import type { PlaybookDryRunResult, PlaybookGraph } from '../../shared/types/playbook';
import { PLAYBOOK_DRY_RUN_LIMIT } from '../../shared/types/playbook';
import { usePlaybookDryRun } from '../hooks/usePlaybookCanvas';
import styles from './PlaybookCanvas.module.css';

interface PlaybookDryRunPanelProps {
  project: string;
  definitionId: string;
  graph: PlaybookGraph;
  'data-testid'?: string;
}

export const PlaybookDryRunPanel: React.FC<PlaybookDryRunPanelProps> = ({
  project,
  definitionId,
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
    try {
      const response = await dryRun.mutateAsync(stubs);
      setResult(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dry run failed.');
    }
  };

  return (
    <section className={styles.dryRunPanel} aria-labelledby="playbook-dry-run-heading" {...{ 'data-testid': testId }}>
      <h3 id="playbook-dry-run-heading">Dry run</h3>
      <p className={styles.nodeMeta}>{PLAYBOOK_DRY_RUN_LIMIT}</p>
      <label className={styles.label}>
        Stub step outputs (JSON map of node id → output)
        <textarea
          className={styles.configField}
          value={stubsJson}
          onChange={(event) => setStubsJson(event.target.value)}
          {...{ 'data-testid': 'playbook-dry-run-stubs' }}
        />
      </label>
      <button
        type="button"
        className={styles.button}
        disabled={dryRun.isPending}
        onClick={() => void runDryRun()}
        {...{ 'data-testid': 'playbook-dry-run-submit' }}
      >
        {dryRun.isPending ? 'Running…' : 'Run dry run'}
      </button>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {result ? (
        <div {...{ 'data-testid': 'playbook-dry-run-result', 'data-verdict': result.verdict }}>
          <p>
            Verdict: <strong>{result.verdict}</strong>
          </p>
          {result.issues.length ? (
            <ul>
              {result.issues.map((issue) => (
                <li key={`${issue.nodeId}-${issue.kind}-${issue.message}`}>
                  [{issue.kind}] {issue.nodeId ? `${issue.nodeId}: ` : ''}{issue.message}
                </li>
              ))}
            </ul>
          ) : (
            <p>No issues reported.</p>
          )}
          {result.authorFootnote.missing.length ? (
            <p className={styles.error}>
              Missing permissions: {result.authorFootnote.missing.join(', ')}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
};

export default PlaybookDryRunPanel;
