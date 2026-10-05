/**
 * AC-0 classifier fixtures from the walkthrough-anchor-smart-tagging rubric.
 */

import {
  ANCHOR_CLASSIFIER_AI_THRESHOLD,
  ANCHOR_CLASSIFIER_MODEL,
  classifyWalkthroughAnchor,
  isHighConfidenceClassifierProvenance,
} from '../services/walkthroughAnchorSmartTagClassifier';

describe('walkthroughAnchorSmartTagClassifier', () => {
  it('AC-0: ado-create-error with unique owning page is high-confidence and evidence-first', () => {
    const result = classifyWalkthroughAnchor({
      testId: 'ado-create-error',
      sourceLocations: [
        {
          filePath: 'src/client/components/CreateAdoItemsModal.tsx',
          line: 415,
          discoveryKind: 'data_testid',
        },
      ],
      owningPageEntries: [
        {
          component: 'src/client/components/BacklogViewer.tsx',
          routePattern: '/backlog',
          suggestedRoute: '/backlog',
          moduleKey: 'backlog',
          moduleLabel: 'Backlog',
        },
      ],
    });

    expect(result.label).toBe('Ado Create Error');
    expect(result.suggestedRoute).toBe('/backlog');
    expect(result.allowedPlacements).toEqual(['top', 'right', 'bottom', 'left']);
    expect(result.smartTags).toEqual(expect.arrayContaining(['ado', 'create', 'error']));
    expect(result.smartTags.length).toBeGreaterThanOrEqual(3);
    expect(result.smartTags.length).toBeLessThanOrEqual(8);
    expect(result.aiProvenance.model).toBe(ANCHOR_CLASSIFIER_MODEL);
    expect(result.aiProvenance.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.aiProvenance.confidence).toBeLessThanOrEqual(1);
    expect(result.aiProvenance.rationale).toMatch(/CreateAdoItemsModal\.tsx:415/);
    expect(result.aiProvenance.rationale).toMatch(/Backlog/);
    expect(
      isHighConfidenceClassifierProvenance({
        smartTags: result.smartTags,
        aiProvenance: result.aiProvenance,
      }),
    ).toBe(true);
  });

  it('AC-3: shared / no owner stays below the AI leftover threshold', () => {
    const result = classifyWalkthroughAnchor({
      testId: 'shared-layout-header',
      sourceLocations: [
        { filePath: 'src/client/components/AppHeader.tsx', line: 20 },
      ],
      owningPageEntries: [],
    });

    expect(result.aiProvenance.model).toBe(ANCHOR_CLASSIFIER_MODEL);
    expect(result.aiProvenance.confidence).toBeLessThan(ANCHOR_CLASSIFIER_AI_THRESHOLD);
    expect(
      isHighConfidenceClassifierProvenance({
        smartTags: result.smartTags,
        aiProvenance: result.aiProvenance,
      }),
    ).toBe(false);
  });
});
