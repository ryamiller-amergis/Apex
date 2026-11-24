/**
 * An Agent task with `outcomes` asks the agent to end its reply with one `OUTCOME:` line.
 * The completion reads that line back into the step's `outcome` field, which a branch can test.
 */

const OUTCOME_LINE = /^[ \t>*_`]*OUTCOME[ \t*_`]*:[ \t]*(.+?)[ \t]*$/gim;
const OUTCOME_INSTRUCTION =
  'When you finish, end your reply with one line in exactly this form, choosing the result that fits best:';

export function promptWithOutcomes(prompt: string, outcomes: readonly string[] | undefined): string {
  if (!outcomes?.length) return prompt;
  return [
    prompt,
    '',
    OUTCOME_INSTRUCTION,
    `OUTCOME: <one of: ${outcomes.join(' | ')}>`,
  ].join('\n');
}

/** The prompt as the person wrote it, without the outcome instructions `promptWithOutcomes` added. */
export function stripOutcomeInstructions(prompt: string): string {
  const at = prompt.lastIndexOf(`\n\n${OUTCOME_INSTRUCTION}\n`);
  return at >= 0 ? prompt.slice(0, at) : prompt;
}

/** The agent's chosen outcome, normalised to the lowercase form outcomes are stored in. */
function normaliseOutcome(raw: string): string {
  return raw
    .replace(/[`*_"'<>]/g, '')
    .replace(/[.!]+$/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Splits the last `OUTCOME:` line off a reply. The reply comes back without it. */
export function extractOutcome(reply: string): { outcome?: string; text: string } {
  let last: RegExpExecArray | null = null;
  for (const match of reply.matchAll(OUTCOME_LINE)) last = match as RegExpExecArray;
  if (!last) return { text: reply };
  const outcome = normaliseOutcome(last[1]);
  const text = (reply.slice(0, last.index) + reply.slice(last.index + last[0].length)).trim();
  return outcome ? { outcome, text } : { text };
}
