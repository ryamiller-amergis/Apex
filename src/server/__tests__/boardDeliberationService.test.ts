import {
  parseBoardDeliberationAgenda,
  selectBoardDeliberationEntries,
  shouldRunBoardRebuttal,
} from '../services/boardDeliberationService';

const response = {
  role: 'operations',
  topicId: 'T1',
  position: 'Keep one owner.',
  evidence: [],
  challenges: [],
  revisions: [],
  confidence: 0.7,
  newEvidence: false,
};

describe('board deliberation limits', () => {
  it('reserves one inquiry for synthesis', () => {
    expect(selectBoardDeliberationEntries(['a', 'b', 'c'], 4, 2)).toEqual([
      'a',
    ]);
    expect(selectBoardDeliberationEntries(['a'], 4, 3)).toEqual([]);
  });

  it('stops after responses when no challenge or new evidence exists', () => {
    expect(shouldRunBoardRebuttal([response], 2)).toBe(false);
  });

  it('runs one rebuttal round for a challenge, but never exceeds maxRounds', () => {
    const challenged = { ...response, challenges: ['Compliance disagrees.'] };
    expect(shouldRunBoardRebuttal([challenged], 2)).toBe(true);
    expect(shouldRunBoardRebuttal([challenged], 1)).toBe(false);
  });

  it('rejects duplicate topic ids and duplicate participants', () => {
    const topic = {
      id: 'T1',
      title: 'Ownership',
      question: 'Who owns the workflow?',
      participants: ['operations', 'product'],
      evidenceNeeded: [],
    };
    expect(() =>
      parseBoardDeliberationAgenda({
        role: 'moderator',
        noMaterialDisagreement: false,
        topics: [topic, { ...topic, title: 'Duplicate' }],
      })
    ).toThrow(/Duplicate deliberation topic id/);
    expect(() =>
      parseBoardDeliberationAgenda({
        role: 'moderator',
        noMaterialDisagreement: false,
        topics: [{ ...topic, participants: ['operations', 'operations'] }],
      })
    ).toThrow(/Duplicate participant/);
  });
});
