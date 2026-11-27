/**
 * The chat of an interactive Agent task, read from its thread.
 *
 * Both the activity endpoint (what the panel shows) and the next turn's prompt (what a fresh V2
 * agent is told) read the chat the same way, so they share this one reader.
 */
import type { ChatMessage } from '../../../shared/types/chat';
import type { PlaybookStepChatMessage } from '../../../shared/types/playbook';
import { extractOutcome, stripOutcomeInstructions } from './agentOutcome';
import { splitProposalMarker, stripProposalInstruction } from './proposalMarker';

const MAX_CONVERSATION_MESSAGES = 300;
/** Earlier turns beyond this size are dropped, oldest first, from the prompt of a new turn. */
const MAX_HISTORY_CHARS = 60_000;

/**
 * The assignee's messages and the agent's replies, as the chat shows them. The outcome
 * instructions Apex adds to each prompt, and the OUTCOME line the agent ends with, are left out.
 * Consecutive agent messages in one turn are joined into one reply.
 */
export function threadConversation(messages: readonly ChatMessage[]): PlaybookStepChatMessage[] {
  const conversation: PlaybookStepChatMessage[] = [];
  for (const message of messages) {
    if (message.hidden) continue;
    if (message.role === 'user') {
      const text = stripProposalInstruction(stripOutcomeInstructions(message.text)).trim();
      if (text) conversation.push({ id: message.id, role: 'user', text, at: message.ts });
      continue;
    }
    if (message.role !== 'agent' || message.toolName) continue;
    const text = splitProposalMarker(extractOutcome(message.text).text).text.trim();
    if (!text) continue;
    const previous = conversation[conversation.length - 1];
    if (previous?.role === 'agent') {
      previous.text = `${previous.text}\n\n${text}`;
      continue;
    }
    conversation.push({ id: message.id, role: 'agent', text, at: message.ts });
  }
  return conversation.slice(-MAX_CONVERSATION_MESSAGES);
}

/**
 * A V2 turn runs as a new agent with no memory of the turns before it. This puts the earlier
 * conversation in front of the assignee's new message so the agent can carry on from it.
 */
export function promptWithHistory(
  prompt: string,
  messages: readonly ChatMessage[],
): string {
  const lines: string[] = [];
  let size = 0;
  const conversation = threadConversation(messages);
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const entry = conversation[index];
    const line = `**${entry.role === 'user' ? 'Assignee' : 'Agent'}:** ${entry.text}`;
    if (lines.length > 0 && size + line.length > MAX_HISTORY_CHARS) break;
    lines.unshift(line);
    size += line.length;
  }
  if (lines.length === 0) return prompt;
  return [
    '## Conversation so far',
    '',
    'Each turn runs as a new agent, so the earlier turns are written out here. Carry on from them.',
    'Do not ask again for anything the assignee has already answered.',
    '',
    lines.join('\n\n'),
    '',
    '## New message from the assignee',
    '',
    prompt,
  ].join('\n');
}
