/**
 * FEAT-004 — shared merge utility (PBI-004 AC-0 / AC-3).
 */

import {
  mergeAcceptedUnitsIntoDraft,
  type WalkthroughAiProposalUnit,
} from '../../shared/types/walkthroughAiDraft';

describe('mergeAcceptedUnitsIntoDraft', () => {
  const fieldsUnit: WalkthroughAiProposalUnit = {
    unitId: 'walkthrough-fields',
    kind: 'walkthrough-fields',
    value: {
      internalName: 'accepted-name',
      userTitle: 'Accepted Title',
      whyItMatters: 'Why',
    },
  };

  const step1: WalkthroughAiProposalUnit = {
    unitId: 'step-s1',
    kind: 'step',
    value: {
      id: 's1',
      ordinal: 0,
      heading: 'One',
      bodyMarkdown: 'body-1',
      imageCandidatePath: '/favicon.svg',
      imageUrl: '/favicon.svg',
    },
    imageCandidatePath: '/favicon.svg',
  };

  const step2: WalkthroughAiProposalUnit = {
    unitId: 'step-s2',
    kind: 'step',
    value: {
      id: 's2',
      ordinal: 1,
      heading: 'Two',
      bodyMarkdown: 'body-2',
    },
  };

  it('AC-0 — merges only accepted units and preserves Step order', () => {
    const merged = mergeAcceptedUnitsIntoDraft(
      {
        internalName: 'old',
        userTitle: 'old',
        whyItMatters: 'old',
        steps: [],
      },
      {
        'walkthrough-fields': { status: 'accepted' },
        'step-s1': { status: 'accepted', imageConfirmed: true },
        'step-s2': { status: 'rejected' },
      },
      [fieldsUnit, step1, step2],
    );

    expect(merged.internalName).toBe('accepted-name');
    expect(merged.steps).toHaveLength(1);
    expect(merged.steps[0].heading).toBe('One');
    expect(merged.steps[0].imageUrl).toBe('/favicon.svg');
  });

  it('AC-3 — rejected Step content is absent from merged draft', () => {
    const merged = mergeAcceptedUnitsIntoDraft(
      {
        internalName: 'base',
        userTitle: 'base',
        whyItMatters: 'base',
        steps: [{ id: 'existing', ordinal: 0, heading: 'Existing', bodyMarkdown: 'x' }],
      },
      {
        'step-s2': { status: 'rejected' },
      },
      [step2],
    );
    expect(merged.steps.map((s) => s.heading)).toEqual(['Existing']);
    expect(merged.steps.some((s) => s.heading === 'Two')).toBe(false);
  });

  it('AC-2 — image omitted when accepted without confirmation', () => {
    const merged = mergeAcceptedUnitsIntoDraft(
      { internalName: '', userTitle: '', whyItMatters: '', steps: [] },
      { 'step-s1': { status: 'accepted', imageConfirmed: false } },
      [step1],
    );
    expect(merged.steps[0].imageUrl).toBeNull();
  });

  it('does not keep an empty placeholder as Step 1 when accepting AI steps', () => {
    const merged = mergeAcceptedUnitsIntoDraft(
      {
        internalName: '',
        userTitle: '',
        whyItMatters: '',
        steps: [{ id: 'step-placeholder-0', ordinal: 0, heading: '', bodyMarkdown: '' }],
      },
      {
        'step-s1': { status: 'accepted' },
        'step-s2': { status: 'accepted' },
      },
      [step1, step2],
    );

    expect(merged.steps.map((s) => s.heading)).toEqual(['One', 'Two']);
    expect(merged.steps[0].id).toBe('s1');
    expect(merged.steps[0].bodyMarkdown).toBe('body-1');
  });
});
