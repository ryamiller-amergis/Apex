import { render, screen } from '@testing-library/react';
import { AppHeader } from '../AppHeader';

jest.mock('../../hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
}));

const baseProps = {
  currentView: 'home' as const,
  planningTab: 'dev-stats',
  theme: 'light' as const,
  user: { name: 'Test User', email: 'test.user@example.com' },
  hasUnreadChangelog: false,
  onNavigateHome: jest.fn(),
  onNavigateCalendar: jest.fn(),
  onNavigatePlanning: jest.fn(),
  onNavigateCloudCost: jest.fn(),
  onNavigateBacklog: jest.fn(),
  onNavigateAdmin: jest.fn(),
  onOpenChangelog: jest.fn(),
  onThemeChange: jest.fn(),
  onLogout: jest.fn(),
};

jest.mock('../UserMenu', () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

// ── No menu config, not super admin (default) ─────────────────────────────────

describe('AppHeader — no menuEnabledViews, not super admin', () => {
  const can = (_key: string) => false;

  it('renders the Home button (always visible)', () => {
    render(<AppHeader {...baseProps} can={can} />);
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
  });

  it('does NOT render Calendar (not in enabledViews)', () => {
    render(<AppHeader {...baseProps} can={can} />);
    expect(screen.queryByRole('button', { name: 'Calendar' })).not.toBeInTheDocument();
  });

  it('does NOT render Planning (not in enabledViews)', () => {
    render(<AppHeader {...baseProps} can={can} />);
    expect(screen.queryByRole('button', { name: 'Planning' })).not.toBeInTheDocument();
  });

  it('does NOT render Admin (no admin:roles permission)', () => {
    render(<AppHeader {...baseProps} can={can} />);
    expect(screen.queryByRole('button', { name: 'Admin' })).not.toBeInTheDocument();
  });
});

// ── With menuEnabledViews containing specific views ───────────────────────────

describe('AppHeader — menuEnabledViews=[planning]', () => {
  const can = (_key: string) => false;

  it('renders Planning when in enabledViews', () => {
    render(<AppHeader {...baseProps} can={can} menuEnabledViews={['planning']} />);
    expect(screen.getByRole('button', { name: 'Planning' })).toBeInTheDocument();
  });

  it('does NOT render Calendar (not in enabledViews)', () => {
    render(<AppHeader {...baseProps} can={can} menuEnabledViews={['planning']} />);
    expect(screen.queryByRole('button', { name: 'Calendar' })).not.toBeInTheDocument();
  });
});

// ── Super admin sees all feature views ─────────────────────────────────────────

describe('AppHeader — isSuperAdmin=true', () => {
  const can = (key: string) => key === 'admin:roles';

  it('renders all feature views for super admin', () => {
    render(<AppHeader {...baseProps} can={can} isSuperAdmin menuEnabledViews={[]} />);
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Calendar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Planning' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cloud Cost' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Interview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Admin' })).toBeInTheDocument();
  });
});

// ── All views enabled via menuEnabledViews + admin permission ─────────────────

describe('AppHeader — all views enabled', () => {
  const can = (key: string) => key === 'admin:roles';
  const allViews = ['calendar', 'planning', 'cloudcost', 'backlog'];

  it('renders Calendar', () => {
    render(<AppHeader {...baseProps} can={can} menuEnabledViews={allViews} />);
    expect(screen.getByRole('button', { name: 'Calendar' })).toBeInTheDocument();
  });

  it('renders Cloud Cost', () => {
    render(<AppHeader {...baseProps} can={can} menuEnabledViews={allViews} />);
    expect(screen.getByRole('button', { name: 'Cloud Cost' })).toBeInTheDocument();
  });

  it('renders Interview', () => {
    render(<AppHeader {...baseProps} can={can} menuEnabledViews={allViews} />);
    expect(screen.getByRole('button', { name: 'Interview' })).toBeInTheDocument();
  });

  it('renders Admin', () => {
    render(<AppHeader {...baseProps} can={can} menuEnabledViews={allViews} />);
    expect(screen.getByRole('button', { name: 'Admin' })).toBeInTheDocument();
  });
});
