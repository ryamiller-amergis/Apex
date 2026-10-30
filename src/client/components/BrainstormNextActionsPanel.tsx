import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BrainstormActionDto, BrainstormActionId, BrainstormArtifactDto } from '../../shared/types/brainstormArtifact';
import { BrainstormApiError } from '../hooks/useBrainstormSessions';
import { useBrainstormActions, useKeepStandalone } from '../hooks/useBrainstormActions';
import { BrainstormHandoffPreviewModal } from './BrainstormHandoffPreviewModal';
import styles from './BrainstormNextActionsPanel.module.css';

export const NEXT_ACTIONS_EMPTY = 'Next actions appear once the artifact has content';

export interface BrainstormActionRequest {
  actionId: BrainstormActionId;
  nonce: number;
}

interface BrainstormNextActionsPanelProps {
  project: string;
  sessionId: string;
  artifact: BrainstormArtifactDto;
  canMutate: boolean;
  request: BrainstormActionRequest | null;
}

const STATE_TEXT: Record<BrainstormActionDto['state'], string> = {
  available: '',
  unavailable: 'Not available yet',
  in_progress: 'Being created…',
  completed: 'Done',
};

export const BrainstormNextActionsPanel: React.FC<BrainstormNextActionsPanelProps> = ({
  project,
  sessionId,
  artifact,
  canMutate,
  request,
}) => {
  const actions = useBrainstormActions(project, sessionId);
  const keep = useKeepStandalone(project, sessionId);
  const [open, setOpen] = useState<BrainstormActionDto | null>(null);
  const [keepError, setKeepError] = useState<string | null>(null);
  const hasContent = artifact.version > 0 && artifact.markdown.trim().length > 0;

  const start = (action: BrainstormActionDto) => {
    if (action.state !== 'available') return;
    if (action.id === 'keep-standalone') {
      setKeepError(null);
      keep.mutate(
        { expectedVersion: artifact.version },
        {
          onError: (err) => setKeepError(
            err instanceof BrainstormApiError && err.code === 'ARTIFACT_VERSION_CONFLICT'
              ? 'The artifact changed. Review the current version, then try again.'
              : 'We could not save this choice. Try again.',
          ),
        },
      );
      return;
    }
    setOpen(action);
  };

  const list = actions.data?.actions ?? [];

  useEffect(() => {
    if (!request) return;
    const action = list.find((item) => item.id === request.actionId);
    if (action) start(action);
    // Only a new request (new nonce) should start an action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce]);

  let content: React.ReactNode;
  if (!hasContent) {
    content = <p className={styles.empty}>{NEXT_ACTIONS_EMPTY}</p>;
  } else if (actions.isLoading) {
    content = <div className={styles.skeleton} aria-busy="true" aria-label="Loading next actions" />;
  } else if (actions.isError) {
    content = (
      <div className={styles.error} role="alert">
        <p>We could not load the next actions.</p>
        <button
          type="button"
          className={styles.button}
          onClick={() => { void actions.refetch(); }}
          {...{ 'data-testid': 'brainstorm-next-actions-retry' }}
        >
          Retry
        </button>
      </div>
    );
  } else if (!canMutate) {
    const completed = (actions.data?.handoffs ?? []).filter((handoff) => handoff.state === 'completed' && handoff.resultRef?.link);
    content = completed.length === 0 ? (
      <p className={styles.empty}>The creator has not handed this artifact off yet.</p>
    ) : (
      <ul className={styles.list}>
        {completed.map((handoff) => (
          <li key={handoff.handoffId} className={styles.row}>
            <Link to={handoff.resultRef!.link!} {...{ 'data-testid': `brainstorm-handoff-link-${handoff.handoffId}` }}>
              {handoff.targetModule === 'adr'
                ? 'Open the ADR'
                : handoff.targetModule === 'interview'
                  ? 'Open the interview'
                  : handoff.targetModule === 'feature-request'
                    ? 'Open the feature request'
                    : 'Open the artifact'}
            </Link>
            <span className={styles.meta}> from version {handoff.artifactVersion}</span>
          </li>
        ))}
      </ul>
    );
  } else {
    content = (
      <ul className={styles.list}>
        {list.map((action) => {
          const reasonId = `brainstorm-action-reason-${sessionId}-${action.id}`;
          const unavailable = action.state !== 'available';
          return (
            <li key={action.id} className={styles.row} {...{ 'data-testid': `brainstorm-action-${action.id}` }}>
              <div className={styles.rowText}>
                <span className={styles.label}>{action.label}</span>
                <span className={styles.meta}>{action.description}</span>
                {action.state === 'unavailable' && action.reasons.length > 0 && (
                  <span id={reasonId} className={styles.reason} {...{ 'data-testid': `brainstorm-action-reason-${action.id}` }}>
                    {action.reasons.map((reason) => reason.text).join(' ')}
                  </span>
                )}
              </div>
              {action.state === 'completed' && action.resultRef?.link ? (
                <Link
                  to={action.resultRef.link}
                  className={styles.resultLink}
                  {...{ 'data-testid': `brainstorm-action-result-${action.id}` }}
                >
                  Open
                </Link>
              ) : (
                <button
                  type="button"
                  className={`${styles.button} ${action.state === 'available' ? styles.primary : ''}`}
                  aria-disabled={unavailable || undefined}
                  aria-describedby={action.state === 'unavailable' && action.reasons.length > 0 ? reasonId : undefined}
                  disabled={action.id === 'keep-standalone' && keep.isPending}
                  onClick={() => start(action)}
                  {...{ 'data-testid': `brainstorm-action-start-${action.id}` }}
                >
                  {action.state === 'available' ? (action.id === 'keep-standalone' ? 'Keep' : 'Preview') : STATE_TEXT[action.state]}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby={`brainstorm-next-actions-${sessionId}`} {...{ 'data-testid': 'brainstorm-next-actions' }}>
      <h2 id={`brainstorm-next-actions-${sessionId}`} className={styles.heading}>Next actions</h2>
      {content}
      {keepError && <p className={styles.error} role="alert">{keepError}</p>}
      {open && (
        // data-testid-exempt — BrainstormHandoffPreviewModal owns brainstorm-handoff-modal
        <BrainstormHandoffPreviewModal
          project={project}
          sessionId={sessionId}
          actionId={open.id}
          actionLabel={open.label}
          expectedVersion={artifact.version}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
};
