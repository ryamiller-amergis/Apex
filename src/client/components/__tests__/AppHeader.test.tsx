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

// ── Viewer-like permissions (planning:view only) ───────────────────────────────

describe('AppHeader — viewer permissions (planning:view only)', () => {
  const can = (key: string) => key === 'planning:view';

  it('renders the Home button (always visible)', () => {
    render(<AppHeader {...baseProps} can={can} />);
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
  });

  it('does NOT render the Calendar button', () => {
    render(<AppHeader {...baseProps} can={can} />);
    expect(screen.queryByRole('button', { name: 'Calendar' })).not.toBeInTheDocument();
  });

  it('DOES render the Planning button', () => {
    render(<AppHeader {...baseProps} can={can} />);
    expect(screen.getByRole('button', { name: 'Planning' })).toBeInTheDocument();
  });

  it('does NOT render the Cloud Cost button', () => {
    render(<AppHeader {...baseProps} can={can} />);
    expect(screen.queryByRole('button', { name: 'Cloud Cost' })).not.toBeInTheDocument();
  });

  it('does NOT render the Interviews button', () => {
    render(<AppHeader {...baseProps} can={can} />);
    expect(screen.queryByRole('button', { name: 'Interview' })).not.toBeInTheDocument();
  });

  it('does NOT render the Admin button', () => {
    render(<AppHeader {...baseProps} can={can} />);
    expect(screen.queryByRole('button', { name: 'Admin' })).not.toBeInTheDocument();
  });
});

// ── Full permissions (all keys return true) ───────────────────────────────────

describe('AppHeader — full permissions (all keys)', () => {
  const can = (_key: string) => true;

  it('renders the Home button', () => {
    render(<AppHeader {...baseProps} can={can} />);
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
  });

  it('renders the Calendar button', () => {
    render(<AppHeader {...baseProps} can={can} />);
    expect(screen.getByRole('button', { name: 'Calendar' })).toBeInTheDocument();
  });

  it('renders the Planning button', () => {
    render(<AppHeader {...baseProps} can={can} />);
    expect(screen.getByRole('button', { name: 'Planning' })).toBeInTheDocument();
  });

  it('renders the Cloud Cost button', () => {
    render(<AppHeader {...baseProps} can={can} />);
    expect(screen.getByRole('button', { name: 'Cloud Cost' })).toBeInTheDocument();
  });

  it('renders the Interviews button', () => {
    render(<AppHeader {...baseProps} can={can} />);
    expect(screen.getByRole('button', { name: 'Interview' })).toBeInTheDocument();
  });

  it('renders the Admin button', () => {
    render(<AppHeader {...baseProps} can={can} />);
    expect(screen.getByRole('button', { name: 'Admin' })).toBeInTheDocument();
  });
});
