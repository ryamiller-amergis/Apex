/**
 * Rules for an `interactive-agent` step's proposal (FEAT-003, BR-006).
 *
 * A proposal is the agent's latest answer on the step's thread. The assignee may approve it only
 * when it passes the loose result check and the skill's output kind check. Both are pure functions
 * here so the approval route and the tests read the same rule.
 *
 * The kind shapes are the minimal ones the product chose for now:
 * - `document@1` and `report@1`: non-empty text.
 * - `scorecard@1` and `decision@1`: non-empty text whose last fenced ```json block parses to an object.
 * A skill with no kind keeps only the loose check.
 */

/** What a suspended interactive step remembers between turns. */
export interface InteractiveStepDraft {
  threadId: string;
  assigneeUserId: string;
  turnCount: number;
  rejectedRevisions: number;
  proposalText: string | null;
  proposalOutcome: string | null;
  proposalOk: boolean;
  proposalReason: string | null;
  kind: string | null;
  outcomes: string[];
  lastTurnError: string | null;
}

export function isInteractiveStepDraft(value: unknown): value is InteractiveStepDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<InteractiveStepDraft>;
  return typeof draft.threadId === 'string' && typeof draft.assigneeUserId === 'string';
}

/** A finished turn updates the draft and leaves the step suspended. A failed turn does not count. */
export function draftAfterTurn(input: {
  draft: InteractiveStepDraft;
  reply: { text: string; outcome?: string } | null;
  failedReason?: string;
}): InteractiveStepDraft {
  if (input.failedReason) {
    return { ...input.draft, lastTurnError: input.failedReason };
  }
  const text = input.reply?.text ?? '';
  const outcome = input.reply?.outcome;
  const check = checkInteractiveProposal({
    text,
    outcome,
    outcomes: input.draft.outcomes,
    kind: input.draft.kind,
  });
  return {
    ...input.draft,
    turnCount: input.draft.turnCount + 1,
    proposalText: text,
    proposalOutcome: outcome ?? null,
    proposalOk: check.ok,
    proposalReason: check.ok ? null : check.reason,
    lastTurnError: null,
  };
}

/** Rejected revisions before the assignee can only approve or cancel. */
export const INTERACTIVE_REJECTED_REVISION_LIMIT = 1;

export type InteractiveProposalMode = 'chat' | 'approve-or-cancel';

export type InteractiveProposalCheck = { ok: true } | { ok: false; reason: string };

const JSON_KIND_OUTPUT = new Set(['scorecard@1', 'decision@1']);

/** The last fenced json block in the text, or null when there is none. */
function lastJsonBlock(text: string): string | null {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  return blocks.length > 0 ? blocks[blocks.length - 1][1] : null;
}

/**
 * What the assignee may do next.
 *
 * After a rejected revision the chat closes: the assignee can only approve the proposal or cancel
 * the run. Turns are not capped; the step deadline ends an abandoned chat.
 */
export function interactiveProposalMode(input: {
  rejectedRevisions: number;
}): InteractiveProposalMode {
  if (input.rejectedRevisions >= INTERACTIVE_REJECTED_REVISION_LIMIT) return 'approve-or-cancel';
  return 'chat';
}

/**
 * Whether a proposal may resume the step.
 *
 * `outcomes` is the step's declared outcome list. When the step declares one, the agent's picked
 * outcome must be on it; a step with no outcomes accepts no outcome at all.
 */
export function checkInteractiveProposal(input: {
  text: string;
  outcome?: string;
  outcomes?: readonly string[];
  kind: string | null;
}): InteractiveProposalCheck {
  if (!input.text.trim()) {
    return { ok: false, reason: 'The proposal is empty.' };
  }

  if (input.outcomes && input.outcomes.length > 0) {
    if (!input.outcome || !input.outcomes.includes(input.outcome)) {
      return {
        ok: false,
        reason: `The proposal must pick one of: ${input.outcomes.join(', ')}.`,
      };
    }
  }

  if (input.kind && JSON_KIND_OUTPUT.has(input.kind)) {
    const block = lastJsonBlock(input.text);
    if (block === null) {
      return { ok: false, reason: `A ${input.kind} proposal needs a final json block.` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      return { ok: false, reason: `The final json block of a ${input.kind} proposal does not parse.` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: `The final json block of a ${input.kind} proposal must be an object.` };
    }
  }

  return { ok: true };
}
