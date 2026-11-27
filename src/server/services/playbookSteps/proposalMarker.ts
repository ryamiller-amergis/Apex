/**
 * An interactive Agent task is a chat. Only a reply that ends with the `READY FOR APPROVAL` line
 * counts as a proposal the assignee can approve. A reply without it is the agent talking: a
 * question, a choice, a progress note. Apex asks the agent to follow this rule in every turn.
 */

export const PROPOSAL_MARKER = 'READY FOR APPROVAL';

const PROPOSAL_INSTRUCTION = [
  'This is a chat with a person. If you need an answer or a decision from them, ask your question and stop. Do not add the line below to a question.',
  'When your answer is complete and ready for them to approve, end your reply with this line on its own:',
  PROPOSAL_MARKER,
].join('\n');

// Tolerates Markdown around the line: bold, a quote mark, a heading, a trailing full stop.
const MARKER_LINE = /^[ \t>*_`#-]*READY[ \t]+FOR[ \t]+APPROVAL[ \t*_`.!]*$/i;

export function promptWithProposalInstruction(prompt: string): string {
  return `${prompt}\n\n${PROPOSAL_INSTRUCTION}`;
}

/** The prompt as the person wrote it, without the instruction `promptWithProposalInstruction` added. */
export function stripProposalInstruction(prompt: string): string {
  const at = prompt.lastIndexOf(`\n\n${PROPOSAL_INSTRUCTION}`);
  if (at < 0) return prompt;
  return prompt.slice(0, at) + prompt.slice(at + 2 + PROPOSAL_INSTRUCTION.length);
}

/**
 * Whether the reply ends with the marker line. The text comes back without that line.
 * Only the last non-empty line counts, so a reply that mentions the words mid-way is not a proposal.
 */
export function splitProposalMarker(reply: string): { marked: boolean; text: string } {
  const lines = reply.split(/\r?\n/);
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last -= 1;
  if (last < 0 || !MARKER_LINE.test(lines[last])) return { marked: false, text: reply };
  return { marked: true, text: lines.slice(0, last).join('\n').trim() };
}
