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
        yesterday: 'Shipped #101 feature',
        today: 'Code review on #102',
        blockers: 'Staging pipeline failing on #102',
      },
      submittedAt: '2026-06-30T10:00:00Z',
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

describe('StandupSummaryView (5-Minute Team Pulse Board)', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    mockPermissions = new Set(['standup:participate', 'workitems:write']);
  });

  it('shows loading then Team Pulse summary when ?session= is provided', async () => {
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

    expect(screen.getByText('Loading session...')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Standup Summary')).toBeInTheDocument();
    });

    expect(screen.getByTestId('pulse-delivery-model')).toHaveTextContent('Flow');
    expect(screen.getByTestId('pulse-team-goal')).toHaveTextContent(
      'Keep flow cycle time under 3 days',
    );
    expect(screen.getByTestId('pulse-blockers-section')).toHaveTextContent(
      'Staging pipeline failing on #102',
    );
    expect(screen.getByText(/All good\./)).toBeInTheDocument();
    expect(screen.getByText('Follow up with QA')).toBeInTheDocument();
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

  it('allows confirming and applying a pending ADO proposal when user has workitems:write (AC-08)', async () => {
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

  it('shows not found when fetch returns empty session for an explicit session id', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => null,
    } as Response);

    renderWithSession('missing-session');

    await waitFor(() => {
      expect(screen.getByText('Session not found.')).toBeInTheDocument();
    });
  });
});
