import {
  latestGuidedInterviewPhaseIndex,
  sliceGuidedInterviewPhases,
} from '../services/guidedInterviewState';

describe('sliceGuidedInterviewPhases — TBI-006', () => {
  it('VT-06 / TBI-006 (a): splits Discovery and Delivery, keeps the reply in the earlier phase, and drops hidden messages', () => {
    const slices = sliceGuidedInterviewPhases([
      { role: 'agent', text: 'What goes wrong today? [[interview-phase:discovery:1:6]]' },
      { role: 'user', text: 'Reviews take too long.' },
      { role: 'agent', text: 'Confirm the brief. [[interview-phase:discovery:6:6]]' },
      { role: 'user', text: 'Yes, that brief is right.' },
      { role: 'agent', text: 'internal prompt', hidden: true },
      { role: 'system', text: 'system note' },
      { role: 'tool', text: 'tool note' },
      { role: 'agent', text: 'Delivery begins. [[interview-phase:delivery:done]]' },
    ]);

    expect(slices).toHaveLength(2);
    expect(slices[0].phaseIndex).toBe(1);
    expect(slices[0].messages.map((message) => message.text)).toEqual([
      'What goes wrong today? [[interview-phase:discovery:1:6]]',
      'Reviews take too long.',
      'Confirm the brief. [[interview-phase:discovery:6:6]]',
      'Yes, that brief is right.',
    ]);
    expect(slices[1].phaseIndex).toBe(2);
    expect(slices[1].messages).toHaveLength(1);
    expect(JSON.stringify(slices)).not.toContain('internal prompt');
    expect(JSON.stringify(slices)).not.toContain('system note');
    expect(JSON.stringify(slices)).not.toContain('tool note');
    expect(latestGuidedInterviewPhaseIndex([
      { role: 'agent', text: '[[interview-phase:discovery:1:6]]' },
      { role: 'agent', text: '[[interview-phase:delivery:done]]' },
    ])).toBe(2);
  });
});
