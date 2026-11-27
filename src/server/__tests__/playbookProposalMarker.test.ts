import {
  promptWithProposalInstruction,
  PROPOSAL_MARKER,
  splitProposalMarker,
  stripProposalInstruction,
} from '../services/playbookSteps/proposalMarker';
import { promptWithOutcomes, stripOutcomeInstructions } from '../services/playbookSteps/agentOutcome';
import { threadConversation } from '../services/playbookSteps/agentTaskConversation';
import { draftAfterTurn, type InteractiveStepDraft } from '../services/playbookSteps/interactiveProposal';

const draft: InteractiveStepDraft = {
  threadId: 't1',
  assigneeUserId: 'u1',
  turnCount: 0,
  rejectedRevisions: 0,
  proposalText: null,
  proposalOutcome: null,
  proposalOk: false,
  proposalReason: null,
  kind: null,
  outcomes: [],
  lastTurnError: null,
};

describe('splitProposalMarker', () => {
  it.each([
    'READY FOR APPROVAL',
    'ready for approval',
    '**READY FOR APPROVAL**',
    '> READY FOR APPROVAL',
    '## Ready for approval.',
    '`READY FOR APPROVAL`',
  ])('reads %s as the marker', (line) => {
    expect(splitProposalMarker(`The answer.\n\n${line}\n\n`)).toEqual({ marked: true, text: 'The answer.' });
  });

  it('is not a proposal when the words are not the last line', () => {
    expect(splitProposalMarker('READY FOR APPROVAL\nOne more thing.').marked).toBe(false);
    expect(splitProposalMarker('Tell me when READY FOR APPROVAL applies.').marked).toBe(false);
    expect(splitProposalMarker('Which release? (a or b)').marked).toBe(false);
  });

  it('leaves an unmarked reply as written', () => {
    expect(splitProposalMarker('Which one?\n')).toEqual({ marked: false, text: 'Which one?\n' });
  });

  it('keeps Windows line endings from hiding the marker', () => {
    expect(splitProposalMarker('Done.\r\nREADY FOR APPROVAL\r\n')).toEqual({ marked: true, text: 'Done.' });
  });
});

describe('the proposal instruction', () => {
  it('is added to a prompt and taken off again', () => {
    const prompt = 'Write the notes.';
    const sent = promptWithProposalInstruction(prompt);
    expect(sent).toContain(PROPOSAL_MARKER);
    expect(stripProposalInstruction(sent)).toBe(prompt);
  });

  it('comes off a prompt that also carries outcome instructions', () => {
    const sent = promptWithOutcomes(promptWithProposalInstruction('Write the notes.'), ['done', 'blocked']);
    expect(stripProposalInstruction(stripOutcomeInstructions(sent))).toBe('Write the notes.');
  });

  it('does not show in the chat, and the marker line does not show in a reply', () => {
    const conversation = threadConversation([
      { id: 'm1', role: 'user', text: promptWithProposalInstruction('Draft it.'), ts: '2026-11-27T10:00:00.000Z' },
      { id: 'm2', role: 'agent', text: 'Here it is.\nREADY FOR APPROVAL', ts: '2026-11-27T10:01:00.000Z' },
    ] as never);
    expect(conversation.map((entry) => entry.text)).toEqual(['Draft it.', 'Here it is.']);
  });
});

describe('draftAfterTurn with the marker', () => {
  it('makes a marked reply the proposal, without the marker line', () => {
    const next = draftAfterTurn({ draft, reply: { text: 'The result.\nREADY FOR APPROVAL' } });
    expect(next).toMatchObject({ turnCount: 1, proposalText: 'The result.', proposalOk: true, proposalReason: null });
  });

  it('counts a question as a turn and clears the earlier proposal', () => {
    const next = draftAfterTurn({
      draft: { ...draft, turnCount: 1, proposalText: 'Earlier.', proposalOk: true },
      reply: { text: 'Which release?' },
    });
    expect(next).toMatchObject({ turnCount: 2, proposalText: null, proposalOk: false, proposalReason: null });
  });

  it('still applies the output checks to a marked reply', () => {
    const next = draftAfterTurn({
      draft: { ...draft, kind: 'scorecard@1' },
      reply: { text: 'No json here.\nREADY FOR APPROVAL' },
    });
    expect(next).toMatchObject({ proposalText: 'No json here.', proposalOk: false });
    expect(next.proposalReason).toMatch(/json/);
  });

  it('rejects a marker with nothing above it as an empty proposal', () => {
    const next = draftAfterTurn({ draft, reply: { text: 'READY FOR APPROVAL' } });
    expect(next).toMatchObject({ proposalOk: false, proposalReason: 'The proposal is empty.' });
  });
});
