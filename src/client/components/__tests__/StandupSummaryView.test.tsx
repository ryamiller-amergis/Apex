import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { StandupSummaryView } from '../StandupSummaryView';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

jest.mock('remark-gfm', () => () => undefined);

let mockPermissions = new Set<string>(['standup:participate', 'workitems:write']);

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    can: (perm: string) => mockPermissions.has(perm),
    selectedProject: 'MaxView',
  }),
}));

const mockSession = {
  id: 'session-1',
  sessionDate: '2026-06-30',
  status: 'completed',
  summaryMarkdown: '## Team update\nAll good.',
  config: {
    project: 'MaxView',
    areaPath: 'MaxView\\Team',
    deliveryModel: 'flow' as const,
    teamGoal: 'Keep flow cycle time under 3 days',
  },
  participants: [
    {
      id: 'p1',
      userId: 'user-1',
      displayName: 'Dev User',
      status: 'submitted',
      structuredUpdate: {
        yesterday: 'Shipped #101 billing migration',
        today: 'Code review on #102',
        blockers: 'Staging pipeline failing on #102',
        userCorrections: 'Coordinated DB migration window with SRE',
      },
      preparedBrief: {
        generatedAt: '2026-06-30T09:00:00Z',
        deliveryModel: 'flow' as const,
        teamGoal: 'Keep flow cycle time under 3 days',
        workDomains: ['database' as const, 'backend' as const],
        multiDayArc: {
          sessionsAnalyzed: 2,
          summary: 'Across 2 prior standups: 2 progress updates logged, zero multi-day carryovers.',
          carryoverStreaks: [],
        },
        accomplishedSinceLast: [],
        priorCommitments: [],
        suggestedToday: [
          {
            workItemId: 101,
            title: 'Billing SQL migration',
            workItemType: 'Task',
            state: 'In PR',
            riskFlags: [],
          },
        ],
        detectedExceptions: [],
        openFollowups: [],
        sdlcCallouts: [
          {
            id: 'sdlc-sql-pr-77',
            category: 'sql_migration' as const,
            severity: 'warning' as const,
            domain: 'database' as const,
            title: 'SQL / Schema Change Detected (PR !77)',
            detail:
              'SQL / Schema Change Detected: PR !77 (#101) modifies migrations/20261115_billing.sql — verify migration rollback, execution order, and release DB step are accounted for.',
            recommendation:
              'Confirm -- Down Migration reversibility and release DB execution.',
            workItemIds: [101],
            prIds: [77],
            filePaths: ['migrations/20261115_billing.sql'],
          },
        ],
      },
      submittedAt: '2026-06-30T10:00:00Z',
    },
    {
      id: 'p2',
      userId: 'user-2',
      displayName: 'Infra Engineer',
      status: 'notified',
      structuredUpdate: null,
      preparedBrief: {
        generatedAt: '2026-06-30T09:00:00Z',
        deliveryModel: 'flow' as const,
        teamGoal: 'Keep flow cycle time under 3 days',
        workDomains: ['iac' as const],
        recommendedFocus: 'Re-run skipped Terraform plan stage on PR !81',
        accomplishedSinceLast: [
          {
            workItemId: 205,
            title: 'Worker container scaling',
            workItemType: 'Task',
            state: 'In PR',
            evidence: 'ADO update',
          },
        ],
        priorCommitments: [],
        suggestedToday: [],
        detectedExceptions: [],
        openFollowups: [],
        sdlcCallouts: [
          {
            id: 'sdlc-iac-pr-81',
            category: 'iac_pipeline' as const,
            severity: 'critical' as const,
            domain: 'iac' as const,
            title: 'IaC Pipeline Verification Alert (PR !81)',
            detail:
              'IaC Pipeline Verification Alert: PR !81 (#205) modifies infra/worker.tf, but pipeline Infra-CI #44 did not complete a passing Terraform/IaC validation stage (stage "terraform-plan" was skipped).',
            recommendation: 'Run and verify Terraform validate & plan stage.',
            workItemIds: [205],
            prIds: [81],
            filePaths: ['infra/worker.tf'],
          },
        ],
      },
      submittedAt: null,
    },
  ],
  followups: [
    {
      id: 'f1',
      title: 'Follow up with QA',
      description: 'Confirm test plan',
      status: 'open',
      participantUserIds: ['user-1'],
    },
  ],
  proposals: [
    {
      id: 'prop-1',
      sessionId: 'session-1',
      participantId: 'p1',
      project: 'MaxView',
      workItemId: 102,
      workItemTitle: 'Auth service PBI',
      proposalType: 'state' as const,
      fieldName: 'state',
      currentValue: 'In PR',
      proposedValue: 'Ready for Test',
      reason: 'PR merged',
      confidence: 'at_risk' as const,
      status: 'pending' as const,
      decidedBy: null,
      decidedAt: null,
      createdAt: '2026-06-30T10:00:00Z',
    },
  ],
};

function renderWithSession(sessionId: string | null) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const path = sessionId
    ? `/standup-summary?session=${sessionId}`
    : '/standup-summary';
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/standup-summary" element={<StandupSummaryView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('StandupSummaryView (SDLC Callouts, Area Breakdown & Narratives)', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    mockPermissions = new Set(['standup:participate', 'workitems:write']);
  });

  it('renders SDLC callouts, area breakdown, and both Confirmed and AI-Drafted individual narratives', async () => {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/api/standup/sessions/session-1')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => mockSession,
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [mockSession],
      } as Response);
    });

    renderWithSession('session-1');

    await waitFor(() => {
      expect(screen.getByText('Standup Summary')).toBeInTheDocument();
    });

    expect(screen.getByTestId('pulse-sdlc-callouts-section')).toHaveTextContent(
      'migrations/20261115_billing.sql',
    );
    expect(screen.getByTestId('pulse-sdlc-callouts-section')).toHaveTextContent(
      'infra/worker.tf',
    );
    expect(screen.getByTestId('pulse-area-breakdown-section')).toHaveTextContent(
      'Database / SQL',
    );
    expect(screen.getByTestId('pulse-area-breakdown-section')).toHaveTextContent(
      'Infra / Terraform',
    );

    // Confirmed participant with user correction
    expect(
      screen.getByTestId('participant-narrative-status-user-1'),
    ).toHaveTextContent('Confirmed');
    expect(
      screen.getByTestId('participant-narrative-correction-user-1'),
    ).toHaveTextContent('Coordinated DB migration window with SRE');

    // Unsubmitted participant gets AI-Drafted from ADO narrative
    expect(
      screen.getByTestId('participant-narrative-status-user-2'),
    ).toHaveTextContent('AI-Drafted from ADO');
  });

  it('auto-loads latest session when ?session= query param is omitted (AC-06)', async () => {
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/api/standup/sessions/latest')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => mockSession,
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [mockSession],
      } as Response);
    });
    global.fetch = fetchMock;

    renderWithSession(null);

    await waitFor(() => {
      expect(screen.getByTestId('pulse-team-goal')).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/standup/sessions/latest?project=MaxView',
      expect.any(Object),
    );
  });

  it('allows confirming and applying a pending ADO proposal when user has workitems:write (AC-07)', async () => {
    const fetchMock = jest.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/proposals/prop-1/apply') && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            proposal: { ...mockSession.proposals[0], status: 'applied' },
          }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => mockSession,
      } as Response);
    });
    global.fetch = fetchMock;

    renderWithSession('session-1');

    const applyBtn = await screen.findByTestId('proposal-apply-btn-prop-1');
    fireEvent.click(applyBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/standup/proposals/prop-1/apply',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });
});
