import {
  adrAttachmentFileName,
  buildFeatureRequestInterviewPrefillText,
  isInterviewableWorkItemType,
  toFeatureRequestInterviewPrefill,
} from '../featureRequestInterview';

describe('featureRequestInterview utils', () => {
  it('marks feature and technical as interviewable', () => {
    expect(isInterviewableWorkItemType('feature')).toBe(true);
    expect(isInterviewableWorkItemType('technical')).toBe(true);
    expect(isInterviewableWorkItemType('issue')).toBe(false);
  });

  it('maps a work item into interview prefill state', () => {
    expect(
      toFeatureRequestInterviewPrefill({
        id: 'fr-1',
        type: 'technical',
        title: 'Refactor PDF',
        request: 'Offload assembly',
        advantage: null,
        linkedAdrs: [
          {
            id: 'adr-1',
            title: 'Scale PDF',
            project: 'Apex',
            repo: 'Apex',
            slug: 'scale-pdf',
            status: 'accepted',
          },
        ],
      }),
    ).toEqual({
      id: 'fr-1',
      type: 'technical',
      title: 'Refactor PDF',
      request: 'Offload assembly',
      advantage: '',
      linkedAdrs: [{ id: 'adr-1', title: 'Scale PDF', slug: 'scale-pdf' }],
    });
  });

  it('builds type-aware prefill text and lists linked ADRs', () => {
    expect(
      buildFeatureRequestInterviewPrefillText({
        id: 'fr-1',
        type: 'technical',
        title: 'Refactor PDF',
        request: 'Offload assembly',
        advantage: '',
        linkedAdrs: [{ id: 'adr-1', title: 'Scale PDF', slug: 'scale-pdf' }],
      }),
    ).toBe(
      [
        'This interview originated from a technical work item.',
        '',
        'Offload assembly',
        '',
        'Linked accepted ADRs are attached as markdown files for architectural context:',
        '- Scale PDF (scale-pdf)',
      ].join('\n'),
    );
  });

  it('builds a stable markdown attachment filename from slug or title', () => {
    expect(adrAttachmentFileName({ id: 'adr-1', title: 'Scale PDF!', slug: 'scale-pdf' })).toBe(
      'scale-pdf.md',
    );
    expect(adrAttachmentFileName({ id: 'adr-1', title: 'Scale PDF Assembly', slug: null })).toBe(
      'scale-pdf-assembly.md',
    );
  });
});
