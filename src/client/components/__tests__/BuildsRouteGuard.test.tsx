import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BuildsRouteGuard } from '../BuildsRouteGuard';

const canView = (key: string) => key === 'builds:view';

function renderAt(props: Partial<React.ComponentProps<typeof BuildsRouteGuard>> = {}) {
  return render(
    <MemoryRouter initialEntries={['/builds']}>
      <Routes>
        <Route
          path="/builds"
          element={(
            <BuildsRouteGuard
              can={canView}
              isSuperAdmin={false}
              enabledViews={['builds']}
              flagEnabled
              isLoading={false}
              fallbackPath="/calendar"
              {...props}
            >
              <div data-testid="builds-child">child</div>
            </BuildsRouteGuard>
          )}
        />
        <Route path="/calendar" element={<div data-testid="fallback-page">fallback</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('BuildsRouteGuard', () => {
  const originalFetch = global.fetch;
  let fetchSpy: jest.Mock;

  beforeEach(() => {
    fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('PBI-003 AC-0 renders children when flag, menu and permission all hold', () => {
    renderAt();
    expect(screen.getByTestId('builds-child')).toBeInTheDocument();
  });

  it('VT-07 PBI-003 AC-1 redirects to the fallback when the menu excludes builds, with no build request', () => {
    renderAt({ enabledViews: ['calendar'] });
    expect(screen.getByTestId('fallback-page')).toBeInTheDocument();
    expect(screen.queryByTestId('builds-child')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('redirects when the flag is off, even for a super admin', () => {
    renderAt({ flagEnabled: false, isSuperAdmin: true });
    expect(screen.getByTestId('fallback-page')).toBeInTheDocument();
  });

  it('redirects when the user lacks builds:view', () => {
    renderAt({ can: () => false });
    expect(screen.getByTestId('fallback-page')).toBeInTheDocument();
  });

  it('renders nothing while access is loading', () => {
    const { container } = renderAt({ isLoading: true, enabledViews: [] });
    expect(container).toBeEmptyDOMElement();
  });
});
