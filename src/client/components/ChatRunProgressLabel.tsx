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
 * Progress line under a chat spinner: the current step, time since the agent
 * started working, and how many steps it has taken. Queued and dispatched keep
 * their single-word status, and their wait is not counted.
 */
export const ChatRunProgressLabel: React.FC<ChatRunProgressLabelProps> = ({
  fallbackLabel,
  progressPhase,
  toolProgress,
}) => {
  const waiting = progressPhase === 'queued' || progressPhase === 'dispatched';
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  const [wasWaiting, setWasWaiting] = useState(waiting);

  if (wasWaiting !== waiting) {
    setWasWaiting(waiting);
    if (!waiting) setStartedAt(now);
  }

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  if (waiting) {
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
