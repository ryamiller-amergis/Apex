import React, { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BrainstormActionId } from '../../shared/types/brainstormArtifact';
import { BrainstormApiError, useBrainstormMessages, useBrainstormSession } from '../hooks/useBrainstormSessions';
import { BrainstormArtifactPanel } from './BrainstormArtifactPanel';
import { BrainstormArtifactPlaceholder } from './BrainstormArtifactPlaceholder';
import { BrainstormChatPanel } from './BrainstormChatPanel';
import type { BrainstormActionRequest } from './BrainstormNextActionsPanel';
import { BrainstormSessionHeader } from './BrainstormSessionHeader';
import { BrainstormSourcesPanel } from './BrainstormSourcesPanel';
import styles from './BrainstormWorkspace.module.css';

interface BrainstormWorkspaceProps {
  project: string;
  sessionId: string;
}

export const BrainstormWorkspace: React.FC<BrainstormWorkspaceProps> = ({ project, sessionId }) => {
  const { data: session, isLoading, error, refetch } = useBrainstormSession(project, sessionId);
  const [sideTab, setSideTab] = useState<'artifact' | 'sources'>('artifact');
  const [sidePanelState, setSidePanelState] = useState<'normal' | 'minimized' | 'expanded'>('normal');
  const [actionRequest, setActionRequest] = useState<BrainstormActionRequest | null>(null);
  const messages = useBrainstormMessages(project, sessionId, Boolean(session));
  const turnRunning = (messages.data ?? []).some((message) => message.status === 'streaming');
  const isMinimized = sidePanelState === 'minimized';
  const isExpanded = sidePanelState === 'expanded';

  const requestAction = useCallback((actionId: BrainstormActionId) => {
    setSideTab('artifact');
    setSidePanelState((prev) => (prev === 'minimized' ? 'normal' : prev));
    setActionRequest({ actionId, nonce: Date.now() });
  }, []);

  let content: React.ReactNode;
  if (isLoading) {
    content = (
      <div className={styles.split} aria-busy="true">
        <div className={styles.chat}>
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
        </div>
        <div className={styles.artifact}>
          <BrainstormArtifactPlaceholder loading />
        </div>
      </div>
    );
  } else if (error instanceof BrainstormApiError && error.status === 404) {
    content = (
      <div className={styles.state} role="status" {...{ 'data-testid': 'brainstorm-not-found' }}>
        <h1 className={styles.stateTitle}>Session not found</h1>
        <p>This session does not exist or is not in the current project.</p>
        <Link to="/brainstorm" className={styles.link} {...{ 'data-testid': 'brainstorm-not-found-link' }}>
          Back to Brainstorm sessions
        </Link>
      </div>
    );
  } else if (error || !session) {
    content = (
      <div className={styles.state} role="alert" {...{ 'data-testid': 'brainstorm-workspace-error' }}>
        <h1 className={styles.stateTitle}>We could not open this session</h1>
        <button
          type="button"
          className={styles.retry}
          onClick={() => { void refetch(); }}
          {...{ 'data-testid': 'brainstorm-workspace-retry' }}
        >
          Retry
        </button>
      </div>
    );
  } else {
    content = (
      <>
        <BrainstormSessionHeader session={session} project={project} />
        <div
          className={`${styles.split}${isMinimized ? ` ${styles.splitMinimized}` : ''}${isExpanded ? ` ${styles.splitExpanded}` : ''}`}
          data-side-state={sidePanelState}
        >
          <div className={styles.chat}>
            {/* data-testid-exempt — BrainstormChatPanel owns brainstorm-chat-thread and composer ids */}
            <BrainstormChatPanel project={project} session={session} onSuggestion={requestAction} />
          </div>
          <div className={`${styles.artifact}${isMinimized ? ` ${styles.artifactMinimized}` : ''}`}>
            <div className={styles.sideHeader}>
              <div className={styles.sideTabs} role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={!isMinimized && sideTab === 'artifact'}
                  className={styles.sideTab}
                  onClick={() => {
                    setSideTab('artifact');
                    if (isMinimized) setSidePanelState('normal');
                  }}
                  {...{ 'data-testid': 'brainstorm-artifact-tab' }}
                >
                  Artifact
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={!isMinimized && sideTab === 'sources'}
                  className={styles.sideTab}
                  onClick={() => {
                    setSideTab('sources');
                    if (isMinimized) setSidePanelState('normal');
                  }}
                  {...{ 'data-testid': 'brainstorm-sources-tab' }}
                >
                  Sources
                </button>
              </div>
              <div className={styles.sideControls}>
                {!isMinimized && (
                  <button
                    type="button"
                    className={styles.sideControlButton}
                    aria-pressed={isExpanded}
                    aria-label={isExpanded ? 'Restore artifact and sources width' : 'Expand artifact and sources'}
                    onClick={() => setSidePanelState((prev) => (prev === 'expanded' ? 'normal' : 'expanded'))}
                    {...{ 'data-testid': 'brainstorm-side-expand' }}
                  >
                    {isExpanded ? 'Restore' : 'Expand'}
                  </button>
                )}
                <button
                  type="button"
                  className={styles.sideControlButton}
                  aria-expanded={!isMinimized}
                  aria-label={isMinimized ? 'Expand artifact and sources' : 'Minimize artifact and sources'}
                  onClick={() => setSidePanelState((prev) => (prev === 'minimized' ? 'normal' : 'minimized'))}
                  {...{ 'data-testid': isMinimized ? 'brainstorm-side-expand' : 'brainstorm-side-minimize' }}
                >
                  {isMinimized ? 'Expand' : 'Minimize'}
                </button>
              </div>
            </div>
            {!isMinimized && (
              sideTab === 'sources'
                ? (
                  // data-testid-exempt — BrainstormSourcesPanel owns brainstorm-sources-panel
                  <BrainstormSourcesPanel project={project} session={session} />
                )
                : (
                  // data-testid-exempt — BrainstormArtifactPanel owns brainstorm-artifact-panel
                  <BrainstormArtifactPanel
                    project={project}
                    session={session}
                    turnRunning={turnRunning}
                    actionRequest={actionRequest}
                  />
                )
            )}
          </div>
        </div>
      </>
    );
  }

  return (
    <main className={styles.root} {...{ 'data-testid': 'brainstorm-workspace' }}>
      {content}
    </main>
  );
};

export default BrainstormWorkspace;
