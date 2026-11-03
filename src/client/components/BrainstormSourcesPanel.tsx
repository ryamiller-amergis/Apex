import React, { useMemo, useState } from 'react';
import type { BrainstormSessionDetail } from '../../shared/types/brainstorm';
import { BrainstormApiError } from '../hooks/useBrainstormSessions';
import {
  useAttachBrainstormSource,
  useBrainstormSourceOptions,
  useBrainstormSources,
  useRemoveBrainstormSource,
} from '../hooks/useBrainstormSources';
import { BrainstormAddSourceModal, attachErrorMessage } from './BrainstormAddSourceModal';
import { BrainstormSourceRow } from './BrainstormSourceRow';
import styles from './BrainstormSourcesPanel.module.css';

interface BrainstormSourcesPanelProps {
  project: string;
  session: BrainstormSessionDetail;
}

export const BrainstormSourcesPanel: React.FC<BrainstormSourcesPanelProps> = ({ project, session }) => {
  const [open, setOpen] = useState(false);
  const sources = useBrainstormSources(project, session.id);
  const options = useBrainstormSourceOptions(project, session.id, session.state === 'active');
  const attach = useAttachBrainstormSource(project, session.id);
  const remove = useRemoveBrainstormSource(project, session.id);

  const rows = useMemo(
    () => (sources.data ?? []).filter((row) => row.state !== 'removed'),
    [sources.data],
  );
  const defaultRepos = useMemo(() => {
    if (!options.data) return [];
    return (options.data.repositories ?? [])
      .filter((repo) => repo.isDefault && repo.ready && !repo.alreadyAttached)
      .map((repo) => ({
        id: repo.skillSettingsId,
        displayName: repo.displayName,
        kindLabel: 'Project repository',
      }));
  }, [options.data]);

  const ended = session.state === 'ended';
  const hasDefaults = defaultRepos.length > 0;

  return (
    <section className={styles.panel} aria-label="Sources" {...{ 'data-testid': 'brainstorm-sources-panel' }}>
      <div className={styles.toolbar}>
        <h2 className={styles.heading}>Sources</h2>
        {session.canMutate && session.state === 'active' && (
          <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => setOpen(true)} {...{ 'data-testid': 'brainstorm-add-source-button' }}>
            Add source
          </button>
        )}
      </div>
      {ended && (
        <p className={styles.notice} {...{ 'data-testid': 'brainstorm-sources-ended-notice' }}>
          Session ended — clones removed
        </p>
      )}
      {sources.isError && <p className={styles.error} role="alert">Sources could not be loaded.</p>}
      {rows.length === 0 && !hasDefaults && !sources.isLoading && !sources.isError && (
        <p className={styles.empty}>
          No extra sources yet. The project repository is included when it is ready. Add a repository or MCP server when you want the collaborator to use it.
        </p>
      )}
      {rows.length > 0 && (
        <ul className={styles.list}>
          {rows.map((row) => (
            <BrainstormSourceRow
              key={row.id}
              source={row}
              canMutate={session.canMutate && session.state === 'active'}
              removing={remove.isPending}
              onRemove={(sourceId) => { void remove.mutate(sourceId); }}
            />
          ))}
        </ul>
      )}
      {!ended && hasDefaults && (
        <div className={styles.defaultSection}>
          <p className={styles.defaultHeader}>Project repository</p>
          <ul className={styles.list} {...{ 'data-testid': 'brainstorm-default-sources-list' }}>
            {defaultRepos.map((repo) => (
              <li
                key={`repo-${repo.id}`}
                className={styles.row}
                {...{ 'data-testid': `brainstorm-default-source-repo-${repo.id}` }}
              >
                <div>
                  <p className={styles.name}>{repo.displayName}</p>
                  <p className={styles.status}>{repo.kindLabel} · Ready</p>
                </div>
                <span className={styles.defaultBadge}>Default</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* data-testid-exempt — BrainstormAddSourceModal owns brainstorm-add-source-modal */}
      <BrainstormAddSourceModal
        open={open}
        options={options.data}
        optionsError={options.error instanceof BrainstormApiError ? options.error.message : null}
        pending={attach.isPending}
        serverError={attach.error ? attachErrorMessage(attach.error) : null}
        onClose={() => setOpen(false)}
        onAttach={(body) => {
          attach.mutate(body, { onSuccess: () => setOpen(false) });
        }}
      />
    </section>
  );
};
