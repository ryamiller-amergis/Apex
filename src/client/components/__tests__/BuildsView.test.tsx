import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { BuildsView } from '../BuildsView';
import { useMyPermissions } from '../../hooks/useRbac';

jest.mock('../../hooks/useRbac', () => ({
  useMyPermissions: jest.fn(),
}));

const mockUseMyPermissions = useMyPermissions as jest.Mock;

const LocationProbe: React.FC = () => {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
};

function renderView(permissions: string[], isSuperAdmin = false) {
  mockUseMyPermissions.mockReturnValue({ can: (key: string) => permissions.includes(key), isLoading: false });
  return render(
    <MemoryRouter initialEntries={['/builds']}>
      <Routes>
        <Route path="*" element={<><BuildsView project="Apex" isSuperAdmin={isSuperAdmin} /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('BuildsView (VT-08)', () => {
  it('PBI-003 AC-2 a builds:view holder sees the page without the New build button', () => {
    renderView(['builds:view']);
    expect(screen.getByTestId('builds-view')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Builds' })).toBeInTheDocument();
    expect(screen.getByTestId('builds-empty-state')).toHaveTextContent('No builds yet.');
    expect(screen.queryByTestId('builds-new-build-btn')).not.toBeInTheDocument();
    expect(mockUseMyPermissions).toHaveBeenCalledWith('Apex');
  });

  it('a builds:run holder sees the button and it navigates to /builds/new', () => {
    renderView(['builds:view', 'builds:run']);
    fireEvent.click(screen.getByTestId('builds-new-build-btn'));
    expect(screen.getByTestId('location')).toHaveTextContent('/builds/new');
  });

  it('a super admin sees the button', () => {
    renderView([], true);
    expect(screen.getByTestId('builds-new-build-btn')).toBeInTheDocument();
  });
});
