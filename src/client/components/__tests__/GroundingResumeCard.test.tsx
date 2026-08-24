import { fireEvent, render, screen } from '@testing-library/react';
import { GroundingResumeCard } from '../GroundingResumeCard';
import type { RunGroundingStatus } from '../../../shared/types/runGrounding';

const sha = 'a'.repeat(40);
const status: RunGroundingStatus = {
  runType: 'chat',
  runId: 'thread-1',
  role: 'target',
  groundedSha: sha,
  groundedShaShort: sha.slice(0, 12),
  groundedAt: '2026-08-02T14:00:00.000Z',
  driftState: 'source-changed',
  stalenessState: 'soft-stale',
  commitsBehind: 12,
  changedFileCount: 4,
  canReGround: true,
};

describe('GroundingResumeCard', () => {
  it('defaults to continuing on the original snapshot', () => {
    const onContinue = jest.fn();
    const onUpdateToLatest = jest.fn();
    render(
      <GroundingResumeCard
        status={status}
        isPending={false}
        error={null}
        onContinue={onContinue}
        onUpdateToLatest={onUpdateToLatest}
      />,
    );

    expect(screen.getByTestId('grounding-resume-card')).toHaveTextContent(
      /12 commits behind/i,
    );
    fireEvent.click(screen.getByTestId('grounding-resume-continue'));
    expect(onContinue).toHaveBeenCalled();
    expect(onUpdateToLatest).not.toHaveBeenCalled();
  });
});
