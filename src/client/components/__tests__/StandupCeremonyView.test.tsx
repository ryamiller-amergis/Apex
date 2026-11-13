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
    workDomains: ['backend', 'database'],
    multiDayArc: {
      sessionsAnalyzed: 3,
      summary: 'Across 3 prior standups: 2 progress updates logged, carrying #104 (3d).',
      carryoverStreaks: [
        { workItemId: 104, title: 'Retry queue worker', daysCarried: 3 },
      ],
    },
    recommendedFocus:
      'Close out multi-day carryover #104 (Retry queue worker, carried 3 standups) before starting net-new work.',
    draftedItems: [
      {
        id: 'draft-yesterday-wi-101',
        bucket: 'yesterday',
        summary: '#101 API caching layer [Ready for Test]',
        workItemId: 101,
        domain: 'backend',
        evidence: 'ADO update — state [Ready for Test]',
      },
      {
        id: 'draft-yesterday-wi-199',
        bucket: 'yesterday',
        summary: '#199 Legacy ticket reassigned only [Active]',
        workItemId: 199,
        domain: 'general',
        evidence: 'ADO update — state [Active]',
      },
      {
        id: 'draft-today-wi-104',
        bucket: 'today',
        summary: '#104 Retry queue worker [Active] (Carryover 3d)',
        workItemId: 104,
        domain: 'database',
        evidence: 'Assigned in ADO',
      },
    ],
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
        riskFlags: ['Carryover 3d', 'Stale 4d'],
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

describe('StandupCeremonyView Pre-Drafted Approve / Reject & Corrections (AC-02, AC-03)', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('renders multi-day arc, excludes rejected items, folds inline userCorrections, and stages proposals', async () => {
    let capturedSubmitBody: {
      structuredUpdate?: Record<string, string>;
      proposals?: unknown[];
    } = {};

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
    expect(screen.getByTestId('standup-multi-day-arc')).toHaveTextContent(
      'carrying #104 (3d)',
    );
    expect(screen.getByTestId('standup-recommended-focus')).toHaveTextContent(
      'Close out multi-day carryover #104',
    );

    // Reject inaccurate item #199
    fireEvent.click(screen.getByTestId('draft-item-reject-draft-yesterday-wi-199'));

    // Add an inline user correction
    fireEvent.change(screen.getByTestId('standup-corrections-input'), {
      target: { value: 'Also fixed flaky auth integration test not tracked in ADO' },
    });

    // Stage proposed state update
    fireEvent.click(screen.getByTestId('standup-stage-proposal-lag-104'));

    // Submit update
    fireEvent.click(screen.getByTestId('standup-quick-submit-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('standup-submitted-banner')).toBeInTheDocument();
    });

    expect(capturedSubmitBody.structuredUpdate?.yesterday).toContain('#101');
    expect(capturedSubmitBody.structuredUpdate?.yesterday).not.toContain('#199');
    expect(capturedSubmitBody.structuredUpdate?.userCorrections).toBe(
      'Also fixed flaky auth integration test not tracked in ADO',
    );
    expect(capturedSubmitBody.structuredUpdate?.approvalAction).toBe(
      'approved_with_edits',
    );
    expect(capturedSubmitBody.proposals).toEqual([
      expect.objectContaining({
        workItemId: 104,
        proposalType: 'state',
        proposedValue: 'Ready for Test',
      }),
    ]);
  });
});
