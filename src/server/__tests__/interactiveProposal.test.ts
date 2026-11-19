import {
  INTERACTIVE_TURN_LIMIT,
  checkInteractiveProposal,
  draftAfterTurn,
  interactiveProposalMode,
  type InteractiveStepDraft,
} from '../services/playbookSteps/interactiveProposal';

const EMPTY_DRAFT: InteractiveStepDraft = {
  threadId: 'thread-1',
  assigneeUserId: 'assignee-1',
  turnCount: 0,
  rejectedRevisions: 0,
  proposalText: null,
  proposalOutcome: null,
  proposalOk: false,
  proposalReason: null,
  kind: 'document@1',
  outcomes: [],
  lastTurnError: null,
};

const JSON_BLOCK = '```json\n{"score": 8}\n```';

describe('interactive proposal rules (FEAT-003 BR-006)', () => {
  it('refuses an empty or blank proposal under every kind', () => {
    for (const kind of [null, 'document@1', 'report@1', 'scorecard@1', 'decision@1']) {
      expect(checkInteractiveProposal({ text: '   ', kind })).toEqual({
        ok: false,
        reason: 'The proposal is empty.',
      });
    }
  });

  it('accepts any non-empty text for document and report kinds', () => {
    expect(checkInteractiveProposal({ text: 'A plan.', kind: 'document@1' })).toEqual({ ok: true });
    expect(checkInteractiveProposal({ text: 'Findings.', kind: 'report@1' })).toEqual({ ok: true });
  });

  it('needs a final json object for scorecard and decision kinds', () => {
    expect(checkInteractiveProposal({ text: `Notes\n${JSON_BLOCK}`, kind: 'scorecard@1' })).toEqual({ ok: true });
    expect(checkInteractiveProposal({ text: 'Just prose.', kind: 'decision@1' }).ok).toBe(false);
    expect(
      checkInteractiveProposal({ text: '```json\n{not json}\n```', kind: 'decision@1' }).ok,
    ).toBe(false);
    expect(
      checkInteractiveProposal({ text: '```json\n[1, 2]\n```', kind: 'scorecard@1' }).ok,
    ).toBe(false);
  });

  it('reads the last json block when there are several', () => {
    const text = '```json\n[1]\n```\nFinal:\n```json\n{"ok": true}\n```';
    expect(checkInteractiveProposal({ text, kind: 'decision@1' })).toEqual({ ok: true });
  });

  it('keeps only the loose check when the skill has no kind', () => {
    expect(checkInteractiveProposal({ text: 'Plain answer.', kind: null })).toEqual({ ok: true });
  });

  it('requires a declared outcome to be picked', () => {
    const outcomes = ['ship', 'rework'];
    expect(checkInteractiveProposal({ text: 'Done.', kind: null, outcomes, outcome: 'ship' })).toEqual({ ok: true });
    expect(checkInteractiveProposal({ text: 'Done.', kind: null, outcomes }).ok).toBe(false);
    expect(checkInteractiveProposal({ text: 'Done.', kind: null, outcomes, outcome: 'merge' }).ok).toBe(false);
  });

  it('chats until the turn limit, then forces one proposal', () => {
    expect(interactiveProposalMode({ turnCount: 0, rejectedRevisions: 0 })).toBe('chat');
    expect(interactiveProposalMode({ turnCount: INTERACTIVE_TURN_LIMIT - 1, rejectedRevisions: 0 })).toBe('chat');
    expect(interactiveProposalMode({ turnCount: INTERACTIVE_TURN_LIMIT, rejectedRevisions: 0 })).toBe('forced-proposal');
  });

  it('keeps a failed turn off the turn count and stores the reason', () => {
    const next = draftAfterTurn({ draft: EMPTY_DRAFT, reply: null, failedReason: 'denied' });
    expect(next.turnCount).toBe(0);
    expect(next.lastTurnError).toBe('denied');
  });

  it('records a valid proposal without completing the step', () => {
    const next = draftAfterTurn({ draft: EMPTY_DRAFT, reply: { text: 'A document.' } });
    expect(next.turnCount).toBe(1);
    expect(next.proposalOk).toBe(true);
    expect(next.proposalText).toBe('A document.');
  });

  it('allows only approve or cancel after one rejected revision', () => {
    expect(interactiveProposalMode({ turnCount: 2, rejectedRevisions: 1 })).toBe('approve-or-cancel');
    expect(interactiveProposalMode({ turnCount: INTERACTIVE_TURN_LIMIT, rejectedRevisions: 1 })).toBe('approve-or-cancel');
  });
});
