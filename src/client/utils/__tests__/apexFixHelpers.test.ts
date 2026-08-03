import {
  designDocHasProposedChanges,
  isDesignDocSingleCommentFixPending,
  isPrdFixFlowOwningAccept,
  isPrdSingleCommentFixPending,
  isPrdUnchangedFromFixBaseline,
  prdHasProposedChanges,
} from '../apexFixHelpers';

describe('apexFixHelpers', () => {
  it('owns accept/revert while fixBaseline or fix phase is active', () => {
    expect(
      isPrdFixFlowOwningAccept(
        { fixBaseline: null, proposedContent: null, proposedBacklogJson: null },
        'idle',
      ),
    ).toBe(false);
    expect(
      isPrdFixFlowOwningAccept(
        {
          fixBaseline: { content: '# baseline', capturedAt: '2026-01-01T00:00:00Z' },
          proposedContent: null,
          proposedBacklogJson: null,
        },
        'idle',
      ),
    ).toBe(true);
    expect(
      isPrdFixFlowOwningAccept(
        { fixBaseline: null, proposedContent: null, proposedBacklogJson: null },
        'fixing',
      ),
    ).toBe(true);
    expect(
      isPrdFixFlowOwningAccept(
        { fixBaseline: null, proposedContent: null, proposedBacklogJson: null },
        'reviewing',
      ),
    ).toBe(true);
  });

  it('does not own accept when assistant/comment proposed drafts are present', () => {
    expect(
      isPrdFixFlowOwningAccept(
        {
          fixBaseline: { content: '# baseline', capturedAt: '2026-01-01T00:00:00Z' },
          proposedContent: '# Proposed from assistant',
          proposedBacklogJson: null,
        },
        'reviewing',
      ),
    ).toBe(false);
  });

  it('detects when live PRD content still matches the fix baseline (no-op)', () => {
    const baseline = {
      content: '# PRD',
      backlogJson: { items: [{ id: '1' }] },
      capturedAt: '2026-01-01T00:00:00Z',
    };
    expect(
      isPrdUnchangedFromFixBaseline(
        { content: '# PRD', backlogJson: { items: [{ id: '1' }] } },
        baseline,
      ),
    ).toBe(true);
    expect(
      isPrdUnchangedFromFixBaseline(
        { content: '# PRD changed', backlogJson: { items: [{ id: '1' }] } },
        baseline,
      ),
    ).toBe(false);
    expect(
      isPrdUnchangedFromFixBaseline(
        { content: '# PRD', backlogJson: { items: [{ id: '2' }] } },
        baseline,
      ),
    ).toBe(false);
    expect(
      isPrdUnchangedFromFixBaseline(
        { content: '', backlogJson: null },
        { content: '' },
      ),
    ).toBe(true);
  });

  it('detects PRD proposed changes across content and backlog proposals', () => {
    expect(prdHasProposedChanges({ proposedContent: null, proposedBacklogJson: null })).toBe(false);
    expect(prdHasProposedChanges({ proposedContent: '# Proposed', proposedBacklogJson: null })).toBe(true);
    expect(prdHasProposedChanges({ proposedContent: null, proposedBacklogJson: { items: [] } })).toBe(true);
  });

  it('treats a PRD single-comment fix as pending only before proposed changes arrive', () => {
    expect(
      isPrdSingleCommentFixPending({
        fixCommentId: 'comment-1',
        proposedContent: null,
        proposedBacklogJson: null,
      }),
    ).toBe(true);
    expect(
      isPrdSingleCommentFixPending({
        fixCommentId: 'comment-1',
        proposedContent: '# Proposed',
        proposedBacklogJson: null,
      }),
    ).toBe(false);
    expect(
      isPrdSingleCommentFixPending({
        fixCommentId: null,
        proposedContent: null,
        proposedBacklogJson: null,
      }),
    ).toBe(false);
  });

  it('detects proposed design-doc section changes', () => {
    expect(
      designDocHasProposedChanges({
        proposedDesignContent: null,
        proposedTechSpecContent: null,
        proposedAssumptionsContent: null,
      }),
    ).toBe(false);
    expect(
      designDocHasProposedChanges({
        proposedDesignContent: null,
        proposedTechSpecContent: 'New tech spec',
        proposedAssumptionsContent: null,
      }),
    ).toBe(true);
  });

  it('treats a design-doc single-comment fix as pending until a section proposal exists', () => {
    expect(
      isDesignDocSingleCommentFixPending({
        fixCommentId: 'comment-1',
        proposedDesignContent: null,
        proposedTechSpecContent: null,
        proposedAssumptionsContent: null,
      }),
    ).toBe(true);
    expect(
      isDesignDocSingleCommentFixPending({
        fixCommentId: 'comment-1',
        proposedDesignContent: null,
        proposedTechSpecContent: null,
        proposedAssumptionsContent: 'Updated assumption',
      }),
    ).toBe(false);
  });
});
