import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { BuildsListView } from '../BuildsListView';
import { useMyPermissions } from '../../hooks/useRbac';
import { useBuilds } from '../../hooks/useBuilds';
import type { BuildListItem } from '../../../shared/types/build';

jest.mock('../../hooks/useRbac', () => ({ useMyPermissions: jest.fn() }));
jest.mock('../../hooks/useBuilds', () => ({ useBuilds: jest.fn() }));

const permissions = useMyPermissions as jest.Mock;
const builds = useBuilds as jest.Mock;

function row(overrides: Partial<BuildListItem> = {}): BuildListItem {
  return {
    id: 'build-1',
    repository: 'apex',
    status: 'building',
    suspendReason: null,
    requesterUserId: 'user-1',
    requesterDisplayName: 'Ada',
    createdAt: '2026-10-26T12:00:00.000Z',
    queuePosition: null,
    interviewId: null,
    playbookRunId: 'run-1',
    ...overrides,
  };
}

function renderList(initial = '/builds') {
  const Probe = () => {
    const location = useLocation();
    return <div {...{ 'data-testid': 'location' }}>{location.pathname}</div>;
  };
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="*" element={<><BuildsListView project="Apex" /><Probe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('BuildsListView (VT-16, VT-17, VT-18)', () => {
  beforeEach(() => {
    permissions.mockReturnValue({ can: () => true, isLoading: false });
    builds.mockReturnValue({
      isLoading: false,
      isError: false,
      isSuccess: true,
      data: { builds: [row(), row({ id: 'build-2', status: 'queued', queuePosition: 2 })], total: 2, limit: 50, offset: 0 },
      refetch: jest.fn(),
    });
  });

  it('VT-16 shows the stage, the queue position, and opens the build', () => {
    renderList();
    expect(screen.getByTestId('builds-list-row-build-1')).toBeInTheDocument();
    expect(screen.getByTestId('builds-list-queue-position-build-2')).toHaveTextContent('Queued — position 2');
    fireEvent.click(screen.getByTestId('builds-list-open-build-1'));
    expect(screen.getByTestId('location')).toHaveTextContent('/builds/build-1');
  });

  it('VT-17 filters to in-progress and says when the search matches nothing', () => {
    renderList();
    fireEvent.click(screen.getByTestId('builds-list-filter-in-progress'));
    expect(builds).toHaveBeenLastCalledWith('Apex', expect.objectContaining({ state: 'active' }));
    fireEvent.change(screen.getByTestId('builds-list-search'), { target: { value: 'missing' } });
    expect(screen.getByTestId('builds-list-no-matches')).toBeInTheDocument();
  });

  it('VT-18 shows the next page control when more than one page exists', () => {
    builds.mockReturnValue({
      isLoading: false,
      isError: false,
      isSuccess: true,
      data: { builds: [row()], total: 51, limit: 50, offset: 0 },
      refetch: jest.fn(),
    });
    renderList();
    expect(screen.getByTestId('builds-list-page-next')).toBeEnabled();
    expect(screen.getByTestId('builds-list-page-prev')).toBeDisabled();
  });
});
