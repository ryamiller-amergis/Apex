import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppHeader } from '../AppHeader';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => children,
}));

jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('../../hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isMobile: true, isTablet: false, isDesktop: false }),
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

jest.mock('../FeatureRequestFab', () => ({
  FeatureRequestFab: () => null,
}));

// ── No menu config, not super admin (default) ─────────────────────────────────

describe('AppHeader — no menuEnabledViews, not super admin', () => {
  const can = (_key: string) => false;

  it('renders the project name with a middle-dot separator in the brand', () => {
    render(<AppHeader {...baseProps} can={can} selectedProject="MaxView" canAccessHome />);
    expect(screen.getByText('Apex')).toBeInTheDocument();
    expect(screen.getByText('MaxView')).toBeInTheDocument();
    expect(screen.getByText('·')).toBeInTheDocument();
  });

  it('hides the Home button when canAccessHome is false', () => {
    render(<AppHeader {...baseProps} can={can} canAccessHome={false} />);
    expect(screen.queryByRole('button', { name: 'Home' })).not.toBeInTheDocument();
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

describe('AppHeader — Apex Backlog project menu visibility', () => {
  const can = (key: string) => key === 'feature-requests:view';

  it('renders Apex Backlog in a non-Apex project when enabled and permitted', () => {
    render(
      <AppHeader
        {...baseProps}
        can={can}
        selectedProject="Amego"
        menuEnabledViews={['feature-requests']}
      />,
    );
    expect(screen.getByRole('button', { name: 'Apex Backlog' })).toBeInTheDocument();
  });

  it('hides Apex Backlog when menu visibility disables it', () => {
    render(
      <AppHeader
        {...baseProps}
        can={can}
        selectedProject="Amego"
        menuEnabledViews={[]}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Apex Backlog' })).not.toBeInTheDocument();
  });
});

// ── UI Lab now follows the standard admin-gated pattern ───────────────────────

describe('AppHeader — UI Lab admin-gated behavior', () => {
  const inUiUxGroup = (groups: string[]) => groups.includes('UI/UX');

  it('does NOT render UI Lab when user has ui-lab:view but it is not in enabledViews', () => {
    const can = (key: string) => key === 'ui-lab:view';
    render(<AppHeader {...baseProps} can={can} menuEnabledViews={[]} isInAnyGroup={inUiUxGroup} />);
    expect(screen.queryByRole('button', { name: 'UI Lab' })).not.toBeInTheDocument();
  });

  it('renders UI Lab when enabled in menu, has ui-lab:view permission, AND is in the UI/UX group', () => {
    const can = (key: string) => key === 'ui-lab:view';
    render(<AppHeader {...baseProps} can={can} menuEnabledViews={['ui-lab']} isInAnyGroup={inUiUxGroup} />);
    expect(screen.getByRole('button', { name: 'UI Lab' })).toBeInTheDocument();
  });

  it('does NOT render UI Lab when the user is not in the UI/UX group even with permission and menu-enable', () => {
    const can = (key: string) => key === 'ui-lab:view';
    render(<AppHeader {...baseProps} can={can} menuEnabledViews={['ui-lab']} isInAnyGroup={() => false} />);
    expect(screen.queryByRole('button', { name: 'UI Lab' })).not.toBeInTheDocument();
  });

  it('does NOT render UI Lab when in enabledViews but lacks ui-lab:view permission', () => {
    render(<AppHeader {...baseProps} can={(_k) => false} menuEnabledViews={['ui-lab']} isInAnyGroup={inUiUxGroup} />);
    expect(screen.queryByRole('button', { name: 'UI Lab' })).not.toBeInTheDocument();
  });

  it('renders UI Lab for a super admin even when not in enabledViews or the UI/UX group', () => {
    render(<AppHeader {...baseProps} can={(_k) => false} isSuperAdmin menuEnabledViews={[]} isInAnyGroup={() => false} />);
    expect(screen.getByRole('button', { name: 'UI Lab' })).toBeInTheDocument();
  });

  it('renders UI Lab outside the UI/UX group when designs have been shared with the user', () => {
    const can = (key: string) => key === 'ui-lab:view';
    render(
      <AppHeader
        {...baseProps}
        can={can}
        menuEnabledViews={['ui-lab']}
        isInAnyGroup={() => false}
        hasUiLabShares
      />,
    );
    expect(screen.getByRole('button', { name: 'UI Lab' })).toBeInTheDocument();
  });

  it('does NOT render UI Lab for a share holder when ui-lab is off for the project', () => {
    const can = (key: string) => key === 'ui-lab:view';
    render(
      <AppHeader
        {...baseProps}
        can={can}
        menuEnabledViews={[]}
        isInAnyGroup={() => false}
        hasUiLabShares
      />,
    );
    expect(screen.queryByRole('button', { name: 'UI Lab' })).not.toBeInTheDocument();
  });
});

// ── Work Board: super admin always; otherwise menu-enabled + work-board:view ──

describe('AppHeader — Work Board visibility', () => {
  const can = (_key: string) => false;

  it('renders Work Board for a super admin on the Apex project', () => {
    render(<AppHeader {...baseProps} can={can} isSuperAdmin selectedProject="Apex" />);
    expect(screen.getByRole('button', { name: 'Work Board' })).toBeInTheDocument();
  });

  it('does NOT render Work Board for a non-super-admin without the view enabled', () => {
    render(<AppHeader {...baseProps} can={can} selectedProject="Apex" menuEnabledViews={[]} />);
    expect(screen.queryByRole('button', { name: 'Work Board' })).not.toBeInTheDocument();
  });

  it('renders Work Board for a super admin on a non-Apex project', () => {
    render(<AppHeader {...baseProps} can={can} isSuperAdmin selectedProject="MaxView" />);
    expect(screen.getByRole('button', { name: 'Work Board' })).toBeInTheDocument();
  });

  it('renders Work Board for a non-super-admin when menu-enabled and permitted', () => {
    const canWorkBoard = (key: string) => key === 'work-board:view';
    render(
      <AppHeader
        {...baseProps}
        can={canWorkBoard}
        selectedProject="MaxView"
        menuEnabledViews={['work-board']}
      />,
    );
    expect(screen.getByRole('button', { name: 'Work Board' })).toBeInTheDocument();
  });

  it('navigates to the work board when the Work Board item is clicked', () => {
    const onNavigateWorkBoard = jest.fn();
    render(
      <AppHeader
        {...baseProps}
        can={can}
        isSuperAdmin
        selectedProject="Apex"
        onNavigateWorkBoard={onNavigateWorkBoard}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Work Board' }));
    expect(onNavigateWorkBoard).toHaveBeenCalled();
  });

  it('hides Work Board for a super admin when the feature flag is off', () => {
    render(
      <AppHeader
        {...baseProps}
        can={can}
        isSuperAdmin
        selectedProject="Apex"
        workBoardEnabled={false}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Work Board' })).not.toBeInTheDocument();
  });
});

// ── Super admin sees all feature views ─────────────────────────────────────────

describe('AppHeader — isSuperAdmin=true', () => {
  const can = (key: string) => key === 'admin:roles';

  it('renders all feature views for super admin regardless of permissions or menu config', () => {
    render(<AppHeader {...baseProps} can={can} isSuperAdmin menuEnabledViews={[]} canAccessHome />);
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
