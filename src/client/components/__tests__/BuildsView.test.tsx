import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { BuildsView } from '../BuildsView';
import { useMyPermissions } from '../../hooks/useRbac';
import { useBuilds } from '../../hooks/useBuilds';

jest.mock('../../hooks/useRbac', () => ({
  useMyPermissions: jest.fn(),
}));

jest.mock('../../hooks/useBuilds', () => ({
  useBuilds: jest.fn(),
}));

const mockUseMyPermissions = useMyPermissions as jest.Mock;
const mockUseBuilds = useBuilds as jest.Mock;

const LocationProbe: React.FC = () => {
  const location = useLocation();
  return <div {...{ 'data-testid': 'location' }}>{location.pathname}</div>;
};

function renderView(permissions: string[], isSuperAdmin = false) {
  mockUseMyPermissions.mockReturnValue({ can: (key: string) => permissions.includes(key), isLoading: false });
  mockUseBuilds.mockReturnValue({
    isLoading: false,
    isError: false,
    isSuccess: true,
    data: { builds: [], total: 0, limit: 50, offset: 0 },
    refetch: jest.fn(),
  });
  return render(
    <MemoryRouter initialEntries={['/builds']}>
      <Routes>
        <Route path="*" element={<><BuildsView project="Apex" isSuperAdmin={isSuperAdmin} /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('BuildsView (PBI-003)', () => {
  it('a builds:view holder sees the page without the New build button', () => {
    renderView(['builds:view']);
    expect(screen.getByTestId('builds-list-view')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Builds' })).toBeInTheDocument();
    expect(screen.getByTestId('builds-list-empty')).toHaveTextContent('No builds yet.');
    expect(screen.queryByTestId('builds-list-new-build')).not.toBeInTheDocument();
    expect(mockUseMyPermissions).toHaveBeenCalledWith('Apex');
  });

  it('a builds:run holder sees the button and it navigates to /builds/new', () => {
    renderView(['builds:view', 'builds:run']);
    fireEvent.click(screen.getByTestId('builds-list-new-build'));
    expect(screen.getByTestId('location')).toHaveTextContent('/builds/new');
  });

  it('a super admin sees the button', () => {
    renderView([], true);
    expect(screen.getByTestId('builds-list-new-build')).toBeInTheDocument();
  });
});
