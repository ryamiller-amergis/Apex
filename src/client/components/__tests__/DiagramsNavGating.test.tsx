import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppSidebar } from '../AppSidebar';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { DiagramsView } from '../DiagramsView';

jest.mock('../../hooks/useBreakpoint', () => ({
  useBreakpoint: jest.fn(() => ({ isMobile: false, isTablet: false, isDesktop: true })),
}));

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({ can: (key: string) => key === 'diagram:create' || key === 'diagram:view' }),
}));

jest.mock('../../hooks/useDiagrams', () => ({
  DIAGRAM_LIST_LIMIT: 50,
  useOwnedDiagrams: () => ({
    data: { items: [], hasMore: false },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useSharedDiagrams: () => ({
    data: { items: [], hasMore: false },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useDeleteDiagram: () => ({
    mutate: jest.fn(),
    isPending: false,
  }),
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
  onNavigateDiagrams: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseBreakpoint.mockReturnValue({ isMobile: false, isTablet: false, isDesktop: true });
});

describe('FEAT-002 Diagrams nav gating (PBI-001 / TBI-004)', () => {
  it('AC-0 / VT-09: shows nav-diagrams when menu-enabled and user has diagram:view', () => {
    render(
      <AppSidebar
        {...baseProps}
        menuEnabledViews={['diagrams']}
        can={(key) => key === 'diagram:view'}
      />,
    );
    expect(screen.getByTestId('nav-diagrams')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Diagrams' })).toBeInTheDocument();
  });

  it('AC-3 / VT-08: hides nav-diagrams when menu-enabled but user lacks diagram:view', () => {
    render(
      <AppSidebar
        {...baseProps}
        menuEnabledViews={['diagrams']}
        can={() => false}
      />,
    );
    expect(screen.queryByTestId('nav-diagrams')).not.toBeInTheDocument();
  });

  it('AC-2 / DoD-2: hides nav-diagrams when diagram:view is present but menu is not enabled', () => {
    render(
      <AppSidebar
        {...baseProps}
        menuEnabledViews={['calendar']}
        can={(key) => key === 'diagram:view'}
      />,
    );
    expect(screen.queryByTestId('nav-diagrams')).not.toBeInTheDocument();
  });

  it('AC-0: Super Admin sees Diagrams even when not in enabledViews', () => {
    render(
      <AppSidebar
        {...baseProps}
        isSuperAdmin
        menuEnabledViews={[]}
        can={() => false}
      />,
    );
    expect(screen.getByTestId('nav-diagrams')).toBeInTheDocument();
  });

  it('FEAT-003/004: DiagramsView browse surface exposes New Diagram landmark', () => {
    render(
      <MemoryRouter>
        <DiagramsView projectId="MyProject" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('diagrams-browse-view')).toBeInTheDocument();
    expect(screen.getByTestId('diagram-new-button')).toBeInTheDocument();
  });
});
