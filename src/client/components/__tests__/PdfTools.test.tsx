import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MobileGuidanceMessage } from '../MobileGuidanceMessage';
import { DesktopOnlyGate } from '../DesktopOnlyGate';
import { PdfToolsRouteGuard } from '../PdfToolsRouteGuard';
import { AppSidebar } from '../AppSidebar';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useMyPermissions } from '../../hooks/useRbac';
import { useProjectMenuConfig } from '../../hooks/useProjectMenuConfig';

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('../../hooks/useBreakpoint', () => ({
  useBreakpoint: jest.fn(() => ({ isMobile: false, isTablet: false, isDesktop: true })),
}));

jest.mock('../../hooks/useRbac', () => ({
  useMyPermissions: jest.fn(() => ({
    can: (_key: string) => false,
    isLoading: false,
    permissions: [],
    roles: [],
    isAdmin: false,
  })),
}));

jest.mock('../../hooks/useProjectMenuConfig', () => ({
  useProjectMenuConfig: jest.fn(() => ({
    enabledViews: [],
    isLoading: false,
  })),
}));

const mockedUseBreakpoint = useBreakpoint as jest.MockedFunction<typeof useBreakpoint>;
const mockedUseMyPermissions = useMyPermissions as jest.MockedFunction<typeof useMyPermissions>;
const mockedUseProjectMenuConfig = useProjectMenuConfig as jest.MockedFunction<typeof useProjectMenuConfig>;

function renderInRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

// ── MobileGuidanceMessage ──────────────────────────────────────────────────

describe('MobileGuidanceMessage', () => {
  it('renders the guidance text', () => {
    render(<MobileGuidanceMessage />);
    expect(screen.getByTestId('pdf-tools-mobile-guidance')).toBeInTheDocument();
    expect(
      screen.getByText(/PDF Assembly Tool is available on desktop browsers/i),
    ).toBeInTheDocument();
  });

  it('does not render any workspace content', () => {
    render(<MobileGuidanceMessage />);
    expect(screen.queryByTestId('pdf-assembly-view')).not.toBeInTheDocument();
  });

  it('renders accessible heading text', () => {
    render(<MobileGuidanceMessage />);
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });
});

// ── DesktopOnlyGate ────────────────────────────────────────────────────────

describe('DesktopOnlyGate', () => {
  beforeEach(() => {
    mockedUseBreakpoint.mockReturnValue({ isMobile: false, isTablet: false, isDesktop: true });
  });

  it('renders children when viewport is at desktop breakpoint', () => {
    renderInRouter(
      <DesktopOnlyGate>
        <div data-testid="workspace-content">Workspace</div>
      </DesktopOnlyGate>,
    );
    expect(screen.getByTestId('pdf-tools-desktop-gate')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-content')).toBeInTheDocument();
    expect(screen.queryByTestId('pdf-tools-mobile-guidance')).not.toBeInTheDocument();
  });

  it('renders MobileGuidanceMessage when viewport is mobile', () => {
    mockedUseBreakpoint.mockReturnValue({ isMobile: true, isTablet: false, isDesktop: false });
    renderInRouter(
      <DesktopOnlyGate>
        <div data-testid="workspace-content">Workspace</div>
      </DesktopOnlyGate>,
    );
    expect(screen.getByTestId('pdf-tools-mobile-guidance')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pdf-tools-desktop-gate')).not.toBeInTheDocument();
  });

  it('renders MobileGuidanceMessage when viewport is tablet (non-desktop)', () => {
    mockedUseBreakpoint.mockReturnValue({ isMobile: false, isTablet: true, isDesktop: false });
    renderInRouter(
      <DesktopOnlyGate>
        <div data-testid="workspace-content">Workspace</div>
      </DesktopOnlyGate>,
    );
    expect(screen.getByTestId('pdf-tools-mobile-guidance')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-content')).not.toBeInTheDocument();
  });

  it('swaps from workspace to guidance when breakpoint changes to non-desktop', () => {
    const { rerender } = renderInRouter(
      <DesktopOnlyGate>
        <div data-testid="workspace-content">Workspace</div>
      </DesktopOnlyGate>,
    );
    expect(screen.getByTestId('workspace-content')).toBeInTheDocument();

    mockedUseBreakpoint.mockReturnValue({ isMobile: true, isTablet: false, isDesktop: false });
    rerender(
      <MemoryRouter>
        <DesktopOnlyGate>
          <div data-testid="workspace-content">Workspace</div>
        </DesktopOnlyGate>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('pdf-tools-mobile-guidance')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-content')).not.toBeInTheDocument();
  });

  it('swaps from guidance to workspace when breakpoint changes to desktop', () => {
    mockedUseBreakpoint.mockReturnValue({ isMobile: true, isTablet: false, isDesktop: false });
    const { rerender } = renderInRouter(
      <DesktopOnlyGate>
        <div data-testid="workspace-content">Workspace</div>
      </DesktopOnlyGate>,
    );
    expect(screen.getByTestId('pdf-tools-mobile-guidance')).toBeInTheDocument();

    mockedUseBreakpoint.mockReturnValue({ isMobile: false, isTablet: false, isDesktop: true });
    rerender(
      <MemoryRouter>
        <DesktopOnlyGate>
          <div data-testid="workspace-content">Workspace</div>
        </DesktopOnlyGate>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('workspace-content')).toBeInTheDocument();
    expect(screen.queryByTestId('pdf-tools-mobile-guidance')).not.toBeInTheDocument();
  });
});

// ── PdfToolsRouteGuard ─────────────────────────────────────────────────────

describe('PdfToolsRouteGuard', () => {
  function mockPermissions(can: (key: string) => boolean, isLoading = false) {
    mockedUseMyPermissions.mockReturnValue({
      can,
      isLoading,
      permissions: [],
      roles: [],
      isAdmin: false,
    } as unknown as ReturnType<typeof useMyPermissions>);
  }

  function mockMenuConfig(enabledViews: string[], isLoading = false) {
    mockedUseProjectMenuConfig.mockReturnValue({
      enabledViews: enabledViews as ReturnType<typeof useProjectMenuConfig>['enabledViews'],
      isLoading,
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockPermissions(() => false);
    mockMenuConfig([]);
  });

  it('renders children when user has pdf-assembly:use permission AND menu visibility is enabled', () => {
    mockPermissions((key) => key === 'pdf-assembly:use');
    mockMenuConfig(['pdf-tools']);

    renderInRouter(
      <PdfToolsRouteGuard selectedProject="TestProject">
        <div data-testid="protected-content">Protected</div>
      </PdfToolsRouteGuard>,
    );

    expect(screen.getByTestId('pdf-tools-route-guard')).toBeInTheDocument();
    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
  });

  it('renders nothing when user lacks pdf-assembly:use permission', () => {
    mockPermissions(() => false);
    mockMenuConfig(['pdf-tools']);

    renderInRouter(
      <PdfToolsRouteGuard selectedProject="TestProject">
        <div data-testid="protected-content">Protected</div>
      </PdfToolsRouteGuard>,
    );

    expect(screen.queryByTestId('pdf-tools-route-guard')).not.toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('renders nothing when menu visibility is disabled', () => {
    mockPermissions((key) => key === 'pdf-assembly:use');
    mockMenuConfig([]);

    renderInRouter(
      <PdfToolsRouteGuard selectedProject="TestProject">
        <div data-testid="protected-content">Protected</div>
      </PdfToolsRouteGuard>,
    );

    expect(screen.queryByTestId('pdf-tools-route-guard')).not.toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('renders nothing when both permission and menu visibility are missing', () => {
    mockPermissions(() => false);
    mockMenuConfig([]);

    renderInRouter(
      <PdfToolsRouteGuard selectedProject="TestProject">
        <div data-testid="protected-content">Protected</div>
      </PdfToolsRouteGuard>,
    );

    expect(screen.queryByTestId('pdf-tools-route-guard')).not.toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('renders nothing while permissions are still loading', () => {
    mockPermissions((key) => key === 'pdf-assembly:use', true);
    mockMenuConfig(['pdf-tools']);

    renderInRouter(
      <PdfToolsRouteGuard selectedProject="TestProject">
        <div data-testid="protected-content">Protected</div>
      </PdfToolsRouteGuard>,
    );

    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('renders nothing when user lacks permission', () => {
    mockPermissions(() => false);
    mockMenuConfig(['pdf-tools']);

    renderInRouter(
      <PdfToolsRouteGuard selectedProject="TestProject">
        <div data-testid="protected-content">Protected</div>
      </PdfToolsRouteGuard>,
    );

    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('renders nothing when menu visibility is disabled', () => {
    mockPermissions((key) => key === 'pdf-assembly:use');
    mockMenuConfig([]);

    renderInRouter(
      <PdfToolsRouteGuard selectedProject="TestProject">
        <div data-testid="protected-content">Protected</div>
      </PdfToolsRouteGuard>,
    );

    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('renders children for super admin regardless of permission and menu visibility', () => {
    mockPermissions(() => false);
    mockMenuConfig([]);

    renderInRouter(
      <PdfToolsRouteGuard selectedProject="TestProject" isSuperAdmin>
        <div data-testid="protected-content">Protected</div>
      </PdfToolsRouteGuard>,
    );

    expect(screen.getByTestId('pdf-tools-route-guard')).toBeInTheDocument();
    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('renders nothing while menu config is still loading', () => {
    mockPermissions((key) => key === 'pdf-assembly:use');
    mockMenuConfig(['pdf-tools'], true);

    renderInRouter(
      <PdfToolsRouteGuard selectedProject="TestProject">
        <div data-testid="protected-content">Protected</div>
      </PdfToolsRouteGuard>,
    );

    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

// ── AppSidebar — PDF Assembly Tool nav item ───────────────────────────────

describe('AppSidebar — PDF Assembly Tool nav item', () => {
  const baseSidebarProps = {
    currentView: 'home',
    collapsed: false,
    onToggleCollapsed: jest.fn(),
    can: (_key: string) => false,
    menuEnabledViews: [] as string[],
    isSuperAdmin: false,
    selectedProject: 'TestProject',
    onNavigateHome: jest.fn(),
    onNavigateCalendar: jest.fn(),
    onNavigatePlanning: jest.fn(),
    onNavigateCloudCost: jest.fn(),
    onNavigateBacklog: jest.fn(),
    onNavigateAdmin: jest.fn(),
  };

  beforeEach(() => {
    mockedUseBreakpoint.mockReturnValue({ isMobile: false, isTablet: false, isDesktop: true });
  });

  it('shows PDF Assembly Tool when enabled in menu and user has pdf-assembly:use permission', () => {
    const onNavigatePdfTools = jest.fn();
    render(
      <AppSidebar
        {...baseSidebarProps}
        can={(key) => key === 'pdf-assembly:use'}
        menuEnabledViews={['pdf-tools']}
        onNavigatePdfTools={onNavigatePdfTools}
      />,
    );
    expect(screen.getByTestId('nav-item-pdf-tools')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'PDF Assembly Tool' })).toBeInTheDocument();
  });

  it('hides PDF Assembly Tool when menu visibility is disabled', () => {
    render(
      <AppSidebar
        {...baseSidebarProps}
        can={(key) => key === 'pdf-assembly:use'}
        menuEnabledViews={[]}
        onNavigatePdfTools={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('nav-item-pdf-tools')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'PDF Assembly Tool' })).not.toBeInTheDocument();
  });

  it('hides PDF Assembly Tool when user lacks pdf-assembly:use permission', () => {
    render(
      <AppSidebar
        {...baseSidebarProps}
        can={() => false}
        menuEnabledViews={['pdf-tools']}
        onNavigatePdfTools={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('nav-item-pdf-tools')).not.toBeInTheDocument();
  });

  it('shows PDF Assembly Tool for super admin regardless of menu and permission', () => {
    render(
      <AppSidebar
        {...baseSidebarProps}
        isSuperAdmin
        can={() => false}
        menuEnabledViews={[]}
        onNavigatePdfTools={jest.fn()}
      />,
    );
    expect(screen.getByTestId('nav-item-pdf-tools')).toBeInTheDocument();
  });
});
