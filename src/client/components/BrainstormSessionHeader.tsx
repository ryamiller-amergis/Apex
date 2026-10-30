import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BRAINSTORM_TITLE_MAX_LENGTH,
  type BrainstormSessionState,
  type BrainstormSessionSummary,
} from '../../shared/types/brainstorm';
import { BrainstormApiError, useRenameBrainstormSession } from '../hooks/useBrainstormSessions';
import { useEndBrainstormSession } from '../hooks/useBrainstormSources';
import { BrainstormEndSessionDialog } from './BrainstormEndSessionDialog';
import styles from './BrainstormSessionHeader.module.css';

const STATE_LABELS: Record<BrainstormSessionState, string> = {
  active: 'Active',
  ended: 'Ended',
  failed: 'Failed',
};

export const BrainstormStatusChip: React.FC<{ state: BrainstormSessionState }> = ({ state }) => (
  <span className={`${styles.chip} ${styles[state]}`} {...{ 'data-testid': 'brainstorm-session-status' }}>
    {STATE_LABELS[state]}
  </span>
);

export function formatBrainstormTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

interface BrainstormSessionHeaderProps {
  session: BrainstormSessionSummary;
  project: string;
}

export const BrainstormSessionHeader: React.FC<BrainstormSessionHeaderProps> = ({ session, project }) => {
  const [confirming, setConfirming] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(session.title ?? '');
  const endSession = useEndBrainstormSession(project, session.id);
  const renameSession = useRenameBrainstormSession(project);
  const error = endSession.error instanceof BrainstormApiError ? endSession.error.message : null;
  const canRename = Boolean(session.canMutate || session.canDelete);

  const handleStartRename = () => {
    setDraftTitle(session.title ?? '');
    setEditingTitle(true);
  };

  const handleSaveRename = async () => {
    const trimmed = draftTitle.trim();
    if (!trimmed) return;
    try {
      await renameSession.mutateAsync({ sessionId: session.id, title: trimmed });
      setEditingTitle(false);
    } catch {
      // Keep editor open on error
    }
  };

  return (
    <header className={styles.header} {...{ 'data-testid': 'brainstorm-session-header' }}>
      <div className={styles.identity}>
        <Link to="/brainstorm" className={styles.back} {...{ 'data-testid': 'brainstorm-back-to-sessions' }}>
          ← Brainstorm
        </Link>
        {editingTitle ? (
          <div className={styles.renameForm}>
            <input
              type="text"
              className={styles.renameInput}
              maxLength={BRAINSTORM_TITLE_MAX_LENGTH}
              value={draftTitle}
              aria-label="Session title"
              onChange={(event) => setDraftTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleSaveRename();
                } else if (event.key === 'Escape') {
                  setEditingTitle(false);
                }
              }}
              {...{ 'data-testid': 'brainstorm-session-rename-input' }}
            />
            <button
              type="button"
              className={styles.renameSave}
              disabled={!draftTitle.trim() || renameSession.isPending}
              onClick={() => { void handleSaveRename(); }}
              {...{ 'data-testid': 'brainstorm-session-rename-save' }}
            >
              {renameSession.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className={styles.renameButton}
              disabled={renameSession.isPending}
              onClick={() => setEditingTitle(false)}
              {...{ 'data-testid': 'brainstorm-session-rename-cancel' }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{session.title ?? 'Untitled session'}</h1>
            {canRename && (
              <button
                type="button"
                className={styles.renameButton}
                onClick={handleStartRename}
                {...{ 'data-testid': 'brainstorm-session-rename-button' }}
              >
                Rename
              </button>
            )}
          </div>
        )}
      </div>
      <div className={styles.meta}>
        <span>{session.creatorName ?? 'Unknown creator'}</span>
        {/* data-testid-exempt — BrainstormStatusChip owns brainstorm-session-status */}
        <BrainstormStatusChip state={session.state} />
        <time dateTime={session.createdAt}>{formatBrainstormTime(session.createdAt)}</time>
        {session.canMutate && session.state === 'active' && (
          <button type="button" className={styles.end} onClick={() => setConfirming(true)} {...{ 'data-testid': 'brainstorm-end-session-button' }}>
            End session
          </button>
        )}
      </div>
      {/* data-testid-exempt — BrainstormEndSessionDialog owns brainstorm-end-session-dialog */}
      <BrainstormEndSessionDialog
        open={confirming}
        pending={endSession.isPending}
        error={error}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          endSession.mutate(undefined, { onSuccess: () => setConfirming(false) });
        }}
      />
    </header>
  );
};
