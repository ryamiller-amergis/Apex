import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { BrainstormVersionHistoryDrawer, STALE_ROLLBACK_MESSAGE } from '../BrainstormVersionHistoryDrawer';
import { useBrainstormCompare, useBrainstormVersions, useRollbackArtifact } from '../../hooks/useBrainstormArtifact';
import { BrainstormApiError } from '../../hooks/useBrainstormSessions';
import type { BrainstormVersionSummaryDto } from '../../../shared/types/brainstormArtifact';

jest.mock('../../hooks/useBreakpoint', () => ({ useBreakpoint: () => ({ isMobile: false, isTablet: false, isDesktop: true }) }));
jest.mock('../../hooks/useBrainstormArtifact', () => ({
  useBrainstormVersions: jest.fn(),
  useBrainstormCompare: jest.fn(),
  useRollbackArtifact: jest.fn(),
}));

const versionsHook = useBrainstormVersions as jest.Mock;
const compareHook = useBrainstormCompare as jest.Mock;
const rollbackHook = useRollbackArtifact as jest.Mock;

function version(sequence: number, overrides: Partial<BrainstormVersionSummaryDto> = {}): BrainstormVersionSummaryDto {
  return {
    sequence,
    origin: 'ai_change',
    checkpointName: null,
    artifactType: 'adr',
    authorId: null,
    createdAt: '2026-10-29T10:00:00.000Z',
    sizeBytes: 10,
    ...overrides,
  };
}

function Harness({ count }: { count: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} {...{ 'data-testid': 'brainstorm-history-open' }}>History</button>
      {open && (
        <BrainstormVersionHistoryDrawer
          project="Apex"
          sessionId="s-1"
          currentVersion={count}
          canMutate
          turnRunning={false}
          onClose={() => {
            setOpen(false);
            document.querySelector<HTMLButtonElement>('[data-testid="brainstorm-history-open"]')?.focus();
          }}
        />
      )}
    </>
  );
}

beforeEach(() => {
  rollbackHook.mockReturnValue({ mutateAsync: jest.fn().mockResolvedValue({}), isPending: false });
  compareHook.mockImplementation((_p: string, _s: string, pair: [number, number] | null) => (
    pair
      ? {
        data: {
          from: { ...version(pair[0]), markdown: '# Title\nold line' },
          to: { ...version(pair[1]), markdown: '# Title\nnew line' },
        },
        isLoading: false,
        isError: false,
      }
      : { data: undefined, isLoading: false, isError: false }
  ));
});

describe('BrainstormVersionHistoryDrawer', () => {
  it('VT-20: focus moves in, two rows compare with +/− text markers, Escape returns focus to History', () => {
    versionsHook.mockReturnValue({
      data: { versions: [version(4), version(3, { checkpointName: 'Draft' }), version(2), version(1)], nextCursor: null },
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
    render(<Harness count={4} />);
    const history = screen.getByTestId('brainstorm-history-open');
    history.focus();
    fireEvent.click(history);

    expect(screen.getByRole('heading', { name: 'Version history' })).toHaveFocus();
    expect(screen.getByText('Draft')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('brainstorm-version-select-2'));
    fireEvent.click(screen.getByTestId('brainstorm-version-select-4'));
    fireEvent.click(screen.getByTestId('brainstorm-version-compare'));

    const compare = screen.getByTestId('brainstorm-compare-view');
    expect(compare).toHaveTextContent('Version 2 to version 4');
    expect(compare.textContent).toContain('+');
    expect(compare.textContent).toContain('−');
    expect(compareHook).toHaveBeenLastCalledWith('Apex', 's-1', [2, 4]);

    const changesOnlyToggle = screen.getByTestId('brainstorm-compare-changes-only');
    expect(changesOnlyToggle).not.toBeChecked();
    fireEvent.click(changesOnlyToggle);
    expect(changesOnlyToggle).toBeChecked();

    fireEvent.keyDown(screen.getByTestId('brainstorm-history-drawer'), { key: 'Escape' });
    expect(screen.queryByTestId('brainstorm-history-drawer')).not.toBeInTheDocument();
    expect(history).toHaveFocus();
  });

  it('VT-17: with one version there is nothing to compare', () => {
    versionsHook.mockReturnValue({ data: { versions: [version(1)], nextCursor: null }, isLoading: false, isError: false, isSuccess: true });
    render(<Harness count={1} />);
    fireEvent.click(screen.getByTestId('brainstorm-history-open'));

    expect(screen.getByTestId('brainstorm-compare-empty')).toHaveTextContent('There is nothing to compare yet');
    expect(screen.queryByTestId('brainstorm-version-compare')).not.toBeInTheDocument();
  });

  it('VT-16 (UI): a stale rollback explains what happened and writes nothing', async () => {
    const mutateAsync = jest.fn().mockRejectedValue(
      new BrainstormApiError(409, 'conflict', { code: 'ARTIFACT_VERSION_CONFLICT', currentVersion: 6 }),
    );
    rollbackHook.mockReturnValue({ mutateAsync, isPending: false });
    versionsHook.mockReturnValue({ data: { versions: [version(5), version(4)], nextCursor: null }, isLoading: false, isError: false, isSuccess: true });
    render(<Harness count={5} />);
    fireEvent.click(screen.getByTestId('brainstorm-history-open'));

    expect(screen.queryByTestId('brainstorm-rollback-5')).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId('brainstorm-rollback-4'));
    });
    expect(mutateAsync).toHaveBeenCalledWith({ toSequence: 4, expectedVersion: 5 });
    expect(screen.getByTestId('brainstorm-rollback-stale')).toHaveTextContent(STALE_ROLLBACK_MESSAGE);
  });
});
