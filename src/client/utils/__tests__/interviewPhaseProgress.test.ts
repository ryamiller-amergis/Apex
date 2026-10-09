import {
  deriveInterviewPhaseProgress,
  previewInterviewPhaseProgress,
  stripInterviewPhaseMarkers,
  usesGuidedInterviewPhases,
} from '../interviewPhaseProgress';

describe('interviewPhaseProgress', () => {
  it('recognizes the grill-with-docs skill path', () => {
    expect(usesGuidedInterviewPhases('.cursor/skills/grill-with-docs/SKILL.md')).toBe(true);
    expect(usesGuidedInterviewPhases('.cursor\\skills\\grill-with-docs\\SKILL.md')).toBe(true);
    expect(usesGuidedInterviewPhases('.cursor/skills/grill-design/SKILL.md')).toBe(false);
    expect(usesGuidedInterviewPhases(null)).toBe(false);
  });

  it('strips a complete marker and a partial marker while streaming', () => {
    expect(stripInterviewPhaseMarkers('[[interview-phase:discovery:2:6]]\nWho has this problem?')).toBe(
      'Who has this problem?',
    );
    expect(stripInterviewPhaseMarkers('[[interview-phase:disc')).toBe('');
  });

  it('starts in Discovery before the agent speaks', () => {
    const progress = deriveInterviewPhaseProgress([]);
    expect(progress.steps.map((step) => step.state)).toEqual(['current', 'upcoming', 'optional']);
    expect(progress.steps[0].detail).toBe('Starting');
  });

  it('tracks the latest Discovery question and ignores an invalid one', () => {
    const progress = deriveInterviewPhaseProgress([
      '[[interview-phase:discovery:1:6]]\nProblem?',
      '[[interview-phase:discovery:9:6]]\nignored',
      '[[interview-phase:discovery:2:6]]\nSuccess?',
    ]);
    expect(progress.steps[0]).toMatchObject({ state: 'current', detail: 'Question 2 of 6' });
    expect(progress.summary).toBe('5 questions left in Discovery.');
  });

  it('marks Delivery in progress and Technical optional', () => {
    const progress = deriveInterviewPhaseProgress(['[[interview-phase:delivery:1:5]]']);
    expect(progress.steps.map((step) => [step.id, step.state])).toEqual([
      ['discovery', 'complete'],
      ['delivery', 'current'],
      ['technical', 'optional'],
    ]);
    expect(progress.summary).toBe('5 questions left in Delivery.');
  });

  it('offers Technical after Delivery without treating it as unfinished work', () => {
    const progress = deriveInterviewPhaseProgress(['[[interview-phase:delivery:done]]']);
    expect(progress.steps[2]).toMatchObject({ state: 'optional', detail: 'Optional' });
    expect(progress.summary).toMatch(/Continue to Technical/);
  });

  it('shows a skipped Technical phase as not part of this interview', () => {
    const progress = deriveInterviewPhaseProgress(['[[interview-phase:technical:skipped]]']);
    expect(progress.steps[2]).toMatchObject({
      state: 'skipped',
      detail: 'Not in this interview',
    });
  });

  it('describes the plan on the new-interview screen', () => {
    const progress = previewInterviewPhaseProgress();
    expect(progress.steps.map((step) => step.label)).toEqual(['Discovery', 'Delivery', 'Technical']);
    expect(progress.steps[2].state).toBe('optional');
  });
});
