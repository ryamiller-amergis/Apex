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
      topic: 'Problem and who has it',
      marker: '[[interview-phase:discovery:1:6]]',
    });
  });

  it('advances exactly one Discovery topic per answer', () => {
    const turn = deriveGuidedInterviewTurn(
      messages('[[interview-phase:discovery:1:6]]'),
      'Any signed-in user.',
    );

    expect(turn).toMatchObject({
      phase: 'discovery',
      question: 2,
      topic: 'What success looks like',
    });
  });

  it('moves from the final Discovery topic to Delivery topic one', () => {
    const turn = deriveGuidedInterviewTurn(
      messages('[[interview-phase:discovery:6:6]]'),
      'Those acceptance criteria work.',
    );

    expect(turn).toMatchObject({
      phase: 'delivery',
      question: 1,
      topic: 'Who can do each action',
    });
  });

  it('requires the Technical-or-PRD choice after Delivery', () => {
    const turn = deriveGuidedInterviewTurn(
      messages('[[interview-phase:delivery:5:5]]'),
      'We need test cases and a design doc.',
    );

    expect(turn.phase).toBe('delivery-choice');
    expect(turn.marker).toBe('[[interview-phase:delivery:done]]');
  });

  it('enters Technical only when the person chooses it', () => {
    const prior = messages('[[interview-phase:delivery:done]]');

    expect(
      deriveGuidedInterviewTurn(prior, 'a. Continue to technical decisions'),
    ).toMatchObject({
      phase: 'technical',
      question: 1,
      marker: '[[interview-phase:technical:1]]',
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

    expect(prompt).toContain('Required first line: [[interview-phase:discovery:2:6]]');
    expect(prompt).toContain('Ask exactly one question');
    expect(prompt).toContain('The Q&A below is authoritative');
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
      topic: 'Problem and who has it',
      expectedMarker: '[[interview-phase:discovery:1:6]]',
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
});
