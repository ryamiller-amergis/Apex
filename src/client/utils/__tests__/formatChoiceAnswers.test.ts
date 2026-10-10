import { formatChoiceAnswers } from '../formatChoiceAnswers';
import type { ChoiceBlock } from '../parseAgentMessage';

const phi: ChoiceBlock = {
  type: 'choices',
  id: 'phi',
  question: 'Does this work introduce or surface any PHI or PII?',
  options: [
    { letter: 'a', text: 'Yes — name the fields' },
    { letter: 'b', text: 'No — none beyond existing timecard entry' },
  ],
};
const flag: ChoiceBlock = {
  type: 'choices',
  id: 'flag',
  question: 'How should this ship?',
  options: [{ letter: 'a', text: 'No flag needed — ship directly' }],
};

describe('formatChoiceAnswers', () => {
  it('quotes the question with each answer so the agent can match it', () => {
    expect(
      formatChoiceAnswers([phi], { phi: { selected: 'b', freeform: '' } }, 8),
    ).toBe(
      'Q9 · Does this work introduce or surface any PHI or PII?\n' +
        'Answer: B — No — none beyond existing timecard entry',
    );
  });

  it('includes notes and free-form answers', () => {
    expect(
      formatChoiceAnswers([phi, flag], {
        phi: { selected: 'a', freeform: 'SSN only' },
        flag: { selected: 'other', freeform: 'Behind the CA rollout flag' },
      }),
    ).toBe(
      'Q1 · Does this work introduce or surface any PHI or PII?\n' +
        'Answer: A — Yes — name the fields\n' +
        'Notes: SSN only\n\n' +
        'Q2 · How should this ship?\n' +
        'Answer: Behind the CA rollout flag',
    );
  });

  it('skips unanswered questions but keeps on-screen numbering', () => {
    expect(
      formatChoiceAnswers([phi, flag], { flag: { selected: 'a', freeform: '' } }),
    ).toBe('Q2 · How should this ship?\nAnswer: A — No flag needed — ship directly');
  });
});
