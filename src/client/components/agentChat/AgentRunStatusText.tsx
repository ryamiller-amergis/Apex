import React from 'react';
import type { AgentRunPhase } from '../../../shared/types/chat';
import { friendlyChatProgressLabel } from '../../../shared/utils/chatProgressCopy';
import type { ToolProgress } from '../../hooks/useChatStream';
import { ChatRunProgressLabel } from '../ChatRunProgressLabel';

export interface AgentRunStatusTextProps {
  progressPhase?: AgentRunPhase | null;
  progressLabel?: string | null;
  fallbackLabel?: string;
  toolProgress?: ToolProgress[];
  /**
   * When true (default), active running phases render through
   * `ChatRunProgressLabel` with elapsed seconds and step count.
   * When false, renders the plain friendly status text only (used inside
   * full-screen preparation cards).
   */
  showElapsedAndSteps?: boolean;
}

/**
 * Single status-text renderer shared by `AgentLiveWorkBox`,
 * `AssistantConversation`, `InterviewChatView`, and `AdrChatView`.
 *
 * Uses `friendlyChatProgressLabel` as the single source of truth so no surface
 * leaks raw infrastructure terms ("Queued", "Dispatched") while still
 * preserving `data-testid` markers and plain-English wait copy such as
 * "Waiting for your other chat to finish".
 */
export const AgentRunStatusText: React.FC<AgentRunStatusTextProps> = ({
  progressPhase = null,
  progressLabel = null,
  fallbackLabel = 'Thinking…',
  toolProgress = [],
  showElapsedAndSteps = true,
}) => {
  if (progressPhase === 'queued') {
    return (
      <span {...{ 'data-testid': 'agent-run-status-queued' }}>
        {friendlyChatProgressLabel(progressLabel, 'queued')}
      </span>
    );
  }
  if (progressPhase === 'dispatched') {
    return (
      <span {...{ 'data-testid': 'agent-run-status-dispatched' }}>
        {friendlyChatProgressLabel(progressLabel, 'dispatched')}
      </span>
    );
  }

  const effectiveFallback = progressLabel || fallbackLabel;
  if (!showElapsedAndSteps) {
    return <>{friendlyChatProgressLabel(effectiveFallback, progressPhase)}</>;
  }

  return (
    <ChatRunProgressLabel
      fallbackLabel={effectiveFallback}
      progressPhase={progressPhase}
      toolProgress={toolProgress}
    />
  );
};
