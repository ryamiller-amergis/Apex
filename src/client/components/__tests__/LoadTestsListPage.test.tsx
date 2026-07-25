/**
 * TBI-006 DoD-0 / VT-06 / VT-07 — Load Tests list
 */
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { LoadTestsListPage } from '../LoadTestsListPage';

const mockCan = jest.fn((key: string) => key === 'load-test:manage' || key === 'load-test:view');
const mockNavigate = jest.fn();

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({ can: mockCan }),
}));

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

function renderList(canView = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <LoadTestsListPage project="project-a" canView={canView} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LoadTestsListPage (TBI-006)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCan.mockImplementation(
      (key: string) => key === 'load-test:manage' || key === 'load-test:view',
    );
  });

  it('VT-06 / DoD-0: empty list shows empty state and Create CTA when manage', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    }) as unknown as typeof fetch;

    renderList();

    await waitFor(() => {
      expect(screen.getByTestId('load-tests-list-empty')).toBeInTheDocument();
    });
    expect(screen.getAllByTestId('load-tests-create-btn').length).toBeGreaterThan(0);
  });

  it('VT-07: last-run badge shows Never run when latestRun absent', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            id: 'def-1',
            projectId: 'project-a',
            name: 'Checkout',
            targetUrl: 'https://api.staging.example.internal',
            environment: 'staging',
            engine: 'k6',
            flowType: 'single',
            scriptSource: 'form_builder',
            script: 'export default function(){}',
            loadProfile: { vus: 1, durationMinutes: 1 },
            clientThresholds: [],
            createdAt: '2026-07-24T00:00:00.000Z',
            updatedAt: '2026-07-24T00:00:00.000Z',
            createdBy: 'u',
            updatedBy: 'u',
          },
        ],
      }),
    }) as unknown as typeof fetch;

    renderList();

    await waitFor(() => {
      expect(screen.getByTestId('load-test-row-def-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('load-test-last-run-badge')).toHaveTextContent('Never run');
  });

  it('hides Create when user lacks load-test:manage', async () => {
    mockCan.mockImplementation((key: string) => key === 'load-test:view');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    }) as unknown as typeof fetch;

    renderList();

    await waitFor(() => {
      expect(screen.getByTestId('load-tests-list-empty')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('load-tests-create-btn')).not.toBeInTheDocument();
  });
});
