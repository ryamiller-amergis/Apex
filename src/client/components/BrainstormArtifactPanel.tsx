import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useQueryClient } from '@tanstack/react-query';
import type { BrainstormSessionDetail } from '../../shared/types/brainstorm';
import {
  BRAINSTORM_ARTIFACT_TYPE_LABELS,
  type BrainstormArtifactType,
} from '../../shared/types/brainstormArtifact';
import { BrainstormApiError } from '../hooks/useBrainstormSessions';
import { brainstormArtifactKeys, useBrainstormArtifact, useSwitchArtifactType } from '../hooks/useBrainstormArtifact';
import { BrainstormCheckpointField } from './BrainstormCheckpointField';
import { BrainstormNextActionsPanel, type BrainstormActionRequest } from './BrainstormNextActionsPanel';
import { BrainstormVersionHistoryDrawer } from './BrainstormVersionHistoryDrawer';
import styles from './BrainstormArtifactPanel.module.css';

export const ARTIFACT_EMPTY_TEXT = 'No artifact yet — ask the collaborator to draft one';

interface BrainstormArtifactPanelProps {
  project: string;
  session: BrainstormSessionDetail;
  turnRunning: boolean;
  actionRequest?: BrainstormActionRequest | null;
}

interface PendingSwitch {
  targetType: BrainstormArtifactType;
  turnStarted: boolean;
}

function typeSwitchError(err: unknown): string {
  const code = err instanceof BrainstormApiError ? err.code : null;
  if (code === 'TURN_IN_PROGRESS') return 'Wait for the collaborator to finish, then change the type.';
  if (code === 'ARTIFACT_VERSION_CONFLICT') return 'The artifact changed. Review the current version, then try again.';
  return 'We could not change the type. Try again.';
}

export const BrainstormArtifactPanel: React.FC<BrainstormArtifactPanelProps> = ({
  project,
  session,
  turnRunning,
  actionRequest = null,
}) => {
  const client = useQueryClient();
  const artifactQuery = useBrainstormArtifact(project, session, turnRunning);
  const switchType = useSwitchArtifactType(project, session.id);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [readerOpen, setReaderOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(null as PendingSwitch | null);
  const [typeError, setTypeError] = useState<{ message: string; retryType: BrainstormArtifactType } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const lastVersion = useRef<{ version: number; type: BrainstormArtifactType | null } | null>(null);
  const historyButton = useRef<HTMLButtonElement>(null);

  const artifact = artifactQuery.data;
  const canMutate = session.canMutate && session.state === 'active';

  useEffect(() => {
    if (!artifact) return;
    const previous = lastVersion.current;
    if (previous !== null && artifact.version !== previous.version) {
      const typeChanged = artifact.type !== previous.type && artifact.type !== null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- announce version transitions to screen readers when query data updates
      setAnnouncement(
        typeChanged
          ? `Artifact updated to version ${artifact.version}. Type is now ${BRAINSTORM_ARTIFACT_TYPE_LABELS[artifact.type!]}`
          : `Artifact updated to version ${artifact.version}`,
      );
      void client.invalidateQueries({ queryKey: brainstormArtifactKeys.actions(project, session.id) });
      void client.invalidateQueries({ queryKey: brainstormArtifactKeys.versions(project, session.id) });
    }
    lastVersion.current = { version: artifact.version, type: artifact.type };
  }, [artifact, client, project, session.id]);

  // A reshaping turn either changes the type or ends without it; the second case offers Retry.
  useEffect(() => {
    if (!pending || !artifact) return;
    if (artifact.type === pending.targetType) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear reshaping state once the target artifact type arrives
      setPending(null);
      return;
    }
    if (turnRunning && !pending.turnStarted) {
      setPending({ ...pending, turnStarted: true });
    } else if (!turnRunning && pending.turnStarted && !artifactQuery.isFetching) {
      setPending(null);
      setTypeError({
        message: `The collaborator did not reshape the artifact as ${BRAINSTORM_ARTIFACT_TYPE_LABELS[pending.targetType]}.`,
        retryType: pending.targetType,
      });
    }
  }, [artifact, artifactQuery.isFetching, pending, turnRunning]);

  const requestType = async (type: BrainstormArtifactType) => {
    if (!artifact) return;
    setTypeError(null);
    try {
      const result = await switchType.mutateAsync({ type, expectedVersion: artifact.version });
      if (result.kind === 'reshaping') setPending({ targetType: type, turnStarted: false });
    } catch (err) {
      setTypeError({ message: typeSwitchError(err), retryType: type });
    }
  };

  const closeHistory = () => {
    setHistoryOpen(false);
    historyButton.current?.focus();
  };

  const handleCopyMarkdown = async () => {
    if (!artifact?.markdown) return;
    try {
      await navigator.clipboard?.writeText(artifact.markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      // Ignore clipboard failures
    }
  };

  if (artifactQuery.isLoading) {
    return (
      <section className={styles.panel} aria-label="Artifact" aria-busy="true" {...{ 'data-testid': 'brainstorm-artifact-panel' }}>
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={`${styles.skeletonRow} ${styles.skeletonShort}`} />
      </section>
    );
  }

  if (artifactQuery.isError || !artifact) {
    return (
      <section className={styles.panel} aria-label="Artifact" {...{ 'data-testid': 'brainstorm-artifact-panel' }}>
        <div className={styles.banner} role="alert" {...{ 'data-testid': 'brainstorm-artifact-error' }}>
          <p>We could not load the artifact.</p>
          <button type="button" className={styles.button} onClick={() => { void artifactQuery.refetch(); }} {...{ 'data-testid': 'brainstorm-artifact-retry' }}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  const hasContent = artifact.markdown.trim().length > 0;

  return (
    <section className={styles.panel} aria-label="Artifact" {...{ 'data-testid': 'brainstorm-artifact-panel' }}>
      <div className={styles.header}>
        <div className={styles.typeField}>
          <span className={styles.fieldLabel}>Format</span>
          <span className={styles.typeBadge} {...{ 'data-testid': 'brainstorm-artifact-type-badge' }}>
            {artifact.type ? BRAINSTORM_ARTIFACT_TYPE_LABELS[artifact.type] : 'Explore'}
          </span>
        </div>
        <span className={styles.version}>{artifact.version > 0 ? `Version ${artifact.version}` : 'No versions'}</span>
        <div className={styles.headerActions}>
          {hasContent && (
            <>
              <button
                type="button"
                className={styles.button}
                onClick={() => { void handleCopyMarkdown(); }}
                {...{ 'data-testid': 'brainstorm-artifact-copy' }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                className={styles.button}
                onClick={() => setReaderOpen(true)}
                {...{ 'data-testid': 'brainstorm-artifact-reader-open' }}
              >
                Full view
              </button>
            </>
          )}
          <button
            ref={historyButton}
            type="button"
            className={styles.button}
            onClick={() => setHistoryOpen(true)}
            disabled={artifact.version === 0}
            aria-expanded={historyOpen}
            {...{ 'data-testid': 'brainstorm-history-open' }}
          >
            History
          </button>
        </div>
      </div>

      {!session.canMutate && (
        <p className={styles.notice} role="status" {...{ 'data-testid': 'brainstorm-readonly-notice' }}>
          You can read this artifact. Only the session creator can change it.
        </p>
      )}

      {pending && (
        <p className={styles.notice} role="status">
          Reshaping the artifact as {BRAINSTORM_ARTIFACT_TYPE_LABELS[pending.targetType]}…
        </p>
      )}

      {typeError && (
        <div className={styles.banner} role="alert" {...{ 'data-testid': 'brainstorm-artifact-type-error' }}>
          <p>{typeError.message}</p>
          {canMutate && (
            <button
              type="button"
              className={styles.button}
              disabled={turnRunning || switchType.isPending}
              onClick={() => { void requestType(typeError.retryType); }}
              {...{ 'data-testid': 'brainstorm-artifact-type-retry' }}
            >
              Retry
            </button>
          )}
        </div>
      )}

      {artifact.lastChangeFailure && (
        <div className={styles.banner} role="alert" {...{ 'data-testid': 'brainstorm-artifact-change-failure' }}>
          <p>{artifact.lastChangeFailure.summary}</p>
        </div>
      )}

      {hasContent ? (
        <div className={`${styles.body} ${styles.markdownDoc}`} {...{ 'data-testid': 'brainstorm-artifact-body' }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{artifact.markdown}</ReactMarkdown>
        </div>
      ) : (
        <p className={styles.empty} {...{ 'data-testid': 'brainstorm-artifact-empty' }}>{ARTIFACT_EMPTY_TEXT}</p>
      )}

      {canMutate && hasContent && artifact.version > 0 && (
        // data-testid-exempt — BrainstormCheckpointField owns brainstorm-checkpoint-input and -save
        <BrainstormCheckpointField
          project={project}
          sessionId={session.id}
          version={artifact.version}
          checkpointName={artifact.checkpointName}
          disabled={turnRunning}
        />
      )}

      {/* data-testid-exempt — BrainstormNextActionsPanel owns brainstorm-next-actions */}
      <BrainstormNextActionsPanel
        project={project}
        sessionId={session.id}
        artifact={artifact}
        canMutate={canMutate}
        request={actionRequest}
      />

      <div className={styles.srOnly} aria-live="polite" {...{ 'data-testid': 'brainstorm-artifact-live' }}>
        {announcement}
      </div>

      {readerOpen && hasContent && (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- modal dialog handles Escape to close
        <div
          className={styles.readerBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label="Artifact full view"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setReaderOpen(false);
            }
          }}
          {...{ 'data-testid': 'brainstorm-artifact-reader-modal' }}
        >
          <button
            type="button"
            className={styles.readerBackdropButton}
            aria-label="Close full view"
            tabIndex={-1}
            onClick={() => setReaderOpen(false)}
            {...{ 'data-testid': 'brainstorm-artifact-reader-backdrop' }}
          />
          <div className={styles.readerDialog}>
            <div className={styles.readerHeader}>
              <div className={styles.readerMeta}>
                <span className={styles.readerBadge}>
                  {artifact.type ? BRAINSTORM_ARTIFACT_TYPE_LABELS[artifact.type] : 'Untyped artifact'}
                </span>
                <span className={styles.version}>Version {artifact.version}</span>
                {artifact.checkpointName && (
                  <span className={styles.checkpointBadge}>{artifact.checkpointName}</span>
                )}
              </div>
              <div className={styles.headerActions}>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => { void handleCopyMarkdown(); }}
                  {...{ 'data-testid': 'brainstorm-artifact-reader-copy' }}
                >
                  {copied ? 'Copied' : 'Copy Markdown'}
                </button>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => setReaderOpen(false)}
                  {...{ 'data-testid': 'brainstorm-artifact-reader-close' }}
                >
                  Close
                </button>
              </div>
            </div>
            <div className={`${styles.readerBody} ${styles.markdownDoc}`} {...{ 'data-testid': 'brainstorm-artifact-reader-body' }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{artifact.markdown}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}

      {historyOpen && (
        // data-testid-exempt — BrainstormVersionHistoryDrawer owns brainstorm-history-drawer
        <BrainstormVersionHistoryDrawer
          project={project}
          sessionId={session.id}
          currentVersion={artifact.version}
          canMutate={canMutate}
          turnRunning={turnRunning}
          onClose={closeHistory}
        />
      )}
    </section>
  );
};
