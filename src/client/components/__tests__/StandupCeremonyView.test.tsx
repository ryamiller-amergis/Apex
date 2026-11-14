import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { StandupCeremonyView } from '../StandupCeremonyView';

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    can: () => true,
    selectedProject: 'MaxView',
    selectedAreaPath: 'MaxView',
  }),
}));

const seededAdoSession = {
  participantId: 'part-flow-1',
  sessionId: 'sess-flow-1',
  threadId: 'thread-flow-1',
  status: 'notified',
  sessionDate: '2026-11-13',
  sessionStatus: 'collecting',
  config: {
    id: 'cfg-flow-1',
    project: 'MaxView',
    areaPath: null,
    deliveryModel: 'flow',
    goalSource: 'manual',
    teamGoal: 'Keep flow cycle time under 3 days',
    policy: {
      staleDaysThreshold: 3,
      prReviewWaitHours: 24,
      wipLimitPerPerson: 3,
      slaHoursHighPriority: null,
      enablePrEvidence: true,
      enablePipelineEvidence: true,
      enableCommitmentMemory: true,
      enableTargetDateChecks: false,
    },
  },
  preparedBrief: {
    generatedAt: '2026-11-13T12:00:00.000Z',
    deliveryModel: 'flow',
    teamGoal: 'Keep flow cycle time under 3 days',
    hasExternalEvidence: true,
    proposedQuestions: [
      '#104 (Retry queue worker) has carried across 3 check-ins — can it wrap today, or is something blocking it?',
    ],
    multiDayArc: {
      sessionsAnalyzed: 3,
      summary:
        'Across 3 prior standups: 2 progress updates logged, carrying #104 (3d).',
      carryoverStreaks: [
        { workItemId: 104, title: 'Retry queue worker', daysCarried: 3 },
      ],
    },
    draftedItems: [
      {
        id: 'draft-yesterday-wi-101',
        bucket: 'yesterday',
        summary: '#101 API caching layer [Ready for Test]',
        workItemId: 101,
        evidence: 'ADO update — state [Ready for Test]',
        attribution: 'confirmed',
      },
      {
        id: 'draft-yesterday-wi-102',
        bucket: 'yesterday',
        summary: '#102 Token cleanup [Active]',
        workItemId: 102,
        evidence: 'ADO update — state [Active]',
        attribution: 'confirmed',
      },
      {
        id: 'draft-today-wi-104',
        bucket: 'today',
        summary: '#104 Retry queue worker [Active] (Carryover 3d)',
        workItemId: 104,
        evidence: 'Assigned to you',
        attribution: 'confirmed',
      },
    ],
    suggestedActivity: [
      {
        id: 'suggested-wi-199',
        bucket: 'yesterday',
        summary: '#199 Teammate ticket [Active]',
        source: 'ado',
        owner: 'Alex Rivera',
        workItemId: 199,
        attribution: 'suggested',
        reason: 'Assigned to Alex Rivera — you updated it',
      },
    ],
    accomplishedSinceLast: [],
    priorCommitments: [],
    suggestedToday: [],
    detectedExceptions: [
      {
        id: 'lag-104',
        kind: 'pr_merged_state_lag',
        severity: 'warning',
        message: 'PR !42 merged, but #104 (Retry queue worker) is still [In PR].',
        workItemId: 104,
        workItemTitle: 'Retry queue worker',
        prId: 42,
        proposedAction: {
          proposalType: 'state',
          fieldName: 'state',
          currentValue: 'In PR',
          proposedValue: 'Ready for Test',
          label: 'Advance #104 state to Ready for Test',
        },
      },
    ],
    openFollowups: [],
  },
  structuredUpdate: null,
  proposals: [],
};

describe('StandupCeremonyView Compact AI-Led Check-In', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('renders compact check-in without Standup Coach, keeps unowned items out of default draft, removes deselected chip, and submits', async () => {
    let capturedSubmitBody: {
      structuredUpdate?: Record<string, string>;
      proposals?: unknown[];
    } = {};

    global.fetch = jest.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/standup/my-session')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => seededAdoSession,
        } as Response);
      }
      if (
        url.includes('/participants/part-flow-1/submit') &&
        init?.method === 'POST'
      ) {
        capturedSubmitBody = JSON.parse(String(init.body ?? '{}'));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as Response);
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <StandupCeremonyView />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByTestId('standup-delivery-model-badge'),
    ).toHaveTextContent('Flow');

    // No Standup Coach chat button or panel
    expect(screen.queryByText(/discuss with coach/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/standup coach/i)).not.toBeInTheDocument();

    // AI prompt question is visible
    expect(screen.getByTestId('standup-ai-prompt-card')).toHaveTextContent(
      '#104 (Retry queue worker) has carried across 3 check-ins',
    );

    // Unowned item #199 is NOT pre-filled in yesterday draft
    const yesterdayField = screen.getByTestId(
      'standup-quick-yesterday',
    ) as HTMLTextAreaElement;
    expect(yesterdayField.value).toContain('#101');
    expect(yesterdayField.value).not.toContain('#199');

    // Remove #102 from personal check-in
    fireEvent.click(screen.getByTestId('draft-item-reject-draft-yesterday-wi-102'));
    expect(yesterdayField.value).not.toContain('#102');

    // Add optional note & stage optional proposal
    fireEvent.change(screen.getByTestId('standup-corrections-input'), {
      target: { value: 'Paired on auth smoke test' },
    });
    fireEvent.click(screen.getByTestId('standup-stage-proposal-lag-104'));

    fireEvent.click(screen.getByTestId('standup-quick-submit-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('standup-submitted-banner')).toBeInTheDocument();
    });

    expect(capturedSubmitBody.structuredUpdate?.yesterday).toContain('#101');
    expect(capturedSubmitBody.structuredUpdate?.yesterday).not.toContain('#102');
    expect(capturedSubmitBody.structuredUpdate?.yesterday).not.toContain('#199');
    expect(capturedSubmitBody.structuredUpdate?.userCorrections).toBe(
      'Paired on auth smoke test',
    );
    expect(capturedSubmitBody.proposals).toEqual([
      expect.objectContaining({
        workItemId: 104,
        proposalType: 'state',
        proposedValue: 'Ready for Test',
      }),
    ]);
  });

  it('supports generic teams with zero ADO evidence using AI-proposed prompts and plain-language answers', async () => {
    let capturedSubmitBody: {
      structuredUpdate?: Record<string, string>;
    } = {};

    const genericNoAdoSession = {
      ...seededAdoSession,
      participantId: 'part-generic-1',
      preparedBrief: {
        generatedAt: '2026-11-13T12:00:00.000Z',
        deliveryModel: 'flow',
        teamGoal: 'Launch Q4 partner onboarding',
        hasExternalEvidence: false,
        proposedQuestions: [
          'Last check-in you planned: “Finalize partner welcome email”. Did that finish, or does part of it carry into today?',
        ],
        draftedItems: [],
        suggestedActivity: [
          {
            id: 'suggested-history-prior-today',
            bucket: 'yesterday',
            summary: 'Finalize partner welcome email',
            source: 'history',
            attribution: 'suggested',
            reason: 'Planned in your previous check-in',
          },
        ],
        accomplishedSinceLast: [],
        priorCommitments: [],
        suggestedToday: [],
        detectedExceptions: [],
        openFollowups: [],
      },
    };

    global.fetch = jest.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/standup/my-session')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => genericNoAdoSession,
        } as Response);
      }
      if (
        url.includes('/participants/part-generic-1/submit') &&
        init?.method === 'POST'
      ) {
        capturedSubmitBody = JSON.parse(String(init.body ?? '{}'));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as Response);
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <StandupCeremonyView />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByTestId('standup-ai-prompt-card'),
    ).toHaveTextContent('Finalize partner welcome email');

    fireEvent.change(screen.getByTestId('standup-quick-yesterday'), {
      target: { value: 'Sent partner welcome email copy to marketing' },
    });
    fireEvent.change(screen.getByTestId('standup-quick-today'), {
      target: { value: 'Publish partner onboarding checklist' },
    });

    fireEvent.click(screen.getByTestId('standup-quick-submit-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('standup-submitted-banner')).toBeInTheDocument();
    });

    expect(capturedSubmitBody.structuredUpdate).toMatchObject({
      yesterday: 'Sent partner welcome email copy to marketing',
      today: 'Publish partner onboarding checklist',
      blockers: '',
    });
  });
});
