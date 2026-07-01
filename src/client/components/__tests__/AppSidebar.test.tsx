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
  it('renders Home and collapse controls', () => {
    render(<AppSidebar {...baseProps} />);
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
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

  it('hides Feature Requests when project is not Apex', () => {
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
    expect(screen.queryByRole('button', { name: 'Feature Requests' })).not.toBeInTheDocument();
  });

  it('shows Admin when user has admin:roles permission', () => {
    const can = (key: string) => key === 'admin:roles';
    render(<AppSidebar {...baseProps} can={can} />);
    expect(screen.getByRole('button', { name: 'Admin' })).toBeInTheDocument();
  });
});

describe('AppSidebar — mobile', () => {
  it('renders nothing on mobile', () => {
    mockedUseBreakpoint.mockReturnValue({ isMobile: true, isTablet: false, isDesktop: false });
    const { container } = render(<AppSidebar {...baseProps} />);
    expect(container).toBeEmptyDOMElement();
  });
});
