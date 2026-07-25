/**
 * TBI-006 DoD-0 / VT-06 / VT-07 — Load Tests list
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { LoadTestsListPage } from '../LoadTestsListPage';

const mockCan = jest.fn(
  (key: string) =>
    key === 'load-test:manage' || key === 'load-test:view' || key === 'load-test:run',
);
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

const listItem = {
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
};

function mockListFetch(definitions: unknown[], runs: unknown[] = []) {
  global.fetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && typeof url === 'string' && url.includes('/runs')) {
      return {
        ok: true,
        status: 201,
        json: async () => ({
          run: {
            id: 'run-from-list',
            projectId: 'project-a',
            loadTestId: 'def-1',
            status: 'dispatched',
            runSource: 'app',
            queuedAt: '2026-07-25T00:00:00.000Z',
            cancelRequested: false,
            createdAt: '2026-07-25T00:00:00.000Z',
            updatedAt: '2026-07-25T00:00:00.000Z',
          },
        }),
      };
    }
    if (typeof url === 'string' && url.includes('/load-tests/runs')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: runs }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ items: definitions }),
    };
  }) as unknown as typeof fetch;
}

describe('LoadTestsListPage (TBI-006)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCan.mockImplementation(
      (key: string) =>
        key === 'load-test:manage' || key === 'load-test:view' || key === 'load-test:run',
    );
  });

  it('VT-06 / DoD-0: empty list shows empty state and Create CTA when manage', async () => {
    mockListFetch([]);

    renderList();

    await waitFor(() => {
      expect(screen.getByTestId('load-tests-list-empty')).toBeInTheDocument();
    });
    expect(screen.getAllByTestId('load-tests-create-btn').length).toBeGreaterThan(0);
  });

  it('VT-07: last-run badge shows Never run when latestRun absent', async () => {
    mockListFetch([listItem]);

    renderList();

    await waitFor(() => {
      expect(screen.getByTestId('load-test-row-def-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('load-test-last-run-badge')).toHaveTextContent('Never run');
  });

  it('shows latest run status from definition list payload', async () => {
    mockListFetch([
      {
        ...listItem,
        latestRun: { id: 'run-9', status: 'dispatched', overallResult: null },
      },
    ]);

    renderList();

    await waitFor(() => {
      expect(screen.getByTestId('load-test-last-run-badge')).toHaveTextContent(/dispatched/i);
    });
  });

  it('shows active runs panel for queued/dispatched/running', async () => {
    mockListFetch([listItem], [
      {
        id: 'run-active',
        projectId: 'project-a',
        loadTestId: 'def-1',
        status: 'queued',
        runSource: 'app',
        queuedAt: '2026-07-25T00:00:00.000Z',
        cancelRequested: false,
        createdAt: '2026-07-25T00:00:00.000Z',
        updatedAt: '2026-07-25T00:00:00.000Z',
        executionSnapshot: {
          definitionName: 'Checkout',
          targetUrl: listItem.targetUrl,
          environment: 'staging',
          script: 'export default function(){}',
          loadProfile: { vus: 1, durationMinutes: 1 },
          clientThresholds: [],
          secretRefs: {},
        },
      },
    ]);

    renderList();

    await waitFor(() => {
      expect(screen.getByTestId('load-tests-active-runs')).toBeInTheDocument();
    });
    expect(screen.getByTestId('load-tests-active-runs')).toHaveTextContent('Checkout');
    expect(screen.getByTestId('load-test-run-status')).toHaveTextContent(/queued/i);
  });

  it('hides Create when user lacks load-test:manage', async () => {
    mockCan.mockImplementation((key: string) => key === 'load-test:view');
    mockListFetch([]);

    renderList();

    await waitFor(() => {
      expect(screen.getByTestId('load-tests-list-empty')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('load-tests-create-btn')).not.toBeInTheDocument();
  });

  it('Run enqueues from the list and navigates to run detail', async () => {
    const user = userEvent.setup();
    mockListFetch([listItem]);

    renderList();

    await waitFor(() => {
      expect(screen.getByTestId('load-test-run-btn-def-1')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('load-test-run-btn-def-1'));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/load-tests/runs/run-from-list');
    });
  });

  it('hides Run when user lacks load-test:run', async () => {
    mockCan.mockImplementation(
      (key: string) => key === 'load-test:view' || key === 'load-test:manage',
    );
    mockListFetch([listItem]);

    renderList();

    await waitFor(() => {
      expect(screen.getByTestId('load-test-row-def-1')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('load-test-run-btn-def-1')).not.toBeInTheDocument();
  });

  it('offers a Runs action that opens definition run history', async () => {
    const user = userEvent.setup();
    mockListFetch([listItem]);

    renderList();

    await waitFor(() => {
      expect(screen.getByTestId('load-test-view-runs-btn-def-1')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('load-test-view-runs-btn-def-1'));
    expect(mockNavigate).toHaveBeenCalledWith('/load-tests/def-1/runs');
  });
});
