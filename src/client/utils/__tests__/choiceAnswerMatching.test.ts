import { choiceBlocksAnsweredByLaterMessages } from '../choiceAnswerMatching';
import type { ChoiceBlock } from '../parseAgentMessage';

function block(id: string, question: string): ChoiceBlock {
  return {
    type: 'choices',
    id,
    question,
    options: [
      { letter: 'a', text: 'Option A' },
      { letter: 'b', text: 'Option B' },
    ],
  };
}

describe('choiceBlocksAnsweredByLaterMessages', () => {
  it('is false when no later user message exists', () => {
    expect(choiceBlocksAnsweredByLaterMessages([block('q1', 'Who may create a session?')], [])).toBe(false);
  });

  it('is false when a later user message answers a different question', () => {
    const blocks = [block('q4', 'Who may edit a session?')];
    const laterUserTexts = ['Q3 · Who may create a session?\nAnswer: A — Option A'];
    expect(choiceBlocksAnsweredByLaterMessages(blocks, laterUserTexts)).toBe(false);
  });

  it('is true when a later user message quotes this exact question', () => {
    const blocks = [block('q3', 'Who may create a session?')];
    const laterUserTexts = ['Q3 · Who may create a session?\nAnswer: A — Option A'];
    expect(choiceBlocksAnsweredByLaterMessages(blocks, laterUserTexts)).toBe(true);
  });

  it('requires every block in a multi-block message to be quoted', () => {
    const blocks = [block('q3', 'Who may create a session?'), block('q4', 'Who may edit a session?')];
    const laterUserTexts = ['Q3 · Who may create a session?\nAnswer: A — Option A'];
    expect(choiceBlocksAnsweredByLaterMessages(blocks, laterUserTexts)).toBe(false);
  });

  it('falls back to "a later reply exists" when the block has no question text', () => {
    expect(choiceBlocksAnsweredByLaterMessages([block('q1', '')], ['anything'])).toBe(true);
    expect(choiceBlocksAnsweredByLaterMessages([block('q1', '')], [])).toBe(false);
  });
});
