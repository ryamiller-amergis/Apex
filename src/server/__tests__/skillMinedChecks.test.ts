import { headingsOf, mineHeadingProposals, minedTest, requiredHeadings } from '../services/skillMinedChecks';

jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/workflowEvaluationArtifactStore', () => ({
  readCorrectedArtifact: jest.fn(),
  readRegressionSnapshot: jest.fn(),
  snapshotText: jest.fn(),
}));

const unknownOriginal = (corrected: string) => ({ original: null, corrected });

describe('skillMinedChecks', () => {
  it('reads level-2 headings once each, without trailing hashes', () => {
    expect(headingsOf('# Title\n## Goals\ntext\n## Non-goals ##\n### Detail\n## goals\n')).toEqual(['goals', 'Non-goals']);
  });

  it('without originals, proposes headings most corrected copies carry and the suite does not require', () => {
    const pairs = [
      '## Rollout plan\n## Overview',
      '## Rollout plan\n## Overview',
      '## Rollout Plan\n## Risks',
      '## Overview',
    ].map(unknownOriginal);
    const proposals = mineHeadingProposals(pairs, new Set(['overview']));
    expect(proposals).toEqual([{ heading: 'Rollout plan', support: 3, share: 0.75 }]);
  });

  it('with originals, counts only headings the reviewer added', () => {
    const pairs = [
      { original: '## Risks\nbody', corrected: '## Risks\nbody\n## Rollout plan' },
      { original: '## Risks', corrected: '## Risks\n## Rollout plan' },
      { original: '## Risks', corrected: '## Risks\n## Rollout plan' },
    ];
    expect(mineHeadingProposals(pairs, new Set())).toEqual([{ heading: 'Rollout plan', support: 3, share: 1 }]);
  });

  it('needs at least three corrections behind a proposal', () => {
    expect(mineHeadingProposals(['## Risks', '## Risks'].map(unknownOriginal), new Set())).toEqual([]);
  });

  it('knows the headings the built-in PRD suite requires', () => {
    expect(requiredHeadings('prd_human_review').size).toBeGreaterThan(0);
  });

  it('turns a heading into a case-insensitive Promptfoo check on the artifact', () => {
    expect(minedTest('Rollout plan')).toEqual(expect.objectContaining({
      target: 'artifact',
      assert: [{ type: 'icontains', value: '## Rollout plan' }],
    }));
  });
});
