import {
  designDocHasProposedChanges,
  isDesignDocSingleCommentFixPending,
  isPrdSingleCommentFixPending,
  prdHasProposedChanges,
} from '../apexFixHelpers';

describe('apexFixHelpers', () => {
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
