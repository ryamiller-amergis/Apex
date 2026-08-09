import { render, screen, fireEvent } from '@testing-library/react';
import { AppSidebar } from '../AppSidebar';
import { useBreakpoint } from '../../hooks/useBreakpoint';

jest.mock('../../hooks/useBreakpoint', () => ({
  useBreakpoint: jest.fn(() => ({ isMobile: false, isTablet: false, isDesktop: true })),
}));

const mockedUseBreakpoint = useBreakpoint as jest.MockedFunction<typeof useBreakpoint>;

const baseProps = {
  currentView: 'home',
  collapsed: false,
  onToggleCollapsed: jest.fn(),
  can: (_key: string) => false,
  menuEnabledViews: [] as string[],
  isSuperAdmin: false,
  selectedProject: 'MyProject',
  onNavigateHome: jest.fn(),
  onNavigateCalendar: jest.fn(),
  onNavigatePlanning: jest.fn(),
  onNavigateCloudCost: jest.fn(),
  onNavigateBacklog: jest.fn(),
  onNavigateAdmin: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseBreakpoint.mockReturnValue({ isMobile: false, isTablet: false, isDesktop: true });
});

describe('AppSidebar — desktop navigation', () => {
  it('renders Home and collapse controls when canAccessHome is true (default)', () => {
    render(<AppSidebar {...baseProps} canAccessHome />);
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();
  });

  it('hides the Home button when canAccessHome is false', () => {
    render(<AppSidebar {...baseProps} canAccessHome={false} />);
    expect(screen.queryByRole('button', { name: 'Home' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();
  });

  it('calls onToggleCollapsed when collapse button is clicked', () => {
    render(<AppSidebar {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(baseProps.onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it('shows Planning when enabled in menu and user has permission', () => {
    const can = (key: string) => key === 'planning:view';
    render(
      <AppSidebar
        {...baseProps}
        can={can}
        menuEnabledViews={['planning']}
      />,
    );
    expect(screen.getByRole('button', { name: 'Planning' })).toBeInTheDocument();
  });

  it('shows Apex Backlog for another project when enabled and permitted', () => {
    const can = (key: string) => key === 'feature-requests:view';
    render(
      <AppSidebar
        {...baseProps}
        can={can}
        menuEnabledViews={['feature-requests']}
        selectedProject="OtherProject"
        onNavigateFeatureRequests={jest.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Apex Backlog' })).toBeInTheDocument();
  });

  it('hides Apex Backlog when Platform Admin menu visibility disables it', () => {
    const can = (key: string) => key === 'feature-requests:view';
    render(
      <AppSidebar
        {...baseProps}
        can={can}
        menuEnabledViews={[]}
        selectedProject="OtherProject"
        onNavigateFeatureRequests={jest.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Apex Backlog' })).not.toBeInTheDocument();
  });

  it('shows Admin when user has admin:roles permission', () => {
    const can = (key: string) => key === 'admin:roles';
    render(<AppSidebar {...baseProps} can={can} />);
    expect(screen.getByRole('button', { name: 'Admin' })).toBeInTheDocument();
  });

  it('shows UI Lab for a super admin regardless of menu/permission', () => {
    render(
      <AppSidebar
        {...baseProps}
        isSuperAdmin
        onNavigateUiLab={jest.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'UI Lab' })).toBeInTheDocument();
  });

  it('shows UI Lab when enabled in menu, user has ui-lab:view permission, and is in the UI/UX group', () => {
    const can = (key: string) => key === 'ui-lab:view';
    const onNavigateUiLab = jest.fn();
    render(
      <AppSidebar
        {...baseProps}
        can={can}
        menuEnabledViews={['ui-lab']}
        isInAnyGroup={(groups) => groups.includes('UI/UX')}
        onNavigateUiLab={onNavigateUiLab}
      />,
    );
    const uiLab = screen.getByRole('button', { name: 'UI Lab' });
    expect(uiLab).toBeInTheDocument();
    fireEvent.click(uiLab);
    expect(onNavigateUiLab).toHaveBeenCalledTimes(1);
  });

  it('hides UI Lab when the user is not in the UI/UX group even with permission and menu-enable', () => {
    const can = (key: string) => key === 'ui-lab:view';
    render(
      <AppSidebar
        {...baseProps}
        can={can}
        menuEnabledViews={['ui-lab']}
        isInAnyGroup={() => false}
        onNavigateUiLab={jest.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'UI Lab' })).not.toBeInTheDocument();
  });

  it('hides UI Lab when ui-lab is not in menuEnabledViews', () => {
    const can = (key: string) => key === 'ui-lab:view';
    render(
      <AppSidebar
        {...baseProps}
        can={can}
        menuEnabledViews={[]}
        isInAnyGroup={() => true}
        onNavigateUiLab={jest.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'UI Lab' })).not.toBeInTheDocument();
  });

  it('hides UI Lab when user lacks ui-lab:view permission', () => {
    const can = (_key: string) => false;
    render(
      <AppSidebar
        {...baseProps}
        can={can}
        menuEnabledViews={['ui-lab']}
        isInAnyGroup={() => true}
        onNavigateUiLab={jest.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'UI Lab' })).not.toBeInTheDocument();
  });
});

describe('AppSidebar — grouped sections', () => {
  const allViews = [
    'calendar', 'planning', 'cloudcost', 'backlog', 'adr',
    'my-work', 'standup', 'ui-lab', 'feature-requests',
    'pdf-tools', 'ai-cost', 'design-module', 'load-tests', 'diagrams',
  ];
  const superAdminProps = {
    ...baseProps,
    isSuperAdmin: true,
    selectedProject: 'Apex',
    menuEnabledViews: allViews,
    onNavigateMyWork: jest.fn(),
    onNavigateStandup: jest.fn(),
    onNavigateUiLab: jest.fn(),
    onNavigateFeatureRequests: jest.fn(),
    onNavigatePdfTools: jest.fn(),
    onNavigateAiCost: jest.fn(),
    onNavigateDesignModule: jest.fn(),
    onNavigateLoadTests: jest.fn(),
    onNavigateDiagrams: jest.fn(),
    onNavigateAdr: jest.fn(),
  };

  it('shows section labels when expanded and items are visible', () => {
    render(<AppSidebar {...superAdminProps} collapsed={false} />);
    expect(screen.getByText('Build')).toBeInTheDocument();
    expect(screen.getByText('Delivery')).toBeInTheDocument();
    expect(screen.getByText('Insights')).toBeInTheDocument();
    expect(screen.getByText('Tools')).toBeInTheDocument();
  });

  it('hides section labels when collapsed', () => {
    render(<AppSidebar {...superAdminProps} collapsed />);
    expect(screen.queryByText('Build')).not.toBeInTheDocument();
    expect(screen.queryByText('Delivery')).not.toBeInTheDocument();
    expect(screen.queryByText('Insights')).not.toBeInTheDocument();
    expect(screen.queryByText('Tools')).not.toBeInTheDocument();
  });

  it('does not render a group label when all items in the group are hidden', () => {
    const can = (key: string) => key === 'planning:view';
    render(
      <AppSidebar
        {...baseProps}
        can={can}
        menuEnabledViews={['planning']}
      />,
    );
    expect(screen.getByText('Insights')).toBeInTheDocument();
    expect(screen.queryByText('Build')).not.toBeInTheDocument();
    expect(screen.queryByText('Delivery')).not.toBeInTheDocument();
    expect(screen.queryByText('Tools')).not.toBeInTheDocument();
  });
});

describe('AppSidebar — mobile', () => {
  it('renders nothing on mobile', () => {
    mockedUseBreakpoint.mockReturnValue({ isMobile: true, isTablet: false, isDesktop: false });
    const { container } = render(<AppSidebar {...baseProps} />);
    expect(container).toBeEmptyDOMElement();
  });
});
