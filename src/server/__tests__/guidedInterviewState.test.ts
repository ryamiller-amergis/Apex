import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildGuidedInterviewTurnPrompt,
  deriveGuidedInterviewTurn,
  normalizeGuidedInterviewResponse,
  writeGuidedInterviewState,
  type GuidedInterviewMessage,
} from '../services/guidedInterviewState';

function messages(
  marker: string,
  question = 'Question?',
): GuidedInterviewMessage[] {
  return [
    { role: 'user', text: 'Build a todo list.' },
    { role: 'agent', text: `${marker}\n\n${question}` },
  ];
}

describe('guided interview state', () => {
  it('starts at the first Discovery topic', () => {
    const turn = deriveGuidedInterviewTurn([], 'Build a todo list.');

    expect(turn).toMatchObject({
      phase: 'discovery',
      question: 1,
      topic: 'Current situation, problem, and impact',
      marker: '[[interview-phase:discovery:1:6]]',
    });
    expect(turn.instruction).toContain('recent concrete example');
  });

  it('offers one Discovery follow-up, and moves on when that follow-up is already used', () => {
    const afterPrimary = deriveGuidedInterviewTurn(
      messages('[[interview-phase:discovery:1:6]]'),
      'Any signed-in user.',
    );

    expect(afterPrimary).toMatchObject({
      phase: 'discovery',
      question: 2,
      topic: 'Observable success criteria',
      marker: '[[interview-phase:discovery:2:6]]',
      followUpMarker: '[[interview-phase:discovery:1:6:followup]]',
    });
    expect(afterPrimary.instruction).toContain('Define success early');

    const afterFollowUp = deriveGuidedInterviewTurn(
      messages('[[interview-phase:discovery:1:6:followup]]'),
      'Signed-in users on the Home page.',
    );
    expect(afterFollowUp.followUpMarker).toBeUndefined();
    expect(afterFollowUp).toMatchObject({
      phase: 'discovery',
      question: 2,
      marker: '[[interview-phase:discovery:2:6]]',
    });
  });

  it('moves from the final Discovery topic to Delivery topic one', () => {
    const turn = deriveGuidedInterviewTurn(
      messages('[[interview-phase:discovery:6:6]]'),
      'Those acceptance criteria work.',
    );

    expect(turn).toMatchObject({
      marker: '[[interview-phase:delivery:1:5]]',
      followUpMarker: '[[interview-phase:discovery:6:6:followup]]',
      topic: 'Actor and action confirmation',
    });

    const afterFollowUp = deriveGuidedInterviewTurn(
      messages('[[interview-phase:discovery:6:6:followup]]'),
      'The exception is a guest who can only view.',
    );
    expect(afterFollowUp).toMatchObject({
      phase: 'delivery',
      question: 1,
      marker: '[[interview-phase:delivery:1:5]]',
    });
    expect(afterFollowUp.followUpMarker).toBeUndefined();
  });

  it('requires the Technical-or-PRD choice after Delivery', () => {
    const turn = deriveGuidedInterviewTurn(
      messages('[[interview-phase:delivery:5:5]]'),
      'The Delivery brief is correct.',
    );

    expect(turn.marker).toBe('[[interview-phase:delivery:done]]');
    expect(turn.followUpMarker).toBe('[[interview-phase:delivery:5:5:followup]]');
    expect(turn.instruction).toContain('Continue to technical decisions');

    const afterFollowUp = deriveGuidedInterviewTurn(
      messages('[[interview-phase:delivery:5:5:followup]]'),
      'Correct the blocked-user recovery path.',
    );
    expect(afterFollowUp.phase).toBe('delivery-choice');
    expect(afterFollowUp.marker).toBe('[[interview-phase:delivery:done]]');
    expect(afterFollowUp.followUpMarker).toBeUndefined();
  });

  it('enters Technical only when the person chooses it', () => {
    const prior = messages('[[interview-phase:delivery:done]]');

    expect(
      deriveGuidedInterviewTurn(prior, 'a. Continue to technical decisions'),
    ).toMatchObject({
      phase: 'technical',
      question: 1,
      marker: '[[interview-phase:technical:1:5]]',
    });
    expect(
      deriveGuidedInterviewTurn(prior, 'b. Generate the PRD'),
    ).toMatchObject({
      phase: 'complete',
      marker: '[[interview-phase:technical:skipped]]',
    });
  });

  it('keeps Discovery and Delivery in product language', () => {
    const turn = deriveGuidedInterviewTurn(
      messages('[[interview-phase:delivery:3:5]]'),
      'Managers should not see another person\'s list.',
    );
    const prompt = buildGuidedInterviewTurnPrompt([], 'That is fine.', turn);

    expect(prompt).toContain('Business Analyst or Product Owner');
    expect(prompt).toContain('Do not mention persistence, CRUD');
    expect(prompt).not.toContain('Implementation detail is allowed');
  });

  it('allows implementation detail only in Technical', () => {
    const turn = deriveGuidedInterviewTurn(
      messages('[[interview-phase:technical:1]]'),
      'Both the screen and the service.',
    );
    const prompt = buildGuidedInterviewTurnPrompt([], 'Both.', turn);

    expect(prompt).toContain('Implementation detail is allowed');
    expect(prompt).not.toContain('Do not mention persistence, CRUD');
  });

  it('puts authoritative Q&A and one-topic constraints in every prompt', () => {
    const prior = messages(
      '[[interview-phase:discovery:1:6]]',
      'Who has the problem?',
    );
    const turn = deriveGuidedInterviewTurn(prior, 'Any signed-in user.');
    const prompt = buildGuidedInterviewTurnPrompt(
      prior,
      'Any signed-in user.',
      turn,
    );

    expect(prompt).toContain('First line when the answer is sufficient: [[interview-phase:discovery:2:6]]');
    expect(prompt).toContain('First line when one follow-up is needed: [[interview-phase:discovery:1:6:followup]]');
    expect(prompt).toContain('Ask exactly one question');
    expect(prompt).toContain('The Q&A below is authoritative');
    expect(prompt).toContain('Use a broad, neutral question before narrowing');
    expect(prompt).toContain('Skip — decide later');
    expect(prompt).toContain('Never turn an inference or assumption into a confirmed requirement');
    expect(prompt).toContain('Who has the problem?');
    expect(prompt).toContain('Any signed-in user.');
  });

  it('persists the planned phase and topic in the interview workspace', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'guided-state-'));
    const turn = deriveGuidedInterviewTurn([], 'Build a todo list.');

    writeGuidedInterviewState(workspace, turn);

    const saved = JSON.parse(
      fs.readFileSync(
        path.join(workspace, '.ai-pilot', 'guided-interview-state.json'),
        'utf8',
      ),
    );
    expect(saved).toMatchObject({
      phase: 'discovery',
      question: 1,
      topic: 'Current situation, problem, and impact',
      expectedMarker: '[[interview-phase:discovery:1:6]]',
      followUpMarker: null,
    });
  });

  it('normalizes a missing or incorrect phase marker before persistence', () => {
    const turn = deriveGuidedInterviewTurn(
      messages('[[interview-phase:discovery:1:6]]'),
      'Any signed-in user.',
    );

    expect(
      normalizeGuidedInterviewResponse(
        '[[interview-phase:delivery:4:5]]\n\nWhat outcome shows success?',
        turn,
      ),
    ).toBe(
      '[[interview-phase:discovery:2:6]]\n\nWhat outcome shows success?',
    );
  });

  it('keeps a follow-up marker only when the model asks the allowed follow-up', () => {
    const turn = deriveGuidedInterviewTurn(
      messages('[[interview-phase:discovery:1:6]]'),
      'Any signed-in user.',
    );

    expect(
      normalizeGuidedInterviewResponse(
        '[[interview-phase:discovery:1:6:followup]]\n\nWhich of those users feels this first?',
        turn,
      ),
    ).toBe(
      '[[interview-phase:discovery:1:6:followup]]\n\nWhich of those users feels this first?',
    );
  });

  it('drops a lone Skip option from an open question', () => {
    const turn = deriveGuidedInterviewTurn([], 'Build a todo list.');

    const normalized = normalizeGuidedInterviewResponse(
      'Tell me about the last time this happened.\n\na. Skip — decide later',
      turn,
    );

    expect(normalized).toBe(
      '[[interview-phase:discovery:1:6]]\n\nTell me about the last time this happened.',
    );
  });

  it('adds Skip as the next lettered choice right after the existing choices', () => {
    const turn = deriveGuidedInterviewTurn([], 'Build a todo list.');

    expect(
      normalizeGuidedInterviewResponse(
        'Who feels this first?\n\na. Recruiters\nb. Clinicians\n\nPick the closest.',
        turn,
      ),
    ).toBe(
      '[[interview-phase:discovery:1:6]]\n\nWho feels this first?\n\na. Recruiters\nb. Clinicians\nc. Skip — decide later\n\nPick the closest.',
    );
  });

  it('does not duplicate an existing Skip choice', () => {
    const turn = deriveGuidedInterviewTurn([], 'Build a todo list.');

    expect(
      normalizeGuidedInterviewResponse(
        'Who feels this first?\n\na. Recruiters\nb. Skip — decide later',
        turn,
      ).match(/Skip — decide later/g),
    ).toHaveLength(1);
  });

  it('uses Delivery topic five to confirm the brief, not choose artifacts', () => {
    const turn = deriveGuidedInterviewTurn(
      messages('[[interview-phase:delivery:4:5]]'),
      'No additional dependency.',
    );

    expect(turn).toMatchObject({
      question: 5,
      topic: 'Delivery brief confirmation',
    });
    expect(turn.instruction).toContain('Do not ask which artifacts to generate');
  });

  it('offers one follow-up on each fixed Technical topic', () => {
    const turn = deriveGuidedInterviewTurn(
      messages('[[interview-phase:technical:1:5]]'),
      'Both the screen and the service.',
    );

    expect(turn.marker).toBe('[[interview-phase:technical:2:5]]');
    expect(turn.followUpMarker).toBe('[[interview-phase:technical:1:5:followup]]');
  });

  it('ends the fixed Technical topics with a wrap-up choice', () => {
    const turn = deriveGuidedInterviewTurn(
      messages('[[interview-phase:technical:5:5:followup]]'),
      'Behind a flag.',
    );

    expect(turn.phase).toBe('technical-choice');
    expect(turn.marker).toBe('[[interview-phase:technical:wrapup]]');
    expect(turn.instruction).toContain('Left for the design doc');
  });

  it('finishes Technical or allows up to three deeper questions from the wrap-up', () => {
    const prior = messages('[[interview-phase:technical:wrapup]]');

    expect(deriveGuidedInterviewTurn(prior, 'a. Finish Technical').marker).toBe(
      '[[interview-phase:technical:done]]',
    );

    const deeper = deriveGuidedInterviewTurn(prior, 'b. Go deeper');
    expect(deeper.marker).toBe('[[interview-phase:technical:6:8]]');

    const seventh = deriveGuidedInterviewTurn(
      messages('[[interview-phase:technical:6:8]]'),
      'Use the existing worker.',
    );
    expect(seventh.marker).toBe('[[interview-phase:technical:7:8]]');
    expect(seventh.followUpMarker).toBeUndefined();

    expect(
      deriveGuidedInterviewTurn(
        messages('[[interview-phase:technical:8:8]]'),
        'Fine.',
      ).marker,
    ).toBe('[[interview-phase:technical:done]]');
  });

  it('re-asks the wrap-up choice when the answer is neither option', () => {
    const turn = deriveGuidedInterviewTurn(
      messages('[[interview-phase:technical:wrapup]]'),
      'Hmm, not sure.',
    );

    expect(turn.marker).toBe('[[interview-phase:technical:wrapup]]');
  });

  it('wraps up an older open-ended Technical interview past the fixed topics', () => {
    const turn = deriveGuidedInterviewTurn(
      messages('[[interview-phase:technical:23]]'),
      'A. Trust skill output.',
    );

    expect(turn.marker).toBe('[[interview-phase:technical:wrapup]]');
  });
});
