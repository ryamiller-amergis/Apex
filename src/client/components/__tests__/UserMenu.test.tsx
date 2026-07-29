/**
 * FEAT-005 / TBI-008 / PBI-008 — Simplified Avatar Menu.
 * Criterion ids (AC, DoD, VT) in names for Requirements → Test Matrix traceability.
 */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from 'react-error-boundary';
import { MemoryRouter } from 'react-router-dom';
import type { ThemeMode } from '../../config/themes';
import type { CurrentProfileResponse } from '../../../shared/types/profile';
import { UserMenu } from '../UserMenu';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('../SharedAvatar', () => ({
  SharedAvatar: ({
    oid,
    displayName,
    avatarVersion,
    decorative,
  }: {
    oid: string;
    displayName: string;
    avatarVersion?: string | null;
    decorative?: boolean;
  }) => (
    <span
      data-testid="shared-avatar-mock"
      data-oid={oid}
      data-display-name={displayName}
      data-avatar-version={avatarVersion ?? ''}
      data-decorative={decorative ? 'true' : 'false'}
    />
  ),
}));

let profileQuery: {
  data: CurrentProfileResponse | undefined;
  isLoading: boolean;
  isError: boolean;
};

jest.mock('../../hooks/useProfile', () => ({
  useCurrentProfile: () => profileQuery,
}));

const baseProfile: CurrentProfileResponse = {
  userOid: 'oid-a',
  displayName: 'Ada Lovelace',
  email: 'ada@example.com',
  bio: null,
  avatar: { userOid: 'oid-a', version: 'v1' },
  updatedAt: null,
};

const defaultProps: {
  onOpenChangelog: jest.Mock;
  onThemeChange: jest.Mock;
  onLogout: jest.Mock;
  theme: ThemeMode;
  user: { name: string; email?: string };
  hasUnreadChangelog: boolean;
} = {
  onOpenChangelog: jest.fn(),
  onThemeChange: jest.fn(),
  onLogout: jest.fn(),
  theme: 'amergis',
  user: { name: 'Ada Lovelace', email: 'ada@example.com' },
  hasUnreadChangelog: false,
};

function renderMenu(overrides: Partial<typeof defaultProps> = {}) {
  const props = {
    ...defaultProps,
    ...overrides,
    onOpenChangelog: overrides.onOpenChangelog ?? jest.fn(),
    onThemeChange: overrides.onThemeChange ?? jest.fn(),
    onLogout: overrides.onLogout ?? jest.fn(),
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <UserMenu {...props} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...result, props };
}

function openMenu() {
  fireEvent.click(screen.getByTestId('user-menu-trigger'));
}

beforeEach(() => {
  jest.clearAllMocks();
  profileQuery = {
    data: baseProfile,
    isLoading: false,
    isError: false,
  };
});

describe('UserMenu — TBI-008 DoD-0 / PBI-008 AC-0 / VT-01', () => {
  it('opens with What\'s New, Profile, and separated Sign Out in order', () => {
    renderMenu();
    openMenu();

    const menu = screen.getByTestId('user-menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAttribute('data-testid', 'user-menu-whats-new');
    expect(items[1]).toHaveAttribute('data-testid', 'user-menu-profile');
    expect(items[2]).toHaveAttribute('data-testid', 'user-menu-sign-out');
    expect(items[0]).toHaveTextContent("What's New");
    expect(items[1]).toHaveTextContent('Profile');
    expect(items[2]).toHaveTextContent('Sign Out');

    const separator = screen.getByTestId('user-menu-sign-out-separator');
    expect(separator).toBeInTheDocument();
    const signOut = screen.getByTestId('user-menu-sign-out');
    expect(
      separator.compareDocumentPosition(signOut) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});

describe('UserMenu — TBI-008 DoD-3 / PBI-008 AC-2 / VT-02', () => {
  it('sets aria-expanded and focuses What\'s New on open', () => {
    renderMenu();
    const trigger = screen.getByTestId('user-menu-trigger');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');

    openMenu();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('user-menu-whats-new')).toHaveFocus();
  });
});

describe('UserMenu — TBI-008 NFR / PBI-008 AC-2 / VT-03', () => {
  it('moves focus with Arrow/Home/End, traps Tab, and restores focus on Escape', () => {
    renderMenu();
    const trigger = screen.getByTestId('user-menu-trigger');
    openMenu();

    const whatsNew = screen.getByTestId('user-menu-whats-new');
    const profile = screen.getByTestId('user-menu-profile');
    const signOut = screen.getByTestId('user-menu-sign-out');
    const menu = screen.getByTestId('user-menu');

    expect(whatsNew).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(profile).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(signOut).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(whatsNew).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(signOut).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'Home' });
    expect(whatsNew).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'End' });
    expect(signOut).toHaveFocus();

    fireEvent.keyDown(signOut, { key: 'Tab' });
    expect(whatsNew).toHaveFocus();

    fireEvent.keyDown(whatsNew, { key: 'Tab', shiftKey: true });
    expect(signOut).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByTestId('user-menu')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });
});

describe('UserMenu — TBI-008 DoD-2 / PBI-008 AC-0 / VT-04', () => {
  it('closes and navigates to /profile exactly once', () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByTestId('user-menu-profile'));

    expect(screen.queryByTestId('user-menu')).not.toBeInTheDocument();
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/profile');
  });
});

describe('UserMenu — TBI-008 DoD-2 / PBI-008 AC-0 / VT-06', () => {
  it('invokes onOpenChangelog once and closes for What\'s New', () => {
    const onOpenChangelog = jest.fn();
    const onLogout = jest.fn();
    renderMenu({ onOpenChangelog, onLogout });
    openMenu();
    fireEvent.click(screen.getByTestId('user-menu-whats-new'));

    expect(onOpenChangelog).toHaveBeenCalledTimes(1);
    expect(onLogout).not.toHaveBeenCalled();
    expect(screen.queryByTestId('user-menu')).not.toBeInTheDocument();
  });

  it('invokes onLogout once and closes for Sign Out', () => {
    const onOpenChangelog = jest.fn();
    const onLogout = jest.fn();
    renderMenu({ onOpenChangelog, onLogout });
    openMenu();
    fireEvent.click(screen.getByTestId('user-menu-sign-out'));

    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(onOpenChangelog).not.toHaveBeenCalled();
    expect(screen.queryByTestId('user-menu')).not.toBeInTheDocument();
  });
});

describe('UserMenu — TBI-008 DoD-1 / PBI-008 AC-3 / BR-010 / VT-07', () => {
  it('does not render Theme or Notification Preferences controls', () => {
    renderMenu({ theme: 'light', hasUnreadChangelog: true });
    openMenu();

    const menu = screen.getByTestId('user-menu');
    expect(within(menu).queryByRole('radiogroup', { name: /theme/i })).not.toBeInTheDocument();
    expect(within(menu).queryByText(/notification settings/i)).not.toBeInTheDocument();
    expect(within(menu).queryByText(/^theme$/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('notification-preferences')).not.toBeInTheDocument();
  });
});

describe('UserMenu — TBI-008 / PBI-008 AC-0 / VT-08', () => {
  it('passes current-user and unread overlay inputs to Shared Avatar trigger', () => {
    renderMenu({ hasUnreadChangelog: true });

    const avatar = screen.getByTestId('shared-avatar-mock');
    expect(avatar).toHaveAttribute('data-oid', 'oid-a');
    expect(avatar).toHaveAttribute('data-display-name', 'Ada Lovelace');
    expect(avatar).toHaveAttribute('data-avatar-version', 'v1');
    expect(avatar).toHaveAttribute('data-decorative', 'true');

    const trigger = screen.getByTestId('user-menu-trigger');
    expect(within(trigger).getByTestId('user-menu-unread-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('user-menu')).not.toBeInTheDocument();
  });

  it('hides unread badge when changelog is read', () => {
    renderMenu({ hasUnreadChangelog: false });
    expect(screen.queryByTestId('user-menu-unread-badge')).not.toBeInTheDocument();
  });
});

describe('UserMenu — PBI-008 AC-1 / VT-05', () => {
  it('keeps What\'s New and Sign Out usable after Profile navigation into a failing route boundary', () => {
    const onOpenChangelog = jest.fn();
    const onLogout = jest.fn();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    function ThrowingProfile(): React.ReactElement {
      throw new Error('profile render failed');
    }

    function Shell() {
      const [showThrowing, setShowThrowing] = React.useState(false);
      mockNavigate.mockImplementation((path: string) => {
        if (path === '/profile') setShowThrowing(true);
      });
      return (
        <div>
          <UserMenu
            {...defaultProps}
            onOpenChangelog={onOpenChangelog}
            onLogout={onLogout}
          />
          <ErrorBoundary
            fallback={<div data-testid="profile-error-recovery">Something went wrong</div>}
          >
            {showThrowing ? <ThrowingProfile /> : <div data-testid="safe-outlet">ok</div>}
          </ErrorBoundary>
        </div>
      );
    }

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Shell />
        </MemoryRouter>
      </QueryClientProvider>
    );

    openMenu();
    fireEvent.click(screen.getByTestId('user-menu-profile'));

    expect(screen.queryByTestId('user-menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('profile-error-recovery')).toBeInTheDocument();

    openMenu();
    fireEvent.click(screen.getByTestId('user-menu-whats-new'));
    expect(onOpenChangelog).toHaveBeenCalledTimes(1);

    openMenu();
    fireEvent.click(screen.getByTestId('user-menu-sign-out'));
    expect(onLogout).toHaveBeenCalledTimes(1);

    consoleSpy.mockRestore();
  });
});

describe('UserMenu — outside click dismissal', () => {
  it('closes on outside mousedown without requiring focus restoration', () => {
    renderMenu();
    openMenu();
    expect(screen.getByTestId('user-menu')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('user-menu')).not.toBeInTheDocument();
  });
});
