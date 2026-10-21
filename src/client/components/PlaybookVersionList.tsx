import React, { useEffect, useRef, useState } from 'react';
import type {
  PlaybookPublishedVersionSummary,
} from '../../shared/types/playbook';
import { useDeprecatePlaybookVersion } from '../hooks/usePlaybookDefinitions';
import styles from './PlaybookDefinition.module.css';

interface PlaybookVersionListProps {
  project: string;
  definitionId: string;
  versions: PlaybookPublishedVersionSummary[];
  currentPublishedVersionId: string | null;
  canAuthor: boolean;
}

export const PlaybookVersionList: React.FC<PlaybookVersionListProps> = ({
  project,
  definitionId,
  versions,
  currentPublishedVersionId,
  canAuthor,
}) => {
  const deprecate = useDeprecatePlaybookVersion(project, definitionId);
  const [confirming, setConfirming] = useState<PlaybookPublishedVersionSummary | null>(null);
  const [status, setStatus] = useState('');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const closeDialog = () => {
    setConfirming(null);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const confirmDeprecation = async () => {
    if (!confirming) return;
    const versionNumber = confirming.versionNumber;
    try {
      await deprecate.mutateAsync({ versionId: confirming.id });
      setStatus(`Version ${versionNumber} deprecated.`);
      closeDialog();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not deprecate the version.');
    }
  };

  return (
    <section aria-labelledby="playbook-versions-heading">
      <h3 id="playbook-versions-heading" className={styles.subheading}>Version history</h3>
      <div aria-live="polite" className={styles.status}>{status}</div>
      <div {...{ 'data-testid': 'playbook-version-list' }}>
        {versions.length === 0 ? (
          <p className={styles.empty}>No published versions yet.</p>
        ) : (
          <ul className={styles.versionList}>
            {versions.map((version) => (
              <li className={styles.versionRow} key={version.id}>
                <div className={styles.versionMeta}>
                  <strong>Version {version.versionNumber}</strong>
                  <span>{version.status}</span>
                  {version.id === currentPublishedVersionId ? (
                    <span
                      className={styles.current}
                      {...{ 'data-testid': 'playbook-version-current' }}
                    >
                      Current
                    </span>
                  ) : null}
                </div>
                {canAuthor && version.status === 'published' ? (
                  <button
                    ref={(element) => {
                      if (confirming?.id === version.id || !confirming) triggerRef.current = element;
                    }}
                    type="button"
                    className={styles.dangerButton}
                    onClick={() => {
                      triggerRef.current = document.activeElement as HTMLButtonElement;
                      setConfirming(version);
                    }}
                    disabled={deprecate.isPending}
                    {...{ 'data-testid': 'playbook-version-deprecate' }}
                  >
                    Deprecate
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {confirming ? (
        <div className={styles.overlay}>
          <div
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="playbook-deprecate-title"
            {...{ 'data-testid': 'playbook-deprecate-dialog' }}
          >
            <h3 id="playbook-deprecate-title">Deprecate version {confirming.versionNumber}?</h3>
            <p>
              New runs cannot select this version. Existing pinned runs continue on this immutable
              snapshot.
            </p>
            <div className={styles.dialogActions}>
              <button
                type="button"
                className={styles.button}
                onClick={closeDialog}
                disabled={deprecate.isPending}
                {...{ 'data-testid': 'playbook-version-deprecate-cancel' }}
              >
                Cancel
              </button>
              <button
                ref={confirmRef}
                type="button"
                className={styles.dangerButton}
                onClick={() => void confirmDeprecation()}
                disabled={deprecate.isPending}
                {...{ 'data-testid': 'playbook-version-deprecate-confirm' }}
              >
                {deprecate.isPending ? 'Deprecating…' : 'Deprecate version'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
};

export default PlaybookVersionList;
