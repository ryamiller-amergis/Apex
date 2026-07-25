/**
 * LoadTestDefinitionRunsPanel — per-definition run history
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { LoadTestDefinitionRunsPanel } from '../LoadTestDefinitionRunsPanel';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <LoadTestDefinitionRunsPanel project="project-a" definitionId="def-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LoadTestDefinitionRunsPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows empty state when the definition has no runs', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    }) as unknown as typeof fetch;

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('load-test-definition-runs-empty')).toBeInTheDocument();
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/load-tests/runs?definitionId=def-1'),
      expect.anything(),
    );
  });

  it('lists runs and navigates into run detail', async () => {
    const user = userEvent.setup();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            id: 'run-1',
            projectId: 'project-a',
            loadTestId: 'def-1',
            status: 'passed',
            runSource: 'app',
            queuedAt: '2026-07-25T10:00:00.000Z',
            completedAt: '2026-07-25T10:05:00.000Z',
            cancelRequested: false,
            overallResult: 'passed',
            createdAt: '2026-07-25T10:00:00.000Z',
            updatedAt: '2026-07-25T10:05:00.000Z',
            executionSnapshot: {
              definitionName: 'Checkout',
              targetUrl: 'https://api.staging.example.internal',
              environment: 'staging',
              script: 'export default function(){}',
              loadProfile: { vus: 1, durationMinutes: 1 },
              clientThresholds: [],
              secretRefs: {},
            },
          },
          {
            id: 'run-2',
            projectId: 'project-a',
            loadTestId: 'def-1',
            status: 'dispatched',
            runSource: 'app',
            queuedAt: '2026-07-25T11:00:00.000Z',
            cancelRequested: false,
            createdAt: '2026-07-25T11:00:00.000Z',
            updatedAt: '2026-07-25T11:00:00.000Z',
            executionSnapshot: {
              definitionName: 'Checkout',
              targetUrl: 'https://api.staging.example.internal',
              environment: 'staging',
              script: 'export default function(){}',
              loadProfile: { vus: 1, durationMinutes: 1 },
              clientThresholds: [],
              secretRefs: {},
            },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('load-test-definition-run-row-run-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('load-test-definition-run-row-run-2')).toBeInTheDocument();
    expect(screen.getByText(/1 in progress/i)).toBeInTheDocument();

    await user.click(screen.getByTestId('load-test-definition-run-open-run-1'));
    expect(mockNavigate).toHaveBeenCalledWith('/load-tests/runs/run-1');
  });
});
