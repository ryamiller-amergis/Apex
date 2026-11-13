import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { StandupCeremonyView } from '../StandupCeremonyView';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

jest.mock('remark-gfm', () => () => undefined);

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    can: () => true,
    selectedProject: 'MaxView',
    selectedAreaPath: 'MaxView',
  }),
}));

jest.mock('../../hooks/useChatThreads', () => ({
  useChatThread: () => ({ data: { messages: [], status: 'idle' } }),
}));

jest.mock('../../hooks/useAgentChatSession', () => ({
  useAgentChatSession: () => ({
    messages: [],
    streamingText: '',
    thinkingText: '',
    isRetrying: false,
    retryReason: null,
    isRunning: false,
    status: 'idle',
    showTypingIndicator: false,
    send: jest.fn().mockResolvedValue(true),
  }),
}));

jest.mock('../../hooks/useChatAttachments', () => ({
  useChatAttachments: () => ({
    attachments: [],
    attachmentError: null,
    addFiles: jest.fn(),
    removeAttachment: jest.fn(),
    clearAttachments: jest.fn(),
  }),
}));

jest.mock('../../hooks/useSpeechInput', () => ({
  useSpeechInput: () => ({
    isListening: false,
    isSpeechSupported: false,
    speechError: null,
    toggle: jest.fn(),
    stop: jest.fn(),
  }),
}));

const seededMySession = {
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
    accomplishedSinceLast: [
      {
        workItemId: 101,
        title: 'API caching layer',
        workItemType: 'Product Backlog Item',
        state: 'Ready for Test',
        evidence: 'ADO update — state [Ready for Test]',
      },
    ],
    priorCommitments: [
      {
        summary: '#104 Retry queue worker',
        workItemIds: [104],
        status: 'untouched',
        note: 'No ADO state change or PR activity recorded since last standup',
      },
    ],
    suggestedToday: [
      {
        workItemId: 104,
        title: 'Retry queue worker',
        workItemType: 'Task',
        state: 'Active',
        targetDate: null,
        iterationPath: null,
        riskFlags: ['Carryover', 'Stale 4d'],
      },
    ],
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

describe('StandupCeremonyView Quick Confirm (AC-01, AC-02, AC-03)', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('renders Quick Confirm brief, commitment carryover, opt-in proposal staging, and submits in one click', async () => {
    let capturedSubmitBody: Record<string, unknown> | null = null;

    global.fetch = jest.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/standup/my-session')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => seededMySession,
        } as Response);
      }
      if (url.includes('/participants/part-flow-1/submit') && init?.method === 'POST') {
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

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <StandupCeremonyView />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('standup-delivery-model-badge')).toHaveTextContent(
      'Flow',
    );
    expect(screen.getByTestId('standup-team-goal')).toHaveTextContent(
      'Keep flow cycle time under 3 days',
    );
    expect(screen.getByTestId('standup-commitment-status-0')).toHaveTextContent(
      'Carryover',
    );

    // Stage the proposed state update
    fireEvent.click(screen.getByTestId('standup-stage-proposal-lag-104'));

    // Submit Quick Confirm
    fireEvent.click(screen.getByTestId('standup-quick-submit-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('standup-submitted-banner')).toBeInTheDocument();
    });

    expect(capturedSubmitBody).toMatchObject({
      structuredUpdate: expect.objectContaining({
        yesterday: expect.stringContaining('#101'),
        today: expect.stringContaining('#104'),
      }),
      proposals: [
        expect.objectContaining({
          workItemId: 104,
          proposalType: 'state',
          proposedValue: 'Ready for Test',
        }),
      ],
    });
  });
});
