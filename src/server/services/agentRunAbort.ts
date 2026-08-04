import type { AgentRunEventEnvelope } from '../../shared/types/chat';

/**
 * Fan-out events that mean an instance must abort its in-process Cursor SDK
 * run (user Stop, reaper progress_timeout / worker_lost / hard_timeout, etc.).
 */
export function isExternalRunAbortEvent(envelope: AgentRunEventEnvelope): boolean {
  const event = envelope.event;
  if (event.type === 'cancel') return true;
  if (event.type === 'health') {
    return event.health === 'progress_timeout'
      || event.health === 'worker_lost'
      || event.health === 'hard_timeout'
      || event.health === 'never_claimed';
  }
  return false;
}
