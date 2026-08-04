/**
 * TBI-006 VT-08 — LoadTestsRouteGuard
 */
import { render, screen } from '@testing-library/react';
import { LoadTestsRouteGuard } from '../LoadTestsRouteGuard';

const mockCan = jest.fn();
const mockPermLoading = jest.fn(() => false);
const mockMenuLoading = jest.fn(() => false);
const mockEnabledViews = jest.fn(() => ['load-tests']);

jest.mock('../../hooks/useRbac', () => ({
  useMyPermissions: () => ({
    can: mockCan,
    isLoading: mockPermLoading(),
  }),
}));

jest.mock('../../hooks/useProjectMenuConfig', () => ({
  useProjectMenuConfig: () => ({
    enabledViews: mockEnabledViews(),
    isLoading: mockMenuLoading(),
  }),
}));

describe('LoadTestsRouteGuard (VT-08, TBI-006)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPermLoading.mockReturnValue(false);
    mockMenuLoading.mockReturnValue(false);
    mockEnabledViews.mockReturnValue(['load-tests']);
    mockCan.mockImplementation((key: string) => key === 'load-test:view');
  });

  it('renders children when menu enabled and load-test:view granted', () => {
    render(
      <LoadTestsRouteGuard selectedProject="project-a">
        <div data-testid="child">ok</div>
      </LoadTestsRouteGuard>,
    );
    expect(screen.getByTestId('load-tests-route-guard')).toBeInTheDocument();
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('hides children when menu disabled', () => {
    mockEnabledViews.mockReturnValue([]);
    render(
      <LoadTestsRouteGuard selectedProject="project-a">
        <div data-testid="child">ok</div>
      </LoadTestsRouteGuard>,
    );
    expect(screen.queryByTestId('load-tests-route-guard')).not.toBeInTheDocument();
    expect(screen.queryByTestId('child')).not.toBeInTheDocument();
  });

  it('hides children when missing load-test:view', () => {
    mockCan.mockReturnValue(false);
    render(
      <LoadTestsRouteGuard selectedProject="project-a">
        <div data-testid="child">ok</div>
      </LoadTestsRouteGuard>,
    );
    expect(screen.queryByTestId('load-tests-route-guard')).not.toBeInTheDocument();
  });

  it('allows Super Admin even without menu/permission', () => {
    mockCan.mockReturnValue(false);
    mockEnabledViews.mockReturnValue([]);
    render(
      <LoadTestsRouteGuard selectedProject="project-a" isSuperAdmin>
        <div data-testid="child">ok</div>
      </LoadTestsRouteGuard>,
    );
    expect(screen.getByTestId('load-tests-route-guard')).toBeInTheDocument();
  });
});
