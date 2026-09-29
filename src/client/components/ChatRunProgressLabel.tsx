import React, { useEffect, useState } from 'react';
import type { AgentRunPhase } from '../../shared/types/chat';
import { friendlyToolActivityLabel } from '../../shared/utils/chatProgressCopy';
import type { ToolProgress } from '../hooks/useChatStream';

const SHOW_ELAPSED_AFTER_SECONDS = 3;

export interface ChatRunProgressLabelProps {
  /** Label shown when no tool is running (and always while queued or dispatched). */
  fallbackLabel: string;
  progressPhase: AgentRunPhase | null;
  toolProgress: ToolProgress[];
}

/**
 * Progress line under a chat spinner: the current step, time since the spinner
 * appeared, and how many steps the agent has taken. Queued and dispatched keep
 * their single-word status.
 */
export const ChatRunProgressLabel: React.FC<ChatRunProgressLabelProps> = ({
  fallbackLabel,
  progressPhase,
  toolProgress,
}) => {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  if (progressPhase === 'queued' || progressPhase === 'dispatched') {
    return <>{fallbackLabel}</>;
  }

  const running = [...toolProgress].reverse().find((tool) => tool.status === 'running');
  const parts = [running ? friendlyToolActivityLabel(running.toolName, running.args) : fallbackLabel];
  const seconds = Math.floor((now - startedAt) / 1_000);
  if (seconds >= SHOW_ELAPSED_AFTER_SECONDS) parts.push(`${seconds}s`);
  if (toolProgress.length > 0) {
    parts.push(`${toolProgress.length} ${toolProgress.length === 1 ? 'step' : 'steps'}`);
  }
  return <>{parts.join(' · ')}</>;
};
