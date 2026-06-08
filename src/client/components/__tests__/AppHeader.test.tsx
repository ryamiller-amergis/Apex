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

// ── Menu config present but no role permissions ───────────────────────────────

describe('AppHeader — menuEnabledViews=[planning], but no role permissions', () => {
  const can = (_key: string) => false;

  it('does NOT render Planning when in enabledViews but user lacks planning:view', () => {
    render(<AppHeader {...baseProps} can={can} menuEnabledViews={['planning']} />);
    expect(screen.queryByRole('button', { name: 'Planning' })).not.toBeInTheDocument();
  });
});

// ── Menu config + role permissions both required ──────────────────────────────

describe('AppHeader — menuEnabledViews=[planning] + planning:view permission', () => {
  const can = (key: string) => key === 'planning:view';

  it('renders Planning when both enabled in menu AND has planning:view permission', () => {
    render(<AppHeader {...baseProps} can={can} menuEnabledViews={['planning']} />);
    expect(screen.getByRole('button', { name: 'Planning' })).toBeInTheDocument();
  });

  it('does NOT render Calendar (not in enabledViews)', () => {
    render(<AppHeader {...baseProps} can={can} menuEnabledViews={['planning']} />);
    expect(screen.queryByRole('button', { name: 'Calendar' })).not.toBeInTheDocument();
  });
});

describe('AppHeader — menuEnabledViews=[calendar] + calendar:view permission', () => {
  const can = (key: string) => key === 'calendar:view';

  it('renders Calendar when both enabled in menu AND has calendar:view permission', () => {
    render(<AppHeader {...baseProps} can={can} menuEnabledViews={['calendar']} />);
    expect(screen.getByRole('button', { name: 'Calendar' })).toBeInTheDocument();
  });

  it('does NOT render Calendar when in enabledViews but lacks calendar:view permission', () => {
    render(<AppHeader {...baseProps} can={(_k) => false} menuEnabledViews={['calendar']} />);
    expect(screen.queryByRole('button', { name: 'Calendar' })).not.toBeInTheDocument();
  });
});

// ── Super admin sees all feature views ─────────────────────────────────────────

describe('AppHeader — isSuperAdmin=true', () => {
  const can = (key: string) => key === 'admin:roles';

  it('renders all feature views for super admin regardless of permissions or menu config', () => {
    render(<AppHeader {...baseProps} can={can} isSuperAdmin menuEnabledViews={[]} />);
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Calendar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Planning' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cloud Cost' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Interview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Admin' })).toBeInTheDocument();
  });
});

// ── All views enabled via menuEnabledViews + matching role permissions ─────────

describe('AppHeader — all views enabled with matching permissions', () => {
  const allViews = ['calendar', 'planning', 'cloudcost', 'backlog'];
  const can = (key: string) =>
    ['admin:roles', 'calendar:view', 'planning:view', 'cost:view', 'interviews:view'].includes(key);

  it('renders Calendar', () => {
    render(<AppHeader {...baseProps} can={can} menuEnabledViews={allViews} />);
    expect(screen.getByRole('button', { name: 'Calendar' })).toBeInTheDocument();
  });

  it('renders Planning', () => {
    render(<AppHeader {...baseProps} can={can} menuEnabledViews={allViews} />);
    expect(screen.getByRole('button', { name: 'Planning' })).toBeInTheDocument();
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

// ── Role lacks specific permissions even though menu is fully enabled ──────────

describe('AppHeader — menu fully enabled but role missing specific permissions', () => {
  const allViews = ['calendar', 'planning', 'cloudcost', 'backlog'];

  it('hides Cloud Cost when user lacks cost:view', () => {
    const can = (key: string) =>
      ['calendar:view', 'planning:view', 'interviews:view'].includes(key);
    render(<AppHeader {...baseProps} can={can} menuEnabledViews={allViews} />);
    expect(screen.queryByRole('button', { name: 'Cloud Cost' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Calendar' })).toBeInTheDocument();
  });

  it('hides Calendar when user lacks calendar:view', () => {
    const can = (key: string) =>
      ['planning:view', 'cost:view', 'interviews:view'].includes(key);
    render(<AppHeader {...baseProps} can={can} menuEnabledViews={allViews} />);
    expect(screen.queryByRole('button', { name: 'Calendar' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Planning' })).toBeInTheDocument();
  });
});
