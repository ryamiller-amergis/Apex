import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HARNESS_AREA_IDS, type HarnessAreaId } from '../../../../shared/types/chatHarness';
import type {
  AgentActivityItem,
  HarnessReceiptView,
  HarnessTranscriptItem,
} from '../../../chatHarness/types';
import type { AgentChatSession } from '../../../hooks/useAgentChatSession';
import {
  AgentHarnessPanel,
  SlotErrorBoundary,
  type AgentHarnessPanelTestIds,
} from '../index';

function makeSession(overrides: Partial<AgentChatSession> = {}): Partial<AgentChatSession> {
  return {
    visibleMessages: [],
    streamingText: '',
    toolProgress: [],
    activity: [],
    connectionState: 'open',
    summaryNotice: null,
    lastReceipt: null,
    lastFailure: null,
    canWrite: true,
    isRunning: false,
    isSending: false,
    isCancelling: false,
    isAwaitingAgentResponse: false,
    isSteerSupported: true,
    isSummarizeSupported: true,
    send: jest.fn().mockResolvedValue(true),
    steer: jest.fn().mockResolvedValue(true),
    summarize: jest.fn().mockResolvedValue(true),
    cancel: jest.fn().mockResolvedValue(undefined),
    retryFailedRun: jest.fn().mockResolvedValue(undefined),
    clearReceipt: jest.fn(),
    retrySnapshot: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeReceipt(overrides: Partial<HarnessReceiptView>): HarnessReceiptView {
  return {
    commandId: 'cmd-1',
    kind: 'steer',
    status: 'applied',
    text: 'Steer sent',
    tone: 'info',
    autoDismissMs: 5_000,
    updatedAt: '2026-11-19T12:00:00.000Z',
    ...overrides,
  };
}

const SAMPLE_ITEMS: HarnessTranscriptItem[] = [
  {
    id: 'msg-u-1',
    role: 'user',
    text: 'Summarize the rollout plan.',
    ts: '2026-11-19T12:00:00.000Z',
  },
  {
    id: 'msg-a-1',
    role: 'agent',
    text: 'Here is the phased rollout plan.',
    ts: '2026-11-19T12:00:05.000Z',
    activity: [
      { id: 'th-1', kind: 'thinking', text: 'Checking rollout milestones' },
      { id: 'tl-1', kind: 'tool', toolName: 'read', status: 'completed', target: 'rollout.md' },
    ],
  },
  {
    id: 'msg-s-1',
    role: 'system',
    text: 'Conversation summary updated.',
    ts: '2026-11-19T12:00:10.000Z',
  },
];

const SAMPLE_LIVE_ACTIVITY: AgentActivityItem[] = [
  { id: 'live-th-1', kind: 'thinking', text: 'Inspecting project files' },
  {
    id: 'live-g-1',
    kind: 'tool-group',
    tools: [
      { id: 'c-1', toolName: 'read', status: 'running', target: 'spec.md' },
      { id: 'c-2', toolName: 'grep', status: 'completed', target: 'AgentHarnessPanel' },
    ],
  },
];

describe('SlotErrorBoundary (VT-30, TBI-019 DoD-2)', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('catches a child render error and renders an alert fallback with slot test id', () => {
    const Boom: React.FC = () => {
      throw new Error('Slot blew up');
    };

    render(
      <SlotErrorBoundary slotName="proposal">
        <Boom />
      </SlotErrorBoundary>,
    );

    const alert = screen.getByTestId('agent-slot-error-proposal');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('This section could not load.');
  });
});

describe('AgentHarnessPanel — VT-04 read-only enforcement (PBI-011 AC-3, PBI-013 AC-3, PBI-017 AC-4)', () => {
  it('shows live work box while running with canWrite=false and disables Send, Steer, Summarize, Stop, and input with read-only notice', () => {
    const session = makeSession({
      canWrite: false,
      isRunning: true,
      visibleMessages: SAMPLE_ITEMS.slice(0, 1),
      activity: SAMPLE_LIVE_ACTIVITY,
      toolProgress: [{ callId: 'c-1', toolName: 'read', status: 'running', ts: 1 }],
      progressPhase: 'analysis',
    });

    const { rerender } = render(
      <AgentHarnessPanel
        area="prd-assistant"
        session={session}
        testIdPrefix="prd-assistant"
      />,
    );

    expect(screen.getByTestId('prd-assistant-streaming')).toBeInTheDocument();
    expect(screen.getByTestId('prd-assistant-agent-progress')).toBeInTheDocument();
    expect(screen.getByTestId('prd-assistant-agent-busy')).toBeInTheDocument();
    expect(screen.getByTestId('prd-assistant-agent-thinking')).toHaveTextContent(
      'Inspecting project files',
    );

    expect(screen.getByTestId('prd-assistant-message-input')).toBeDisabled();
    expect(screen.getByTestId('prd-assistant-composer-steer')).toBeDisabled();
    expect(screen.queryByTestId('prd-assistant-composer-summarize')).not.toBeInTheDocument();
    expect(screen.getByTestId('prd-assistant-stop-btn')).toBeDisabled();
    expect(screen.getByTestId('prd-assistant-readonly-notice')).toHaveTextContent(
      'You have read-only access to this thread.',
    );

    rerender(
      <AgentHarnessPanel
        area="prd-assistant"
        session={{ ...session, isRunning: false }}
        testIdPrefix="prd-assistant"
      />,
    );

    expect(screen.getByTestId('prd-assistant-send-btn')).toBeDisabled();
    expect(screen.queryByTestId('prd-assistant-composer-summarize')).not.toBeInTheDocument();
    expect(screen.getByTestId('prd-assistant-readonly-notice')).toBeInTheDocument();
  });
});

describe('AgentHarnessPanel — VT-29 Brainstorm five slots & test ids (PBI-018 AC-0)', () => {
  it('renders all five slots with preserved brainstorm-* test ids and interactive mode picker', () => {
    const BrainstormHarnessDemo: React.FC = () => {
      const [mode, setMode] = useState<'explore' | 'adr'>('explore');
      return (
        <AgentHarnessPanel
          area="brainstorm"
          session={makeSession({ visibleMessages: SAMPLE_ITEMS })}
          testIdPrefix="brainstorm"
          testIds={{
            composer: 'brainstorm-composer',
            composerInput: 'brainstorm-composer-input',
            composerSend: 'brainstorm-composer-send',
            composerStop: 'brainstorm-composer-stop',
            streaming: 'brainstorm-streaming',
            progress: 'brainstorm-agent-progress',
            busy: 'brainstorm-agent-busy',
            thinking: 'brainstorm-agent-thinking',
            steps: 'brainstorm-agent-steps',
            toolGroup: 'brainstorm-tool-group',
          }}
          slots={{
            header: <div data-testid="brainstorm-header-content">Session Header</div>,
            sidePanel: <div data-testid="brainstorm-side-panel-content">Session Artifacts</div>,
            composerAccessory: (
              <div data-testid="brainstorm-composer-mode-badge">
                <button
                  type="button"
                  data-testid="brainstorm-composer-mode-trigger"
                  onClick={() => setMode((prev) => (prev === 'explore' ? 'adr' : 'explore'))}
                >
                  Mode: {mode}
                </button>
              </div>
            ),
            messageActions: (item) => (
              <button type="button" data-testid={`brainstorm-pin-${item.id}`}>
                Pin reply
              </button>
            ),
            proposal: <div data-testid="brainstorm-proposal-card">Draft brief ready</div>,
          }}
        />
      );
    };

    render(<BrainstormHarnessDemo />);

    expect(screen.getByTestId('brainstorm-slot-header')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-header-content')).toHaveTextContent('Session Header');
    expect(screen.getByTestId('brainstorm-slot-side-panel')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-side-panel-content')).toHaveTextContent('Session Artifacts');
    expect(screen.getByTestId('brainstorm-slot-composer-accessory')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-slot-proposal')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-proposal-card')).toHaveTextContent('Draft brief ready');
    expect(screen.getByTestId('brainstorm-pin-msg-a-1')).toBeInTheDocument();

    expect(screen.getByTestId('brainstorm-composer')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-composer-input')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-composer-send')).toBeInTheDocument();

    const modeTrigger = screen.getByTestId('brainstorm-composer-mode-trigger');
    expect(modeTrigger).toHaveTextContent('Mode: explore');
    fireEvent.click(modeTrigger);
    expect(modeTrigger).toHaveTextContent('Mode: adr');
  });
});

describe('AgentHarnessPanel — VT-30 slot error isolation (PBI-018 AC-2)', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('isolates a throwing slot without crashing sibling slots, transcript, or composer', () => {
    const sendSpy = jest.fn().mockResolvedValue(true);
    const BrokenSidePanel: React.FC = () => {
      throw new Error('Side panel render failure');
    };

    render(
      <AgentHarnessPanel
        area="adr"
        session={makeSession({ visibleMessages: SAMPLE_ITEMS, send: sendSpy })}
        testIdPrefix="adr"
        slots={{
          header: <div data-testid="adr-header-ok">ADR Header</div>,
          sidePanel: <BrokenSidePanel />,
          messageActions: () => {
            throw new Error('Action render failure');
          },
        }}
      />,
    );

    expect(screen.getByTestId('agent-slot-error-sidePanel')).toHaveTextContent(
      'This section could not load.',
    );
    expect(screen.getByTestId('agent-slot-error-messageActions')).toHaveTextContent(
      'This section could not load.',
    );

    expect(screen.getByTestId('adr-header-ok')).toHaveTextContent('ADR Header');
    expect(screen.getByText('Summarize the rollout plan.')).toBeInTheDocument();
    expect(screen.getByText('Here is the phased rollout plan.')).toBeInTheDocument();

    const input = screen.getByTestId('adr-message-input');
    fireEvent.change(input, { target: { value: 'Follow-up question' } });
    fireEvent.click(screen.getByTestId('adr-send-btn'));
    expect(sendSpy).toHaveBeenCalledWith('Follow-up question');
  });
});

describe('AgentHarnessPanel — VT-31 proposal slot never auto-approves writes (PBI-018 AC-1)', () => {
  it('renders a PRD diff proposal without invoking confirm until the user clicks Accept', () => {
    const confirmSpy = jest.fn();

    render(
      <AgentHarnessPanel
        area="prd-assistant"
        session={makeSession({ visibleMessages: SAMPLE_ITEMS })}
        testIdPrefix="prd-assistant"
        slots={{
          proposal: (
            <div data-testid="prd-diff-proposal">
              <p>Proposed PRD section update</p>
              <button
                type="button"
                data-testid="prd-diff-accept-btn"
                onClick={confirmSpy}
              >
                Accept
              </button>
            </div>
          ),
        }}
      />,
    );

    expect(screen.getByTestId('prd-assistant-slot-proposal')).toBeInTheDocument();
    expect(screen.getByTestId('prd-diff-proposal')).toHaveTextContent('Proposed PRD section update');
    expect(confirmSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('prd-diff-accept-btn'));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
  });
});

describe('AgentHarnessPanel — VT-43 all 12 harness areas preserve existing data-testid contracts', () => {
  interface AreaTestIdRow {
    area: HarnessAreaId;
    testIdPrefix: string;
    testIds?: AgentHarnessPanelTestIds;
    expectedIdleTestIds: string[];
    expectedRunningTestIds: string[];
  }

  const AREA_ROWS: AreaTestIdRow[] = [
    {
      area: 'agent-home',
      testIdPrefix: 'chat-agent',
      expectedIdleTestIds: [
        'chat-agent-harness-panel',
        'chat-agent-transcript',
        'chat-agent-composer',
        'chat-agent-message-input',
        'chat-agent-send-btn',
      ],
      expectedRunningTestIds: [
        'chat-agent-streaming',
        'chat-agent-agent-progress',
        'chat-agent-agent-busy',
        'chat-agent-stop-btn',
        'chat-agent-composer-steer',
      ],
    },
    {
      area: 'interview',
      testIdPrefix: 'interview',
      expectedIdleTestIds: [
        'interview-harness-panel',
        'interview-transcript',
        'interview-composer',
        'interview-message-input',
        'interview-send-btn',
      ],
      expectedRunningTestIds: [
        'interview-streaming',
        'interview-agent-progress',
        'interview-agent-busy',
        'interview-stop-btn',
        'interview-composer-steer',
      ],
    },
    {
      area: 'adr',
      testIdPrefix: 'adr',
      expectedIdleTestIds: [
        'adr-harness-panel',
        'adr-transcript',
        'adr-composer',
        'adr-message-input',
        'adr-send-btn',
      ],
      expectedRunningTestIds: [
        'adr-streaming',
        'adr-agent-progress',
        'adr-agent-busy',
        'adr-stop-btn',
        'adr-composer-steer',
      ],
    },
    {
      area: 'prd-assistant',
      testIdPrefix: 'prd-assistant',
      expectedIdleTestIds: [
        'prd-assistant-harness-panel',
        'prd-assistant-transcript',
        'prd-assistant-composer',
        'prd-assistant-message-input',
        'prd-assistant-send-btn',
      ],
      expectedRunningTestIds: [
        'prd-assistant-streaming',
        'prd-assistant-agent-progress',
        'prd-assistant-agent-busy',
        'prd-assistant-stop-btn',
        'prd-assistant-composer-steer',
      ],
    },
    {
      area: 'design-doc-assistant',
      testIdPrefix: 'design-doc-assistant',
      expectedIdleTestIds: [
        'design-doc-assistant-harness-panel',
        'design-doc-assistant-transcript',
        'design-doc-assistant-composer',
        'design-doc-assistant-message-input',
        'design-doc-assistant-send-btn',
      ],
      expectedRunningTestIds: [
        'design-doc-assistant-streaming',
        'design-doc-assistant-agent-progress',
        'design-doc-assistant-agent-busy',
        'design-doc-assistant-stop-btn',
        'design-doc-assistant-composer-steer',
      ],
    },
    {
      area: 'ask-apex',
      testIdPrefix: 'ask-apex',
      testIds: {
        composerInput: 'ask-apex-input',
        composerSend: 'ask-apex-send-button',
        retry: 'ask-apex-retry-button',
      },
      expectedIdleTestIds: [
        'ask-apex-harness-panel',
        'ask-apex-transcript',
        'ask-apex-composer',
        'ask-apex-input',
        'ask-apex-send-button',
      ],
      expectedRunningTestIds: [
        'ask-apex-streaming',
        'ask-apex-agent-progress',
        'ask-apex-stop-btn',
      ],
    },
    {
      area: 'calendar-work-item',
      testIdPrefix: 'calendar-assistant',
      expectedIdleTestIds: [
        'calendar-assistant-harness-panel',
        'calendar-assistant-transcript',
        'calendar-assistant-composer',
        'calendar-assistant-message-input',
        'calendar-assistant-send-btn',
      ],
      expectedRunningTestIds: [
        'calendar-assistant-streaming',
        'calendar-assistant-agent-progress',
        'calendar-assistant-stop-btn',
      ],
    },
    {
      area: 'qa-lab',
      testIdPrefix: 'qa-lab-assistant',
      expectedIdleTestIds: [
        'qa-lab-assistant-harness-panel',
        'qa-lab-assistant-transcript',
        'qa-lab-assistant-composer',
        'qa-lab-assistant-message-input',
        'qa-lab-assistant-send-btn',
      ],
      expectedRunningTestIds: [
        'qa-lab-assistant-streaming',
        'qa-lab-assistant-agent-progress',
        'qa-lab-assistant-stop-btn',
      ],
    },
    {
      area: 'brainstorm',
      testIdPrefix: 'brainstorm',
      testIds: {
        composer: 'brainstorm-composer',
        composerInput: 'brainstorm-composer-input',
        composerSend: 'brainstorm-composer-send',
        composerStop: 'brainstorm-composer-stop',
        streaming: 'brainstorm-streaming',
        progress: 'brainstorm-agent-progress',
        busy: 'brainstorm-agent-busy',
        thinking: 'brainstorm-agent-thinking',
        steps: 'brainstorm-agent-steps',
        toolGroup: 'brainstorm-tool-group',
      },
      expectedIdleTestIds: [
        'brainstorm-harness-panel',
        'brainstorm-transcript',
        'brainstorm-composer',
        'brainstorm-composer-input',
        'brainstorm-composer-send',
      ],
      expectedRunningTestIds: [
        'brainstorm-streaming',
        'brainstorm-agent-progress',
        'brainstorm-agent-busy',
        'brainstorm-agent-thinking',
        'brainstorm-agent-steps',
        'brainstorm-tool-group',
        'brainstorm-composer-stop',
      ],
    },
    {
      area: 'cab-release',
      testIdPrefix: 'cab-release-assistant',
      expectedIdleTestIds: [
        'cab-release-assistant-harness-panel',
        'cab-release-assistant-transcript',
        'cab-release-assistant-composer',
        'cab-release-assistant-message-input',
        'cab-release-assistant-send-btn',
      ],
      expectedRunningTestIds: [
        'cab-release-assistant-streaming',
        'cab-release-assistant-agent-progress',
        'cab-release-assistant-stop-btn',
      ],
    },
    {
      area: 'build-intake',
      testIdPrefix: 'build-intake',
      testIds: {
        root: 'build-intake-chat',
        retry: 'build-intake-retry',
      },
      expectedIdleTestIds: [
        'build-intake-chat',
        'build-intake-transcript',
        'build-intake-composer',
        'build-intake-message-input',
        'build-intake-send-btn',
      ],
      expectedRunningTestIds: [
        'build-intake-streaming',
        'build-intake-agent-progress',
        'build-intake-stop-btn',
      ],
    },
    {
      area: 'standup-participant',
      testIdPrefix: 'standup',
      expectedIdleTestIds: [
        'standup-harness-panel',
        'standup-transcript',
        'standup-composer',
        'standup-message-input',
        'standup-send-btn',
      ],
      expectedRunningTestIds: [
        'standup-streaming',
        'standup-agent-progress',
        'standup-stop-btn',
      ],
    },
  ];

  it('covers all 12 HARNESS_AREA_IDS exhaustively', () => {
    expect(AREA_ROWS.map((r) => r.area)).toEqual([...HARNESS_AREA_IDS]);
  });

  it.each(AREA_ROWS)(
    'preserves data-testid contract exactly once for area "$area"',
    ({ area, testIdPrefix, testIds, expectedIdleTestIds, expectedRunningTestIds }) => {
      const { rerender } = render(
        <AgentHarnessPanel
          area={area}
          session={makeSession({ visibleMessages: SAMPLE_ITEMS })}
          testIdPrefix={testIdPrefix}
          testIds={testIds}
        />,
      );

      for (const id of expectedIdleTestIds) {
        expect(screen.getAllByTestId(id)).toHaveLength(1);
      }

      rerender(
        <AgentHarnessPanel
          area={area}
          session={makeSession({
            visibleMessages: SAMPLE_ITEMS,
            isRunning: true,
            activity: SAMPLE_LIVE_ACTIVITY,
          })}
          testIdPrefix={testIdPrefix}
          testIds={testIds}
        />,
      );

      for (const id of expectedRunningTestIds) {
        expect(screen.getAllByTestId(id)).toHaveLength(1);
      }
    },
  );
});

describe('AgentHarnessPanel — signed-out, loading, load error, draft/receipt lifecycle, and message IDs', () => {
  it('hides transcript completely and shows sign-in banner when connectionState is signed-out', () => {
    const onSignIn = jest.fn();
    render(
      <AgentHarnessPanel
        area="agent-home"
        session={makeSession({
          connectionState: 'signed-out',
          visibleMessages: SAMPLE_ITEMS,
        })}
        testIdPrefix="chat-agent"
        onSignIn={onSignIn}
      />,
    );

    expect(screen.getByTestId('chat-agent-connection-banner')).toHaveTextContent(
      'Your session expired. Sign in again to continue.',
    );
    expect(screen.queryByTestId('chat-agent-transcript')).not.toBeInTheDocument();
    expect(screen.queryByText('Summarize the rollout plan.')).not.toBeInTheDocument();
    expect(screen.queryByText('Here is the phased rollout plan.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chat-agent-connection-banner-signin'));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it('shows load error copy and invokes retry handler when Try again is clicked', () => {
    const onRetryLoad = jest.fn();
    render(
      <AgentHarnessPanel
        area="interview"
        session={makeSession({ visibleMessages: [] })}
        testIdPrefix="interview"
        loadError="Snapshot failed"
        onRetryLoad={onRetryLoad}
      />,
    );

    expect(screen.getByText('We could not load the conversation.')).toBeInTheDocument();
    const retryBtn = screen.getByTestId('interview-snapshot-retry');
    expect(retryBtn).toHaveTextContent('Try again');
    fireEvent.click(retryBtn);
    expect(onRetryLoad).toHaveBeenCalledTimes(1);
  });

  it('renders an aria-busy loading skeleton while snapshot is explicitly loading', () => {
    render(
      <AgentHarnessPanel
        area="interview"
        session={makeSession({ snapshotLoaded: false, visibleMessages: [] })}
        testIdPrefix="interview"
      />,
    );

    const skeleton = screen.getByTestId('interview-loading');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
  });

  it('keeps steer draft on rejected (steer_cap), clears rejected receipt on edit, and clears draft on applied', async () => {
    const steerSpy = jest.fn().mockResolvedValue(false);
    const clearReceiptSpy = jest.fn();
    const baseSession = makeSession({
      isRunning: true,
      canWrite: true,
      isSteerSupported: true,
      steer: steerSpy,
      clearReceipt: clearReceiptSpy,
      lastReceipt: null,
    });

    const { rerender } = render(
      <AgentHarnessPanel
        area="adr"
        session={baseSession}
        testIdPrefix="adr"
      />,
    );

    const input = screen.getByTestId('adr-message-input');
    fireEvent.change(input, { target: { value: 'Prioritize security risks' } });
    fireEvent.click(screen.getByTestId('adr-composer-steer'));

    await waitFor(() => {
      expect(steerSpy).toHaveBeenCalledWith('Prioritize security risks');
    });

    // Draft stays intact until receipt arrives
    expect(input).toHaveValue('Prioritize security risks');

    // Rejected receipt (steer_cap) preserves draft
    rerender(
      <AgentHarnessPanel
        area="adr"
        session={{
          ...baseSession,
          lastReceipt: makeReceipt({
            commandId: 'cmd-reject',
            kind: 'steer',
            status: 'rejected',
            reason: 'steer_cap',
            text: 'Wait for this step to finish',
            tone: 'error',
          }),
        }}
        testIdPrefix="adr"
      />,
    );

    expect(screen.getByTestId('adr-composer-receipt')).toHaveTextContent(
      'Wait for this step to finish',
    );
    expect(input).toHaveValue('Prioritize security risks');

    // Editing draft clears rejected receipt
    fireEvent.change(input, { target: { value: 'Prioritize security risks now' } });
    expect(clearReceiptSpy).toHaveBeenCalledTimes(1);

    // Resend steer and receive applied receipt -> clears draft
    steerSpy.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByTestId('adr-composer-steer'));

    await waitFor(() => {
      expect(steerSpy).toHaveBeenCalledWith('Prioritize security risks now');
    });

    rerender(
      <AgentHarnessPanel
        area="adr"
        session={{
          ...baseSession,
          lastReceipt: makeReceipt({
            commandId: 'cmd-apply',
            kind: 'steer',
            status: 'applied',
            text: 'Steer sent',
            tone: 'info',
          }),
        }}
        testIdPrefix="adr"
      />,
    );

    await waitFor(() => {
      expect(input).toHaveValue('');
    });
  });

  it('renders data-message-id attributes on user, agent, and system messages in default transcript', () => {
    const { container } = render(
      <AgentHarnessPanel
        area="adr"
        session={makeSession({ visibleMessages: SAMPLE_ITEMS })}
        testIdPrefix="adr"
      />,
    );

    expect(container.querySelector('[data-message-id="msg-u-1"]')).toBeInTheDocument();
    expect(container.querySelector('[data-message-id="msg-a-1"]')).toBeInTheDocument();
    expect(container.querySelector('[data-message-id="msg-s-1"]')).toBeInTheDocument();
    expect(screen.getByTestId('adr-thought-process')).toBeInTheDocument();
  });

  it('shows retryReason inside the unified live work box and clears back to live progress once retrying ends', () => {
    const { rerender } = render(
      <AgentHarnessPanel
        area="agent-home"
        session={makeSession({
          isRunning: true,
          isRetrying: true,
          retryReason: 'Reconnecting to the agent…',
          progressPhase: 'analysis',
          progressLabel: 'Thinking…',
        })}
        testIdPrefix="chat-agent"
        testIds={{ progressLabel: 'chat-agent-progress-label' }}
      />,
    );

    expect(screen.getByTestId('chat-agent-progress-label')).toHaveTextContent(
      'Reconnecting to the agent…',
    );

    rerender(
      <AgentHarnessPanel
        area="agent-home"
        session={makeSession({
          isRunning: true,
          isRetrying: false,
          retryReason: null,
          progressPhase: 'analysis',
          progressLabel: 'Thinking…',
          activity: [{ id: 't-1', kind: 'thinking', text: 'Inspecting workspace' }],
        })}
        testIdPrefix="chat-agent"
        testIds={{ progressLabel: 'chat-agent-progress-label' }}
      />,
    );

    expect(screen.getByTestId('chat-agent-progress-label')).toHaveTextContent('Thinking…');
    expect(screen.getByTestId('chat-agent-agent-thinking')).toHaveTextContent(
      'Inspecting workspace',
    );
  });
});
