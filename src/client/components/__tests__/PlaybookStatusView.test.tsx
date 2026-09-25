/**
 * PBI-002 and PBI-003 — what the status view renders.
 *
 * Covers VT-01 (step statuses plus the pinned version), VT-03 (empty state, not an error), VT-06
 * (suspension cause and deadline in both forms), VT-07 (`expired` reads as terminal), VT-08 (the
 * data-integrity warning for a suspension with no deadline), VT-09 (no suspension detail on a run
 * with no suspension) and VT-12 (text-labelled statuses and keyboard-navigable rows).
 *
 * `fetch` is stubbed rather than the hook mocked. The hooks are thin wrappers over TanStack Query
 * and mocking them would leave the query keys, the enabled-guard and the URL shape untested — and
 * those are exactly the parts that break when a route changes.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlaybookStatusView } from '../PlaybookStatusView';
import type {
  PlaybookRunDetail,
  PlaybookRunListResult,
  PlaybookStepRun,
  PlaybookStepRunStatus,
} from '../../../shared/types/playbook';

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({ can: () => false }),
}));

const PROJECT = 'Apex';

function step(overrides: Partial<PlaybookStepRun> & { stepId: string }): PlaybookStepRun {
  return {
    id: `row-${overrides.stepId}`,
    runId: 'run-1',
    stepType: 'notify',
    status: 'completed' as PlaybookStepRunStatus,
    agentRunId: null,
    resumeToken: null,
    outputInline: null,
    outputBlobRef: null,
    expiresAt: null,
    startedAt: '2026-09-20T10:00:00.000Z',
    completedAt: '2026-09-20T10:01:00.000Z',
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:01:00.000Z',
    ...overrides,
  };
}

const SUMMARY = {
  runId: 'run-1',
  project: PROJECT,
  definitionName: 'Demo A — Ask, Approve, Notify',
  definitionVersionId: 'ver-1',
  versionNumber: 3,
  status: 'running' as const,
  initiatorUserId: 'someone',
  startedAt: '2026-09-20T10:00:00.000Z',
  completedAt: null,
};

/**
 * Serves the list and detail endpoints from fixtures.
 *
 * Routed by URL rather than by call order so a test that expands a row is not coupled to how many
 * times the hook happened to poll.
 */
function stubFetch(list: PlaybookRunListResult, detail?: PlaybookRunDetail): jest.Mock {
  const mock = jest.fn(async (url: string) => {
    const body = url.includes('/definitions')
      ? { definitions: [] }
      : url.includes('/runs/')
        ? detail
        : list;
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response;
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PlaybookStatusView selectedProject={PROJECT} />
    </QueryClientProvider>
  );
}

/** Opens the single run row and waits for its steps. */
async function expandRun(): Promise<HTMLElement> {
  const toggle = await screen.findByTestId('playbook-run-expand-toggle');
  await userEvent.click(toggle);
  return screen.findByTestId('playbook-step-list');
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('VT-01 — each step shows its status, and the view names the pinned version', () => {
  it('renders every step status as text and the exact pinned version', async () => {
    stubFetch(
      { runs: [SUMMARY], total: 1 },
      {
        ...SUMMARY,
        steps: [
          step({ stepId: 'ask', stepType: 'cursor-agent', status: 'completed' }),
          step({ stepId: 'approve', stepType: 'approval-gate', status: 'running', completedAt: null }),
          step({ stepId: 'announce', status: 'pending', startedAt: null, completedAt: null }),
        ],
        currentStepId: 'approve',
        suspension: null,
      }
    );

    renderView();

    // The version the run pinned, named rather than implied.
    expect(await screen.findByTestId('playbook-run-pinned-version')).toHaveTextContent('v3');

    const stepList = await expandRun();
    const statuses = within(stepList)
      .getAllByTestId('playbook-step-status')
      .map((el) => el.textContent);

    expect(statuses).toEqual(['Completed', 'Running', 'Not started']);
  });

  it('shows the pinned version rather than any newer version of the definition', async () => {
    stubFetch({ runs: [{ ...SUMMARY, versionNumber: 1 }], total: 1 });

    renderView();

    // BR-006: a run pins the version it started on, so an old run keeps naming v1 forever.
    expect(await screen.findByTestId('playbook-run-pinned-version')).toHaveTextContent('v1');
  });
});

describe('VT-03 — a project with zero runs shows an empty state, not an error', () => {
  it('renders the zero-state message', async () => {
    stubFetch({ runs: [], total: 0 });

    renderView();

    expect(await screen.findByTestId('playbook-runs-empty-state')).toBeInTheDocument();
    expect(screen.queryByTestId('playbook-runs-error')).not.toBeInTheDocument();
  });
});

describe('VT-06 — suspension cause and deadline, in both forms', () => {
  it('shows the cause and the deadline in absolute and relative form', async () => {
    // Deliberately off the exact 2-hour boundary. The formatter floors, which is the right
    // direction for a deadline — it never claims more time remains than does — but it means an
    // exact boundary renders as "1 hour" the moment any time passes between fixture and render.
    const deadline = new Date(Date.now() + 2 * 60 * 60 * 1000 + 5 * 60 * 1000).toISOString();

    stubFetch(
      { runs: [{ ...SUMMARY, status: 'suspended' }], total: 1 },
      {
        ...SUMMARY,
        status: 'suspended',
        steps: [step({ stepId: 'approve', stepType: 'approval-gate', status: 'suspended', completedAt: null, expiresAt: deadline })],
        currentStepId: 'approve',
        suspension: { stepId: 'approve', reason: 'approval_gate', deadline },
      }
    );

    renderView();
    await expandRun();

    expect(await screen.findByTestId('playbook-suspension-cause')).toHaveTextContent(/approve/i);

    const deadlineEl = screen.getByTestId('playbook-suspension-deadline');
    // Relative, for a reader...
    expect(deadlineEl).toHaveTextContent(/in 2 hours/);
    // ...and absolute, which is the value that is actually precise.
    expect(deadlineEl.textContent).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it('puts the absolute time in an accessible label, so a screen reader gets the precise value', async () => {
    const deadline = new Date(Date.now() + 90 * 60 * 1000).toISOString();

    stubFetch(
      { runs: [{ ...SUMMARY, status: 'suspended' }], total: 1 },
      {
        ...SUMMARY,
        status: 'suspended',
        steps: [step({ stepId: 'approve', status: 'suspended', completedAt: null, expiresAt: deadline })],
        currentStepId: 'approve',
        suspension: { stepId: 'approve', reason: 'approval_gate', deadline },
      }
    );

    renderView();
    await expandRun();

    const labelled = await screen.findByLabelText(/^Deadline \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(labelled).toBeInTheDocument();
    expect(labelled).toHaveAttribute('title', expect.stringMatching(/\d{4}-\d{2}-\d{2}/));
  });
});

describe('VT-07 — an expired run reads as terminal, not as still waiting', () => {
  it('renders the expired status distinctly from waiting', async () => {
    stubFetch(
      { runs: [{ ...SUMMARY, status: 'expired' }], total: 1 },
      {
        ...SUMMARY,
        status: 'expired',
        steps: [step({ stepId: 'approve', status: 'expired', completedAt: null })],
        currentStepId: null,
        // The sweep processed it, so nothing is parked any more.
        suspension: null,
      }
    );

    renderView();

    const runStatus = await screen.findByTestId('playbook-run-status');
    expect(runStatus).toHaveTextContent(/expired/i);
    // The thing PBI-003 (b) actually guards against: it must not still look like it is waiting.
    expect(runStatus).not.toHaveTextContent(/waiting/i);

    await expandRun();
    expect(screen.queryByTestId('playbook-suspension')).not.toBeInTheDocument();
  });
});

describe('VT-08 — a suspension with no deadline surfaces a data-integrity warning', () => {
  it('warns rather than silently omitting the deadline', async () => {
    stubFetch(
      { runs: [{ ...SUMMARY, status: 'suspended' }], total: 1 },
      {
        ...SUMMARY,
        status: 'suspended',
        steps: [step({ stepId: 'approve', status: 'suspended', completedAt: null, expiresAt: null })],
        currentStepId: 'approve',
        suspension: { stepId: 'approve', reason: 'approval_gate', deadline: null },
      }
    );

    renderView();
    await expandRun();

    const warning = await screen.findByTestId('playbook-deadline-missing-warning');
    expect(warning).toBeInTheDocument();
    // Announced without stealing focus.
    expect(warning).toHaveAttribute('role', 'status');
    // It must say why this matters, not just that something is missing.
    expect(warning).toHaveTextContent(/will not time out|data error/i);

    expect(screen.queryByTestId('playbook-suspension-deadline')).not.toBeInTheDocument();
  });
});

describe('VT-09 — a run with no suspension shows no suspension detail', () => {
  it('renders neither a cause nor a deadline', async () => {
    stubFetch(
      { runs: [SUMMARY], total: 1 },
      {
        ...SUMMARY,
        steps: [step({ stepId: 'ask', status: 'completed' })],
        currentStepId: null,
        suspension: null,
      }
    );

    renderView();
    await expandRun();

    expect(screen.queryByTestId('playbook-suspension')).not.toBeInTheDocument();
    expect(screen.queryByTestId('playbook-suspension-cause')).not.toBeInTheDocument();
    expect(screen.queryByTestId('playbook-suspension-deadline')).not.toBeInTheDocument();
    expect(screen.queryByTestId('playbook-deadline-missing-warning')).not.toBeInTheDocument();
  });
});

describe('VT-12 — accessibility: text statuses and keyboard-navigable rows', () => {
  it('conveys every status as text, so removing colour loses nothing', async () => {
    stubFetch(
      { runs: [SUMMARY], total: 1 },
      {
        ...SUMMARY,
        steps: [
          step({ stepId: 'ask', status: 'failed_retryable', completedAt: null }),
          step({ stepId: 'announce', status: 'cancelled', completedAt: null }),
        ],
        currentStepId: null,
        suspension: null,
      }
    );

    renderView();
    const stepList = await expandRun();

    for (const el of within(stepList).getAllByTestId('playbook-step-status')) {
      expect(el.textContent?.trim()).toBeTruthy();
    }
    // `failed_retryable` says what to do about it rather than showing the raw token.
    expect(within(stepList).getByText(/can be retried/i)).toBeInTheDocument();
  });

  it('carries aria-expanded and aria-controls on the toggle, pointing at the step list', async () => {
    stubFetch(
      { runs: [SUMMARY], total: 1 },
      { ...SUMMARY, steps: [step({ stepId: 'ask' })], currentStepId: null, suspension: null }
    );

    renderView();
    const toggle = await screen.findByTestId('playbook-run-expand-toggle');

    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));

    const controls = toggle.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    // The relationship has to actually resolve — an aria-controls pointing at nothing is worse
    // than none at all, because it reads as a promise to a screen reader.
    expect(document.getElementById(controls!)).toBe(screen.getByTestId('playbook-step-list'));
  });

  it('expands from the keyboard', async () => {
    stubFetch(
      { runs: [SUMMARY], total: 1 },
      { ...SUMMARY, steps: [step({ stepId: 'ask' })], currentStepId: null, suspension: null }
    );

    renderView();
    const toggle = await screen.findByTestId('playbook-run-expand-toggle');

    toggle.focus();
    await userEvent.keyboard('{Enter}');

    expect(await screen.findByTestId('playbook-step-list')).toBeInTheDocument();
  });
});

describe('run volume above the display cap', () => {
  it('reports the accurate total when rows are hidden', async () => {
    stubFetch({ runs: [SUMMARY], total: 300 });

    renderView();

    expect(await screen.findByTestId('playbook-runs-total')).toHaveTextContent('Showing 1 of 300');
  });

  it('says nothing about totals when every run is shown', async () => {
    stubFetch({ runs: [SUMMARY], total: 1 });

    renderView();

    await screen.findByTestId('playbook-run-row');
    expect(screen.queryByTestId('playbook-runs-total')).not.toBeInTheDocument();
  });
});
