/**
 * Unit tests for walkthroughAnchorSyncHeuristics.
 */

import {
  SYNC_HEURISTIC_CONFIDENCE,
  SYNC_HEURISTIC_MODEL,
  SYNC_HEURISTIC_SKILL_PATH,
  humanizeWalkthroughTestId,
  isPlausibleWalkthroughTestId,
  needsAiSmartTagging,
  needsSyncHeuristicEnrichment,
  suggestSyncCandidateMetadata,
} from '../services/walkthroughAnchorSyncHeuristics';

describe('walkthroughAnchorSyncHeuristics', () => {
  it('humanizes test ids', () => {
    expect(humanizeWalkthroughTestId('ado-create-error')).toBe('Ado Create Error');
  });

  it('suggests tags, route, placements, and provenance for ADO create error', () => {
    const suggestion = suggestSyncCandidateMetadata({
      testId: 'ado-create-error',
      sourceKind: 'data_testid',
      sourceLocations: [
        {
          filePath: 'src/client/components/CreateAdoItemsModal.tsx',
          line: 415,
          discoveryKind: 'data_testid',
        },
      ],
    });

    expect(suggestion.label).toBe('Ado Create Error');
    expect(suggestion.suggestedRoute).toBe('/backlog');
    expect(suggestion.allowedPlacements).toEqual(['top', 'right', 'bottom', 'left']);
    expect(suggestion.smartTags.length).toBeGreaterThanOrEqual(3);
    expect(suggestion.smartTags.length).toBeLessThanOrEqual(8);
    expect(suggestion.smartTags).toEqual(
      expect.arrayContaining(['create', 'modal', 'troubleshoot', 'ado']),
    );
    expect(suggestion.aiProvenance.model).toBe(SYNC_HEURISTIC_MODEL);
    expect(suggestion.aiProvenance.confidence).toBe(SYNC_HEURISTIC_CONFIDENCE);
    expect(suggestion.aiProvenance.rationale).toMatch(/Deterministic sync heuristic/);
  });

  it('needs enrichment only for empty pending rows', () => {
    expect(
      needsSyncHeuristicEnrichment({
        reviewStatus: 'pending',
        smartTags: [],
        aiProvenance: null,
      }),
    ).toBe(true);
    expect(
      needsSyncHeuristicEnrichment({
        reviewStatus: 'pending',
        smartTags: ['profile', 'settings', 'section'],
        aiProvenance: null,
      }),
    ).toBe(false);
    expect(
      needsSyncHeuristicEnrichment({
        reviewStatus: 'approved',
        smartTags: [],
        aiProvenance: null,
      }),
    ).toBe(false);
  });

  it('needs AI tagging for empty or heuristic pending but not for real AI provenance', () => {
    expect(
      needsAiSmartTagging({
        reviewStatus: 'pending',
        testId: 'ado-create-error',
        smartTags: [],
        aiProvenance: null,
      }),
    ).toBe(true);
    expect(
      needsAiSmartTagging({
        reviewStatus: 'pending',
        testId: 'ado-create-error',
        smartTags: ['ado', 'create', 'modal'],
        aiProvenance: {
          provider: 'cursor',
          model: SYNC_HEURISTIC_MODEL,
          skillPath: SYNC_HEURISTIC_SKILL_PATH,
          generatedAt: '2026-07-30T01:00:00.000Z',
          confidence: 0.42,
          rationale: 'heuristic',
        },
      }),
    ).toBe(true);
    expect(
      needsAiSmartTagging({
        reviewStatus: 'pending',
        testId: 'ado-create-error',
        smartTags: ['ado', 'create', 'modal'],
        aiProvenance: {
          provider: 'cursor',
          model: 'claude-sonnet-4',
          skillPath: '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
          generatedAt: '2026-07-30T01:00:00.000Z',
          confidence: 0.81,
          rationale: 'AI',
        },
      }),
    ).toBe(false);
    expect(isPlausibleWalkthroughTestId('${escaped}')).toBe(false);
    expect(isPlausibleWalkthroughTestId('ado-create-error')).toBe(true);
  });
});
