/**
 * FEAT-009 / TBI-009 + PBI-011 — LoadTestRunDetailView
 *
 * AC-0: live status + threshold table on completion
 * AC-1: SSE drop reconnect keeps run id context
 * AC-2: queued/dispatched are in-progress (not failure)
 * AC-3: view without run cannot cancel
 * DoD-0..3: SSE, thresholds, cancel gate, chart degrade
 */

import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { LoadTestRun } from '../../../shared/types/loadTest';
import { LoadTestRunDetailView } from '../LoadTestRunDetailView';
import { LoadTestRunStatusBadge } from '../LoadTestRunStatusBadge';
import { LoadTestThresholdResultsTable } from '../LoadTestThresholdResultsTable';

const PROJECT = 'project-a';
const RUN_ID = 'run-123';

const baseRun: LoadTestRun = {
  id: RUN_ID,
  projectId: PROJECT,
  loadTestId: 'def-1',
  status: 'running',
  runSource: 'app',
  queuedAt: '2026-07-25T00:00:00.000Z',
  cancelRequested: false,
  createdAt: '2026-07-25T00:00:00.000Z',
  updatedAt: '2026-07-25T00:00:00.000Z',
  executionSnapshot: {
    targetUrl: 'https://api.staging.example.internal',
    script: 'export default function() {}',
    loadProfile: { vus: 1, durationMinutes: 1 },
    clientThresholds: [{ metric: 'http_req_duration', expression: 'p(95)<500' }],
    secretRefs: {},
    environment: 'staging',
    definitionName: 'Checkout API',
  },
};

let mockCanRun = true;
let mockPermLoading = false;
let mockPermData: {
  permissions: string[];
  roles: string[];
  isSuperAdmin: boolean;
} | undefined = {
  permissions: ['load-test:view', 'load-test:run'],
  roles: [],
  isSuperAdmin: false,
};
let mockStream = {
  status: 'running' as string | null,
  cancelRequested: false,
  progress: { vu: 5, iteration: 2, message: 'warming up' } as {
    vu?: number;
    iteration?: number;
    message?: string;
  } | null,
  thresholdResults: null as LoadTestRun['thresholdResults'],
  overallResult: null as 'passed' | 'failed' | null,
  reconnecting: false,
  lastEventAt: null as string | null,
  error: null as string | null,
};

jest.mock('../../hooks/useRbac', () => ({
  useMyPermissions: () => ({
    can: (key: string) => {
      if (key === 'load-test:view') return Boolean(mockPermData?.permissions.includes('load-test:view'));
      if (key === 'load-test:run') return mockCanRun;
      return false;
    },
    isLoading: mockPermLoading,
    data: mockPermData,
  }),
}));

jest.mock('../../hooks/useLoadTestRunStream', () => ({
  isTerminalRunStatus: (status: string | null | undefined) =>
    ['passed', 'failed', 'errored', 'cancelled'].includes(String(status)),
  useLoadTestRunStream: () => mockStream,
}));

let mockRun: LoadTestRun = baseRun;
let mockRunQuery = {
  data: mockRun as LoadTestRun | undefined,
  isLoading: false,
  isError: false,
  refetch: jest.fn(),
};

jest.mock('../../hooks/useLoadTestRuns', () => ({
  useLoadTestRun: () => mockRunQuery,
  useCancelRun: () => ({
    mutate: jest.fn(),
    isPending: false,
  }),
}));

function renderDetail(run: LoadTestRun = baseRun) {
  mockRun = run;
  mockRunQuery = {
    data: run,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  };

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <LoadTestRunDetailView project={PROJECT} runId={RUN_ID} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.restoreAllMocks();
  mockCanRun = true;
  mockPermLoading = false;
  mockPermData = {
    permissions: ['load-test:view', 'load-test:run'],
    roles: [],
    isSuperAdmin: false,
  };
  mockStream = {
    status: 'running',
    cancelRequested: false,
    progress: { vu: 5, iteration: 2, message: 'warming up' },
    thresholdResults: null,
    overallResult: null,
    reconnecting: false,
    lastEventAt: null,
    error: null,
  };
});

describe('LoadTestRunStatusBadge (PBI-011 AC-2 / TBI-009)', () => {
  it('AC-2: queued and dispatched use in-progress tone, not failure', () => {
    const { rerender } = render(<LoadTestRunStatusBadge status="queued" />);
    expect(screen.getByTestId('load-test-run-status')).toHaveAttribute('data-tone', 'inProgress');
    expect(screen.getByTestId('load-test-run-status')).toHaveTextContent('Queued');

    rerender(<LoadTestRunStatusBadge status="dispatched" />);
    expect(screen.getByTestId('load-test-run-status')).toHaveAttribute('data-tone', 'inProgress');
    expect(screen.getByTestId('load-test-run-status')).toHaveTextContent('Dispatched');
  });
});

describe('LoadTestThresholdResultsTable (TBI-009 DoD-1)', () => {
  it('DoD-1: renders per-threshold outcomes with headers and overall result', () => {
    render(
      <LoadTestThresholdResultsTable
        overallResult="passed"
        results={[
          {
            metric: 'http_req_duration',
            expression: 'p(95)<500',
            passed: true,
            observed: '412',
          },
        ]}
      />,
    );

    expect(screen.getByTestId('load-test-run-overall-result')).toHaveTextContent(/pass/i);
    expect(screen.getByTestId('load-test-threshold-results')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Metric' })).toBeInTheDocument();
    expect(screen.getByText('Pass')).toBeInTheDocument();
    expect(screen.getByText('412')).toBeInTheDocument();
  });

  it('shows No data when threshold was not evaluated (missing k6 ok flag)', () => {
    render(
      <LoadTestThresholdResultsTable
        results={[
          {
            metric: 'http_req_duration',
            expression: 'p(95)<500',
            passed: false,
            evaluated: false,
          },
        ]}
      />,
    );

    expect(screen.getByText('No data')).toBeInTheDocument();
    expect(screen.queryByText('Fail')).not.toBeInTheDocument();
  });
});

describe('LoadTestRunDetailView (FEAT-009)', () => {
  it('does not flash permission denied while permissions are still loading', () => {
    mockPermLoading = true;
    mockPermData = undefined;
    mockRunQuery = {
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: jest.fn(),
    };

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <LoadTestRunDetailView project={PROJECT} runId={RUN_ID} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('load-test-run-detail')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/do not have permission/i)).not.toBeInTheDocument();
  });

  it('AC-0 / DoD-0: shows live status, progress, and threshold table on completion', async () => {
    mockStream = {
      ...mockStream,
      status: 'passed',
      progress: null,
      thresholdResults: [
        {
          metric: 'http_req_duration',
          expression: 'p(95)<500',
          passed: true,
          observed: '450',
        },
      ],
      overallResult: 'passed',
    };

    renderDetail({
      ...baseRun,
      status: 'passed',
      overallResult: 'passed',
      thresholdResults: mockStream.thresholdResults,
    });

    await waitFor(() => {
      expect(screen.getByTestId('load-test-run-detail')).toBeInTheDocument();
    });
    expect(screen.getByTestId('load-test-run-status')).toHaveTextContent(/passed/i);
    expect(screen.getByTestId('load-test-threshold-results')).toBeInTheDocument();
    expect(screen.getByTestId('load-test-run-overall-result')).toHaveTextContent(/pass/i);
    expect(screen.getByTestId('load-test-run-live-region')).toBeInTheDocument();
    expect(screen.getByTestId('load-test-run-pipeline')).toBeInTheDocument();
    expect(screen.getByTestId('load-test-run-execution')).toBeInTheDocument();
    expect(screen.getByTestId('load-test-run-script-preview')).toHaveTextContent(
      'export default function() {}',
    );
  });

  it('shows empty live-progress guidance while dispatched', async () => {
    mockStream = {
      ...mockStream,
      status: 'dispatched',
      progress: null,
      thresholdResults: null,
      overallResult: null,
      reconnecting: false,
    };

    renderDetail({ ...baseRun, status: 'dispatched' });

    await waitFor(() => {
      expect(screen.getByTestId('load-test-run-progress-empty')).toBeInTheDocument();
    });
    expect(screen.getByTestId('load-test-run-pipeline-dispatched')).toHaveAttribute(
      'data-active',
      'true',
    );
    expect(screen.getByTestId('load-test-run-status-explain')).toHaveTextContent(/noop|runner/i);
  });

  it('explains reaper stale-heartbeat errors for noop local dispatch', async () => {
    mockStream = {
      ...mockStream,
      status: 'errored',
      progress: null,
      thresholdResults: null,
      overallResult: null,
    };

    renderDetail({
      ...baseRun,
      status: 'errored',
      errorDetail: 'Stale heartbeat — run marked errored by reaper',
    });

    await waitFor(() => {
      expect(screen.getByTestId('load-test-run-status-explain')).toHaveTextContent(/reaper|noop/i);
    });
    expect(screen.getByText(/Stale heartbeat/i)).toBeInTheDocument();
  });

  it('AC-1: reconnect banner keeps run id context when SSE drops', async () => {
    mockStream = {
      ...mockStream,
      reconnecting: true,
      error: 'Connection lost — reconnecting…',
    };

    renderDetail();

    await waitFor(() => {
      expect(screen.getByTestId('load-test-run-reconnect-banner')).toBeInTheDocument();
    });
    expect(screen.getByTestId('load-test-run-reconnect-banner')).toHaveTextContent(RUN_ID);
    expect(screen.getByTestId('load-test-run-status')).toHaveTextContent(/running/i);
  });

  it('AC-2: queued cold-start is in-progress, not failure', async () => {
    mockStream = { ...mockStream, status: 'queued', progress: null };
    renderDetail({ ...baseRun, status: 'queued' });

    await waitFor(() => {
      expect(screen.getByTestId('load-test-run-status')).toHaveAttribute('data-tone', 'inProgress');
    });
    expect(screen.getByTestId('load-test-run-status')).not.toHaveAttribute('data-tone', 'failed');
  });

  it('AC-3 / DoD-2: view without run permission hides cancel', async () => {
    mockCanRun = false;
    mockStream = {
      ...mockStream,
      status: 'passed',
      thresholdResults: [
        { metric: 'http_req_failed', expression: 'rate<0.01', passed: true, observed: '0' },
      ],
      overallResult: 'passed',
    };

    renderDetail({
      ...baseRun,
      status: 'passed',
      overallResult: 'passed',
      thresholdResults: mockStream.thresholdResults,
    });

    await waitFor(() => {
      expect(screen.getByTestId('load-test-threshold-results')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('load-test-run-cancel-btn')).not.toBeInTheDocument();
  });

  it('DoD-2: cancel visible with load-test:run while running', async () => {
    renderDetail();
    await waitFor(() => {
      expect(screen.getByTestId('load-test-run-cancel-btn')).toBeInTheDocument();
    });
  });

  it('DoD-3: omits chart section when no timeseries artifact', async () => {
    renderDetail({ ...baseRun, timeseriesArtifactRef: null });
    await waitFor(() => {
      expect(screen.getByTestId('load-test-run-detail')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('load-test-run-timeseries-chart')).not.toBeInTheDocument();
  });
});
