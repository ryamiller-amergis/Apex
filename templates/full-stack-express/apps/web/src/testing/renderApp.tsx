import { QueryClient } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { App, AppLayout, AppProviders } from '../app/App';
import { AppRoutes } from '../app/routes';

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: 0 },
    },
  });
}

const PathProbe: React.FC = () => {
  const location = useLocation();
  return (
    <div data-testid="current-path" aria-hidden="true">
      {location.pathname}
    </div>
  );
};

export function renderApp(
  path: string,
  client: QueryClient = createTestQueryClient()
): RenderResult & { client: QueryClient } {
  const view = render(
    <AppProviders client={client}>
      <MemoryRouter initialEntries={[path]}>
        <PathProbe />
        <App />
      </MemoryRouter>
    </AppProviders>
  );
  return { ...view, client };
}

export function renderRoutes(
  path: string,
  client: QueryClient = createTestQueryClient()
): RenderResult & { client: QueryClient } {
  const view = render(
    <AppProviders client={client}>
      <MemoryRouter initialEntries={[path]}>
        <PathProbe />
        <AppLayout>
          <AppRoutes />
        </AppLayout>
      </MemoryRouter>
    </AppProviders>
  );
  return { ...view, client };
}
