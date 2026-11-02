import React from 'react';
import type { BrainstormSourceDto } from '../../shared/types/brainstormSources';
import styles from './BrainstormSourcesPanel.module.css';

export function sourceStatusText(source: BrainstormSourceDto, canMutate: boolean): string {
  if (source.kind === 'mcp-server' && source.state === 'ready') {
    return `Read-only tools: ${source.mcpReadOnlyToolCount ?? 0}`;
  }
  if (source.state === 'preparing') {
    return source.kind === 'project-repository' ? 'Copying the saved clone' : 'Cloning';
  }
  if (source.state === 'restoring') return 'Restoring';
  if (source.state === 'removing') return 'Removing';
  if (source.state === 'failed') return source.reasonText || 'Failed';
  if (source.state === 'ready') {
    return source.commitSha ? `Ready ${source.commitSha.slice(0, 7)}` : 'Ready';
  }
  if (source.state === 'cleaned' || source.state === 'unavailable') {
    if (!canMutate) return 'Not loaded (idle)';
    return source.reasonText || 'Unavailable — will re-clone on next message';
  }
  return source.state;
}

export const BrainstormSourceRow: React.FC<{
  source: BrainstormSourceDto;
  canMutate: boolean;
  removing: boolean;
  onRemove: (sourceId: string) => void;
}> = ({ source, canMutate, removing, onRemove }) => {
  const status = sourceStatusText(source, canMutate);
  const busy = source.state === 'preparing' || source.state === 'restoring' || source.state === 'removing';
  return (
    <li className={styles.row} {...{ 'data-testid': `brainstorm-source-row-${source.id}` }}>
      <div>
        <p className={styles.name}>{source.displayName}</p>
        <p
          className={styles.status}
          title={source.commitSha ?? undefined}
          aria-busy={busy}
          {...{ 'data-testid': `brainstorm-source-status-${source.id}` }}
        >
          {busy && (
            <span className={styles.spinner} aria-hidden="true" {...{ 'data-testid': `brainstorm-source-busy-${source.id}` }} />
          )}
          {status}
        </p>
      </div>
      {canMutate && source.state !== 'removing' && source.state !== 'removed' && (
        <button
          type="button"
          className={styles.button}
          disabled={removing}
          onClick={() => onRemove(source.id)}
          {...{ 'data-testid': `brainstorm-source-remove-${source.id}` }}
        >
          Remove
        </button>
      )}
    </li>
  );
};
