import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { BuildAgentHomePill } from '../BuildAgentHomePill';
import { useFeatureFlag } from '../../hooks/useFeatureFlags';
import { useProjectMenuConfig } from '../../hooks/useProjectMenuConfig';
import { useAppShell } from '../../hooks/useAppShell';
import { useActiveBuildCount } from '../../hooks/useBuilds';

jest.mock('../../hooks/useFeatureFlags', () => ({ useFeatureFlag: jest.fn() }));
jest.mock('../../hooks/useProjectMenuConfig', () => ({ useProjectMenuConfig: jest.fn() }));
jest.mock('../../hooks/useAppShell', () => ({ useAppShell: jest.fn() }));
jest.mock('../../hooks/useBuilds', () => ({ useActiveBuildCount: jest.fn() }));

const flag = useFeatureFlag as jest.Mock;
const menu = useProjectMenuConfig as jest.Mock;
const shell = useAppShell as jest.Mock;
const count = useActiveBuildCount as jest.Mock;

function renderPill() {
  const Probe = () => {
    const location = useLocation();
    return <div {...{ 'data-testid': 'location' }}>{location.pathname}</div>;
  };
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="*" element={<><BuildAgentHomePill project="Apex" /><Probe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('BuildAgentHomePill (VT-22, VT-23, VT-24, VT-25)', () => {
  beforeEach(() => {
    flag.mockReturnValue(true);
    menu.mockReturnValue({ enabledViews: ['builds'] });
    shell.mockReturnValue({ can: (key: string) => key === 'builds:run', isSuperAdmin: false });
    count.mockReturnValue({ data: { total: 2 }, isError: false });
  });

  it('VT-22 is hidden when the flag, the menu, or permission is off', () => {
    flag.mockReturnValue(false);
    const { rerender } = renderPill();
    expect(screen.queryByTestId('agent-home-build-pill')).not.toBeInTheDocument();

    flag.mockReturnValue(true);
    menu.mockReturnValue({ enabledViews: [] });
    rerender(
      <MemoryRouter>
        <BuildAgentHomePill project="Apex" />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('agent-home-build-pill')).not.toBeInTheDocument();
  });

  it('VT-23 shows the pill for a super admin and navigates to the form', () => {
    shell.mockReturnValue({ can: () => false, isSuperAdmin: true });
    renderPill();
    fireEvent.click(screen.getByTestId('agent-home-build-pill'));
    expect(screen.getByTestId('location')).toHaveTextContent('/builds/new');
  });

  it('VT-24 shows the running count and VT-25 hides the badge when the count fails', () => {
    renderPill();
    expect(screen.getByTestId('agent-home-build-pill-badge')).toHaveTextContent('2 builds running');
    cleanup();
    count.mockReturnValue({ data: undefined, isError: true });
    renderPill();
    expect(screen.getByTestId('agent-home-build-pill')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-home-build-pill-badge')).not.toBeInTheDocument();
  });
});
