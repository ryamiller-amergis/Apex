import {
  adrUsageCtx,
  designDocPendingUsageSteps,
  designDocUsageCtx,
  designDocUsageThreadLabels,
  designPlanUsageCtx,
  labelUsageRun,
  prdPendingUsageSteps,
  prdReviewUsageCtx,
  prdUsageThreadLabels,
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

  it('labels PRD threads including test-case generation', () => {
    expect(
      prdUsageThreadLabels({
        chatThreadId: 'gen',
        prdAssistantThreadId: 'asst',
        validationThreadId: 'val',
        latestTestCase: { chatThreadId: 'tc' },
      }),
    ).toEqual({
      gen: 'Generate',
      tc: 'Test cases',
      val: 'Validation',
      asst: 'Assistant',
    });
  });

  it('marks PRD test-case and validation steps pending independently', () => {
    expect(
      prdPendingUsageSteps({
        status: 'validating',
        testCasesRequired: true,
        latestTestCase: { status: 'generating' },
      }),
    ).toEqual(['Test cases', 'Validation']);
    expect(prdPendingUsageSteps({ status: 'pending_review', testCasesRequired: false })).toEqual([]);
  });

  it('labels design-doc generate vs validation threads', () => {
    expect(
      designDocUsageThreadLabels({
        chatThreadId: 'gen',
        docAssistantThreadId: 'asst',
        validationThreadId: 'val',
      }),
    ).toEqual({
      gen: 'Generate',
      val: 'Validation',
      asst: 'Assistant',
    });
    expect(designDocPendingUsageSteps({ status: 'validating' })).toEqual(['Validation']);
    expect(designDocPendingUsageSteps({ status: 'draft' })).toEqual([]);
  });

  it('prefers thread labels over feature when steps use different models', () => {
    expect(
      labelUsageRun({
        threadId: 'val',
        feature: 'prd',
        threadLabels: { val: 'Validation' },
      }),
    ).toBe('Validation');
    expect(labelUsageRun({ feature: 'test-case' })).toBe('Test cases');
    expect(labelUsageRun({ skillPath: '.cursor/skills/to-prd/SKILL.md' })).toBe('Generate');
  });
});
