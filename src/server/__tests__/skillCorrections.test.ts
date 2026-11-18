import { diffCorrection, formatCorrectionDiff, loadEventCorrections } from '../services/skillCorrections';
import { readCorrectedArtifact, readRegressionSnapshot, snapshotText } from '../services/workflowEvaluationArtifactStore';

const rows: unknown[] = [];
jest.mock('../db/drizzle', () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    leftJoin: () => chain,
    where: () => Promise.resolve(rows),
  };
  return { db: chain };
});
jest.mock('../services/workflowEvaluationArtifactStore', () => ({
  readCorrectedArtifact: jest.fn(),
  readRegressionSnapshot: jest.fn(),
  snapshotText: jest.fn(),
}));

const corrected = { container: 'c', key: 'corrected-artifact.md' };
const original = { container: 'c', key: 'original-artifact.json' };

describe('skillCorrections', () => {
  beforeEach(() => {
    rows.length = 0;
    jest.mocked(readCorrectedArtifact).mockReset();
    jest.mocked(readRegressionSnapshot).mockReset();
    jest.mocked(snapshotText).mockReset();
  });

  it('lists the sections and lines a reviewer added and removed', () => {
    const diff = diffCorrection(
      '## Goals\nShip it\n## Notes\nold line',
      '## Goals\nShip it\n## Rollout plan\nStage by region',
    );
    expect(diff).toEqual({
      addedHeadings: ['Rollout plan'],
      removedHeadings: ['Notes'],
      addedLines: ['## Rollout plan', 'Stage by region'],
      removedLines: ['## Notes', 'old line'],
    });
    expect(formatCorrectionDiff(diff)).toBe([
      'Sections added: Rollout plan',
      'Sections removed: Notes',
      '+ ## Rollout plan',
      '+ Stage by region',
      '- ## Notes',
      '- old line',
    ].join('\n'));
  });

  it('has nothing to show when the text is unchanged', () => {
    expect(formatCorrectionDiff(diffCorrection('## A\nx', '## A\nx'))).toBeNull();
  });

  it('reads the corrected copy and the original from Blob storage', async () => {
    rows.push({ eventId: 'e1', correctedText: null, correctedRef: corrected, originalRef: original });
    jest.mocked(readCorrectedArtifact).mockResolvedValue('## New');
    jest.mocked(readRegressionSnapshot).mockResolvedValue({} as never);
    jest.mocked(snapshotText).mockReturnValue('## Old');
    const pairs = await loadEventCorrections(['e1']);
    expect(pairs.get('e1')).toEqual({ eventId: 'e1', original: '## Old', corrected: '## New' });
  });

  it('uses legacy inline text, and skips a correction whose Blob read fails', async () => {
    rows.push(
      { eventId: 'legacy', correctedText: '## Inline', correctedRef: null, originalRef: null },
      { eventId: 'broken', correctedText: null, correctedRef: corrected, originalRef: null },
    );
    jest.mocked(readCorrectedArtifact).mockRejectedValue(new Error('404'));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pairs = await loadEventCorrections(['legacy', 'broken']);
    expect([...pairs.keys()]).toEqual(['legacy']);
    expect(pairs.get('legacy')).toEqual({ eventId: 'legacy', original: null, corrected: '## Inline' });
    expect(readCorrectedArtifact).toHaveBeenCalledTimes(1);
  });
});
