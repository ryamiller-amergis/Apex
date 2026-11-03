import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { BrainstormHomeEntry } from '../BrainstormHomeEntry';
import { useFeatureFlag } from '../../hooks/useFeatureFlags';
import { useProjectMenuConfig } from '../../hooks/useProjectMenuConfig';
import { useAppShell } from '../../hooks/useAppShell';
import { useCreateBrainstormSession } from '../../hooks/useBrainstormSessions';

jest.mock('../../hooks/useFeatureFlags', () => ({ useFeatureFlag: jest.fn() }));
jest.mock('../../hooks/useProjectMenuConfig', () => ({ useProjectMenuConfig: jest.fn() }));
jest.mock('../../hooks/useAppShell', () => ({ useAppShell: jest.fn() }));
jest.mock('../../hooks/useBrainstormSessions', () => ({ useCreateBrainstormSession: jest.fn() }));

const flag = useFeatureFlag as jest.Mock;
const menu = useProjectMenuConfig as jest.Mock;
const shell = useAppShell as jest.Mock;
const create = useCreateBrainstormSession as jest.Mock;

const Probe = () => {
  const location = useLocation();
  return <div {...{ 'data-testid': 'location' }}>{location.pathname}</div>;
};

function renderEntry() {
  return render(
    <MemoryRouter initialEntries={['/home']}>
      <Routes>
        <Route path="*" element={<><BrainstormHomeEntry project="Apex" /><Probe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

function mutation(overrides: Record<string, unknown> = {}) {
  return { mutate: jest.fn(), isPending: false, isError: false, ...overrides };
}

describe('BrainstormHomeEntry (VT-11)', () => {
  beforeEach(() => {
    flag.mockReturnValue(true);
    menu.mockReturnValue({ enabledViews: ['brainstorm'] });
    shell.mockReturnValue({
      can: (key: string) => key === 'brainstorm:view' || key === 'brainstorm:create',
      isSuperAdmin: false,
    });
    create.mockReturnValue(mutation());
  });

  it('PBI-001 (a): shows the card with the flag on and opens the new session after create', () => {
    const mutate = jest.fn((_vars: unknown, options: { onSuccess: (session: { id: string }) => void }) => {
      options.onSuccess({ id: 'session-1' });
    });
    create.mockReturnValue(mutation({ mutate }));
    renderEntry();

    expect(screen.getByTestId('brainstorm-home-entry')).toHaveTextContent('Explore an idea in open chat');
    fireEvent.click(screen.getByTestId('brainstorm-start-session'));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('location')).toHaveTextContent('/brainstorm/session-1');
  });

  it('PBI-001 (b): renders nothing when the flag, the menu, or the permission is off', () => {
    flag.mockReturnValue(false);
    const { unmount } = renderEntry();
    expect(screen.queryByTestId('brainstorm-home-entry')).not.toBeInTheDocument();
    unmount();

    flag.mockReturnValue(true);
    menu.mockReturnValue({ enabledViews: [] });
    const second = renderEntry();
    expect(screen.queryByTestId('brainstorm-home-entry')).not.toBeInTheDocument();
    second.unmount();

    menu.mockReturnValue({ enabledViews: ['brainstorm'] });
    shell.mockReturnValue({ can: (key: string) => key === 'brainstorm:view', isSuperAdmin: false });
    renderEntry();
    expect(screen.queryByTestId('brainstorm-home-entry')).not.toBeInTheDocument();
  });

  it('PBI-001 (d): shows an inline error, stays on /home, and Try again creates again', () => {
    const mutate = jest.fn();
    create.mockReturnValue(mutation({ mutate, isError: true }));
    renderEntry();

    expect(screen.getByTestId('brainstorm-start-error')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('location')).toHaveTextContent('/home');
    fireEvent.click(screen.getByTestId('brainstorm-start-retry'));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('opens the Brainstorm page from Open Brainstorm', () => {
    renderEntry();
    fireEvent.click(screen.getByTestId('brainstorm-view-sessions'));
    expect(screen.getByTestId('location')).toHaveTextContent('/brainstorm');
  });
});
