import {
  adrUsageCtx,
  designDocUsageCtx,
  designPlanUsageCtx,
  prdReviewUsageCtx,
  prototypeUsageCtx,
  uniqueThreadIds,
} from '../services/artifactUsageContext';

describe('artifactUsageContext', () => {
  it('builds prototype usageCtx with entityType design-prototype', () => {
    expect(prototypeUsageCtx('Apex', 'proto-1')).toEqual({
      feature: 'design-prototype',
      project: 'Apex',
      entityType: 'design-prototype',
      entityId: 'proto-1',
    });
  });

  it('defaults prototype project to unknown when missing', () => {
    expect(prototypeUsageCtx(undefined, 'proto-1').project).toBe('unknown');
  });

  it('builds design-plan usageCtx attached to the plan id', () => {
    expect(designPlanUsageCtx('Apex', 'plan-1')).toEqual({
      feature: 'design-plan',
      project: 'Apex',
      entityType: 'design-plan',
      entityId: 'plan-1',
    });
  });

  it('builds PRD-fix usageCtx with feature prd-review', () => {
    expect(prdReviewUsageCtx('Apex', 'prd-1', 'user-1')).toEqual({
      feature: 'prd-review',
      project: 'Apex',
      entityType: 'prd',
      entityId: 'prd-1',
      userId: 'user-1',
    });
  });

  it('builds design-doc usageCtx', () => {
    expect(designDocUsageCtx('Apex', 'doc-1').entityType).toBe('design-doc');
  });

  it('builds ADR usageCtx with feature adr, not other', () => {
    expect(adrUsageCtx('Apex', 'adr-1').feature).toBe('adr');
  });

  it('dedupes thread ids', () => {
    expect(uniqueThreadIds('a', null, 'a', undefined, 'b')).toEqual(['a', 'b']);
  });
});
