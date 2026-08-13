import { fireEvent, render, screen } from '@testing-library/react';
import { GroundingHandoffDialog } from '../GroundingHandoffDialog';
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
  stalenessState: 'fresh',
  commitsBehind: 8,
  changedFileCount: 2,
  canReGround: true,
};

describe('GroundingHandoffDialog', () => {
  it('offers inherit as the default action and latest as the escape hatch', () => {
    const onInherit = jest.fn();
    const onUseLatest = jest.fn();
    render(
      <GroundingHandoffDialog
        parentLabel="the interview"
        status={status}
        isPending={false}
        error={null}
        onInherit={onInherit}
        onUseLatest={onUseLatest}
        onClose={jest.fn()}
      />,
    );

    expect(screen.getByTestId('grounding-handoff-inherit')).toHaveTextContent(
      /interview/i,
    );
    fireEvent.click(screen.getByTestId('grounding-handoff-latest'));
    expect(onUseLatest).toHaveBeenCalled();
    expect(onInherit).not.toHaveBeenCalled();
  });
});
