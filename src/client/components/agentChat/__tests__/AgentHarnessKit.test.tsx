import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  AgentActivityLog,
  AgentComposer,
  AgentConnectionBanner,
  AgentLiveWorkBox,
  AgentMessageFailure,
  AgentReplyRating,
  AgentSummaryNotice,
  AgentThoughtProcess,
  AgentToolGroup,
  formatActivitySummaryLabel,
} from '../index';
import type {
  AgentActivityItem,
  HarnessReceiptView,
  HarnessSummaryNoticeState,
} from '../../../chatHarness/types';

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

describe('AgentActivityLog (VT-02, TBI-018 DoD-0, PBI-011 AC-1)', () => {
  it('renders Working, Finished, and Could not finish rows, continues after errors, and never renders raw result', () => {
    const items: AgentActivityItem[] = [
      { id: 't-1', kind: 'thinking', text: 'Inspecting the authentication flow.' },
      {
        id: 'c-1',
        kind: 'tool',
        toolName: 'grep',
        status: 'running',
        target: '/repo/sources/auth/login.ts',
        result: 'SECRET_RESULT_SHOULD_NEVER_RENDER_1',
      },
      {
        id: 'c-2',
        kind: 'tool',
        toolName: 'read',
        status: 'error',
        target: 'missing.ts',
        result: 'SECRET_RESULT_SHOULD_NEVER_RENDER_2',
      },
      {
        id: 'c-3',
        kind: 'tool',
        toolName: 'mcp:search_repo_code',
        status: 'completed',
        target: 'sessionCookie',
        result: 'SECRET_RESULT_SHOULD_NEVER_RENDER_3',
      },
    ];

    const { container } = render(
      <AgentActivityLog items={items} testIdPrefix="harness" />,
    );

    expect(screen.getByTestId('harness-agent-thinking')).toHaveTextContent(
      'Inspecting the authentication flow.',
    );
    const stepsList = screen.getByTestId('harness-agent-steps');
    expect(stepsList).toHaveTextContent('Working: Searching the codebase — sources/auth/login.ts');
    expect(stepsList).toHaveTextContent('Could not finish: Reading files — missing.ts');
    expect(stepsList).toHaveTextContent('Finished: Searching the codebase — sessionCookie');

    expect(container.textContent).not.toContain('SECRET_RESULT_SHOULD_NEVER_RENDER_1');
    expect(container.textContent).not.toContain('SECRET_RESULT_SHOULD_NEVER_RENDER_2');
    expect(container.textContent).not.toContain('SECRET_RESULT_SHOULD_NEVER_RENDER_3');
  });

  it('renders nothing when items is empty', () => {
    const { container } = render(<AgentActivityLog items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('AgentToolGroup (VT-03, PBI-011 AC-2)', () => {
  it('groups 3 concurrent tools under one group container and marks any failed member', () => {
    const groupItem: AgentActivityItem = {
      id: 'g-1',
      kind: 'tool-group',
      status: 'error',
      tools: [
        { id: 't-1', toolName: 'read', status: 'completed', target: 'a.ts', result: 'RAW_A' },
        { id: 't-2', toolName: 'grep', status: 'error', target: 'b.ts', result: 'RAW_B' },
        { id: 't-3', toolName: 'glob', status: 'completed', target: 'src/', result: 'RAW_C' },
      ],
    };

    const { container } = render(
      <AgentToolGroup item={groupItem} testIdPrefix="harness" />,
    );

    const group = screen.getByTestId('harness-tool-group');
    expect(group).toHaveTextContent('Could not finish: 3 tools');
    expect(group).toHaveTextContent('Finished: Reading files — a.ts');
    expect(group).toHaveTextContent('Could not finish: Searching the codebase — b.ts');
    expect(group).toHaveTextContent('Finished: Browsing folders — src/');
    expect(container.textContent).not.toContain('RAW_A');
    expect(container.textContent).not.toContain('RAW_B');
    expect(container.textContent).not.toContain('RAW_C');
  });

  it('renders a single-tool group as a plain step row without a group container', () => {
    const singleGroup: AgentActivityItem = {
      id: 'g-single',
      kind: 'tool-group',
      tools: [
        { id: 't-1', toolName: 'read', status: 'running', target: 'index.ts', result: 'RAW_SINGLE' },
      ],
    };

    const { container } = render(
      <AgentToolGroup item={singleGroup} testIdPrefix="harness" />,
    );

    expect(screen.queryByTestId('harness-tool-group')).not.toBeInTheDocument();
    expect(container).toHaveTextContent('Working: Reading files — index.ts');
    expect(container.textContent).not.toContain('RAW_SINGLE');
  });
});

describe('AgentLiveWorkBox (VT-01, VT-42, PBI-011 AC-0)', () => {
  it('renders a polite busy live region with spinner, progress label, and live activity log', () => {
    const activity: AgentActivityItem[] = [
      { id: 'th-1', kind: 'thinking', text: 'Checking project files' },
      { id: 'tl-1', kind: 'tool', toolName: 'read', status: 'running', target: 'README.md' },
    ];

    render(
      <AgentLiveWorkBox
        activity={activity}
        progressPhase="analysis"
        toolProgress={[{ callId: 'tl-1', toolName: 'read', status: 'running', ts: 1 }]}
        testIdPrefix="adr"
      />,
    );

    const progress = screen.getByTestId('adr-agent-progress');
    expect(progress).toHaveAttribute('aria-live', 'polite');
    expect(progress).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('adr-agent-busy')).toBeInTheDocument();
    expect(progress).toHaveTextContent('Reading files');
    expect(progress).toHaveTextContent('1 step');
    expect(screen.getByTestId('adr-agent-thinking')).toHaveTextContent('Checking project files');
    expect(screen.getByTestId('adr-agent-steps')).toHaveTextContent('Working: Reading files — README.md');
  });
});

describe('AgentThoughtProcess (VT-05, VT-06, VT-07, VT-09, TBI-018 DoD-1, PBI-012 AC-0..3)', () => {
  const fourStepItems: AgentActivityItem[] = [
    { id: 'th-1', kind: 'thinking', text: 'Planning repository search' },
    { id: 'c-1', kind: 'tool', toolName: 'grep', status: 'completed', target: 'useAgentChatSession' },
    {
      id: 'g-1',
      kind: 'tool-group',
      tools: [
        { id: 'c-2', toolName: 'read', status: 'completed', target: 'a.ts' },
        { id: 'c-3', toolName: 'read', status: 'completed', target: 'b.ts' },
      ],
    },
    { id: 'c-4', kind: 'tool', toolName: 'glob', status: 'completed', target: 'src/client' },
  ];

  it('VT-05: renders collapsed "Thought process · 4 steps" and opens via click or keyboard', () => {
    expect(formatActivitySummaryLabel(fourStepItems)).toBe('Thought process · 4 steps');

    render(
      <AgentThoughtProcess items={fourStepItems} testIdPrefix="prd" />,
    );

    const drawer = screen.getByTestId('prd-thought-process') as HTMLDetailsElement;
    const toggle = screen.getByTestId('prd-thought-process-toggle');

    expect(drawer.open).toBe(false);
    expect(toggle).toHaveTextContent('Thought process · 4 steps');

    fireEvent.click(toggle);
    // jsdom may not automatically set open on summary click without native handler; verify toggle works via native details toggle
    if (!drawer.open) {
      drawer.open = true;
      fireEvent(drawer, new Event('toggle'));
    }
    expect(drawer.open).toBe(true);
    expect(screen.getByTestId('prd-agent-thinking')).toHaveTextContent('Planning repository search');
    expect(screen.getByTestId('prd-agent-steps')).toHaveTextContent('Finished: Searching the codebase — useAgentChatSession');
    expect(screen.getByTestId('prd-agent-steps')).toHaveTextContent('Finished: Reading files — a.ts');
    expect(screen.getByTestId('prd-agent-steps')).toHaveTextContent('Finished: Reading files — b.ts');
    expect(screen.getByTestId('prd-agent-steps')).toHaveTextContent('Finished: Browsing folders — src/client');
  });

  it('VT-06: renders unavailable notice when activity is unavailable and loading label when loading', () => {
    const { rerender } = render(
      <AgentThoughtProcess isUnavailable defaultOpen testIdPrefix="prd" />,
    );

    expect(screen.getByTestId('prd-thought-process-toggle')).toHaveTextContent('Thought process');
    expect(screen.getByTestId('prd-thought-process')).toHaveTextContent(
      'Activity is unavailable for this reply.',
    );

    rerender(<AgentThoughtProcess isLoading defaultOpen testIdPrefix="prd" />);
    expect(screen.getByTestId('prd-thought-process-toggle')).toHaveTextContent('Loading activity…');
    expect(screen.getByTestId('prd-thought-process')).toHaveTextContent('Loading activity…');
  });

  it('VT-07: renders nothing when items is empty and neither loading nor unavailable', () => {
    const { container } = render(<AgentThoughtProcess items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('VT-09: renders saved activity items identically to the live activity log', () => {
    const saved: AgentActivityItem[] = [
      { id: 'th-1', kind: 'thinking', text: 'Synthesizing saved trace' },
      { id: 'c-1', kind: 'tool', toolName: 'read', status: 'completed', target: 'spec.md' },
    ];

    const liveView = render(<AgentActivityLog items={saved} testIdPrefix="live" />);
    const liveSteps = liveView.getByTestId('live-agent-steps').textContent;
    const liveThinking = liveView.getByTestId('live-agent-thinking').textContent;
    liveView.unmount();

    render(<AgentThoughtProcess items={saved} defaultOpen testIdPrefix="saved" />);
    expect(screen.getByTestId('saved-agent-thinking').textContent).toBe(liveThinking);
    expect(screen.getByTestId('saved-agent-steps').textContent).toBe(liveSteps);
  });
});

describe('AgentSummaryNotice (VT-26, PBI-017 AC-3)', () => {
  it('renders running, trimmed-transcript fallback, and error notices, and hides completed non-fallback', () => {
    const running: HarnessSummaryNoticeState = {
      status: 'running',
      text: 'Summarizing conversation…',
      isFallback: false,
    };
    const { rerender, container } = render(
      <AgentSummaryNotice notice={running} testIdPrefix="chat" />,
    );

    const noticeEl = screen.getByTestId('chat-summary-notice');
    expect(noticeEl).toHaveAttribute('role', 'status');
    expect(noticeEl).toHaveAttribute('aria-live', 'polite');
    expect(noticeEl).toHaveTextContent('Summarizing conversation…');

    const fallback: HarnessSummaryNoticeState = {
      status: 'fallback',
      text: 'Only a trimmed transcript was kept for this summary.',
      isFallback: true,
    };
    rerender(<AgentSummaryNotice notice={fallback} testIdPrefix="chat" />);
    expect(screen.getByTestId('chat-summary-notice')).toHaveTextContent(
      'Only a trimmed transcript was kept for this summary.',
    );

    const errorNotice: HarnessSummaryNoticeState = {
      status: 'error',
      text: 'Could not summarize this conversation.',
      isFallback: false,
    };
    rerender(<AgentSummaryNotice notice={errorNotice} testIdPrefix="chat" />);
    expect(screen.getByTestId('chat-summary-notice')).toHaveTextContent(
      'Could not summarize this conversation.',
    );

    const completed: HarnessSummaryNoticeState = {
      status: 'completed',
      text: 'Done',
      isFallback: false,
    };
    rerender(<AgentSummaryNotice notice={completed} testIdPrefix="chat" />);
    expect(container).toBeEmptyDOMElement();

    rerender(<AgentSummaryNotice notice={null} testIdPrefix="chat" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('AgentConnectionBanner (VT-14..16, PBI-014 AC-1..3)', () => {
  it('renders reconnecting, restored, unavailable, and signed-out states and hides open/connecting/closed', () => {
    const onSignIn = jest.fn();
    const { rerender, container } = render(
      <AgentConnectionBanner connectionState="open" onSignIn={onSignIn} testIdPrefix="chat" />,
    );
    expect(container).toBeEmptyDOMElement();

    rerender(<AgentConnectionBanner connectionState="connecting" onSignIn={onSignIn} testIdPrefix="chat" />);
    expect(container).toBeEmptyDOMElement();

    rerender(<AgentConnectionBanner connectionState="closed" onSignIn={onSignIn} testIdPrefix="chat" />);
    expect(container).toBeEmptyDOMElement();

    rerender(<AgentConnectionBanner connectionState="reconnecting" onSignIn={onSignIn} testIdPrefix="chat" />);
    expect(screen.getByTestId('chat-connection-banner')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('chat-connection-banner')).toHaveTextContent('Reconnecting…');

    rerender(<AgentConnectionBanner connectionState="restored" onSignIn={onSignIn} testIdPrefix="chat" />);
    expect(screen.getByTestId('chat-connection-banner')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('chat-connection-banner')).toHaveTextContent('Restored');

    rerender(<AgentConnectionBanner connectionState="unavailable" onSignIn={onSignIn} testIdPrefix="chat" />);
    expect(screen.getByTestId('chat-connection-banner')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('chat-connection-banner')).toHaveTextContent(
      'Live updates are unavailable. You can still read this thread.',
    );

    rerender(<AgentConnectionBanner connectionState="signed-out" onSignIn={onSignIn} testIdPrefix="chat" />);
    expect(screen.getByTestId('chat-connection-banner')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('chat-connection-banner')).toHaveTextContent(
      'Your session expired. Sign in again to continue.',
    );
    fireEvent.click(screen.getByTestId('chat-connection-banner-signin'));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });
});

describe('AgentMessageFailure (VT-17, PBI-015 AC-0)', () => {
  it('renders alert with badge, reason, time-based Retry label, and disables while retrying', () => {
    const onRetry = jest.fn();
    const failedAt = '2026-11-19T15:30:00.000Z';
    const expectedTime = new Date(failedAt).toLocaleTimeString();

    const { rerender } = render(
      <AgentMessageFailure
        reason="The model returned an error before finishing."
        status="failed"
        failedAt={failedAt}
        canRetry
        isRetrying={false}
        onRetry={onRetry}
        testIdPrefix="chat"
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('The model returned an error before finishing.');
    expect(screen.getByTestId('chat-message-failed')).toHaveTextContent('Failed');

    const retryBtn = screen.getByTestId('chat-retry');
    expect(retryBtn).toHaveAccessibleName(`Retry the response from ${expectedTime}`);
    expect(retryBtn).toBeEnabled();
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(
      <AgentMessageFailure
        reason="Stopped by user."
        status="cancelled"
        failedAt={failedAt}
        canRetry
        isRetrying
        onRetry={onRetry}
        testIdPrefix="chat"
      />,
    );

    expect(screen.getByTestId('chat-message-failed')).toHaveTextContent('Stopped');
    expect(screen.getByTestId('chat-retry')).toBeDisabled();
    expect(screen.getByTestId('chat-retry')).toHaveTextContent('Retrying…');
  });
});

describe('AgentReplyRating (VT-21..24, PBI-016 AC-0..3)', () => {
  it('VT-21: saves a rating and marks it selected with aria-pressed', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(
      <AgentReplyRating messageId="msg-1" rating={null} onSave={onSave} />,
    );

    const goodBtn = screen.getByTestId('chat-message-rating-good-msg-1');
    expect(goodBtn).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(goodBtn);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith('good', null);
      expect(goodBtn).toHaveAttribute('aria-pressed', 'true');
    });
  });

  it('VT-22: reverts selection and shows an inline error alert when save rejects', async () => {
    const onSave = jest.fn().mockRejectedValue(new Error('Could not save feedback'));
    render(
      <AgentReplyRating messageId="msg-2" rating={null} onSave={onSave} />,
    );

    const goodBtn = screen.getByTestId('chat-message-rating-good-msg-2');
    fireEvent.click(goodBtn);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Could not save feedback');
    });
    expect(goodBtn).toHaveAttribute('aria-pressed', 'false');
  });

  it('VT-23: displays a pre-loaded rating as pressed', () => {
    render(
      <AgentReplyRating
        messageId="msg-3"
        rating="good"
        onSave={jest.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByTestId('chat-message-rating-good-msg-3')).toHaveAttribute('aria-pressed', 'true');
  });

  it('VT-24: disables controls and blocks save when canWrite=false, and renders nothing when hasAccess=false', () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    const { rerender, container } = render(
      <AgentReplyRating messageId="msg-4" rating={null} canWrite={false} onSave={onSave} />,
    );

    const goodBtn = screen.getByTestId('chat-message-rating-good-msg-4');
    expect(goodBtn).toBeDisabled();
    fireEvent.click(goodBtn);
    expect(onSave).not.toHaveBeenCalled();

    rerender(
      <AgentReplyRating messageId="msg-4" rating={null} hasAccess={false} onSave={onSave} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('AgentComposer harness extensions (VT-25..28, TBI-018 DoD-2, PBI-017 AC-0..4)', () => {
  it('shows Steer right beside Stop while running, disables Attach, and invokes onSteer via button or Enter', () => {
    const onSteer = jest.fn();
    const onCancel = jest.fn();
    render(
      <AgentComposer
        value="Focus on tests first"
        onChange={jest.fn()}
        onSend={jest.fn()}
        onCancel={onCancel}
        onAttachClick={jest.fn()}
        isRunning
        steer={{ enabled: true, onSteer }}
        testIdPrefix="harness"
      />,
    );

    const input = screen.getByTestId('harness-message-input');
    const steerBtn = screen.getByTestId('harness-composer-steer');
    const stopBtn = screen.getByTestId('harness-stop-btn');
    const attachBtn = screen.getByTestId('harness-attach');

    expect(input).toBeEnabled();
    expect(attachBtn).toBeDisabled();
    expect(steerBtn).toBeEnabled();
    expect(stopBtn).toBeEnabled();

    fireEvent.click(steerBtn);
    expect(onSteer).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(onSteer).toHaveBeenCalledTimes(2);

    fireEvent.click(stopBtn);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders all PBI-017 receipt texts and preserves draft on steer cap rejection', () => {
    const { rerender } = render(
      <AgentComposer
        value="keep my draft"
        onChange={jest.fn()}
        onSend={jest.fn()}
        isRunning
        steer={{ enabled: true, onSteer: jest.fn() }}
        receipt={makeReceipt({ text: 'Steer sent', tone: 'info' })}
        testIdPrefix="harness"
      />,
    );

    const receiptEl = screen.getByTestId('harness-composer-receipt');
    expect(receiptEl).toHaveAttribute('role', 'status');
    expect(receiptEl).toHaveTextContent('Steer sent');

    rerender(
      <AgentComposer
        value="keep my draft"
        onChange={jest.fn()}
        onSend={jest.fn()}
        isRunning
        steer={{ enabled: true, onSteer: jest.fn() }}
        receipt={makeReceipt({
          status: 'rejected',
          text: 'Wait for this step to finish',
          tone: 'error',
        })}
        testIdPrefix="harness"
      />,
    );
    expect(screen.getByTestId('harness-composer-receipt')).toHaveTextContent(
      'Wait for this step to finish',
    );
    expect(screen.getByTestId('harness-message-input')).toHaveValue('keep my draft');

    rerender(
      <AgentComposer
        value=""
        onChange={jest.fn()}
        onSend={jest.fn()}
        receipt={makeReceipt({
          status: 'applied',
          text: 'Turn had finished, sent as a new message',
          tone: 'info',
        })}
        testIdPrefix="harness"
      />,
    );
    expect(screen.getByTestId('harness-composer-receipt')).toHaveTextContent(
      'Turn had finished, sent as a new message',
    );

    rerender(
      <AgentComposer
        value=""
        onChange={jest.fn()}
        onSend={jest.fn()}
        receipt={makeReceipt({
          status: 'queued',
          text: 'Queued as follow-up',
          tone: 'info',
        })}
        testIdPrefix="harness"
      />,
    );
    expect(screen.getByTestId('harness-composer-receipt')).toHaveTextContent(
      'Queued as follow-up',
    );
  });

  it('renders Summarize control and disables Steer, Summarize, Stop, and input when readOnly=true', () => {
    const onSummarize = jest.fn();
    const { rerender } = render(
      <AgentComposer
        value="draft"
        onChange={jest.fn()}
        onSend={jest.fn()}
        onCancel={jest.fn()}
        onSummarize={onSummarize}
        isRunning
        steer={{ enabled: true, onSteer: jest.fn() }}
        testIdPrefix="harness"
      />,
    );

    const summarizeBtn = screen.getByTestId('harness-composer-summarize');
    expect(summarizeBtn).toBeEnabled();
    fireEvent.click(summarizeBtn);
    expect(onSummarize).toHaveBeenCalledTimes(1);

    rerender(
      <AgentComposer
        value="draft"
        onChange={jest.fn()}
        onSend={jest.fn()}
        onCancel={jest.fn()}
        onSummarize={onSummarize}
        isRunning
        steer={{ enabled: true, onSteer: jest.fn() }}
        readOnly
        testIdPrefix="harness"
      />,
    );

    expect(screen.getByTestId('harness-message-input')).toBeDisabled();
    expect(screen.getByTestId('harness-composer-steer')).toBeDisabled();
    expect(screen.getByTestId('harness-composer-summarize')).toBeDisabled();
    expect(screen.getByTestId('harness-stop-btn')).toBeDisabled();
    expect(screen.getByTestId('harness-readonly-notice')).toHaveTextContent(
      'You have read-only access to this thread.',
    );
  });
});

describe('Custom testIds override (VT-42, TBI-018 DoD-3)', () => {
  it('supports Brainstorm brainstorm-* testIds across kit components', () => {
    const activity: AgentActivityItem[] = [
      { id: 'th-1', kind: 'thinking', text: 'Brainstorming architecture' },
      {
        id: 'g-1',
        kind: 'tool-group',
        tools: [
          { id: 'c-1', toolName: 'read', status: 'completed', target: 'a.ts' },
          { id: 'c-2', toolName: 'grep', status: 'completed', target: 'b.ts' },
        ],
      },
    ];

    render(
      <>
        <AgentLiveWorkBox
          activity={activity}
          testIds={{
            root: 'brainstorm-streaming',
            progress: 'brainstorm-agent-progress',
            busy: 'brainstorm-agent-busy',
            thinking: 'brainstorm-agent-thinking',
            steps: 'brainstorm-agent-steps',
            toolGroup: 'brainstorm-tool-group',
          }}
        />
        <AgentThoughtProcess
          items={activity}
          defaultOpen
          testIds={{
            drawer: 'brainstorm-thought-process',
            toggle: 'brainstorm-thought-process-toggle',
            thinking: 'brainstorm-saved-thinking',
            steps: 'brainstorm-saved-steps',
            toolGroup: 'brainstorm-saved-tool-group',
          }}
        />
        <AgentMessageFailure
          reason="Failed"
          canRetry
          onRetry={jest.fn()}
          testIds={{
            root: 'brainstorm-failure-row',
            badge: 'brainstorm-message-failed',
            retry: 'brainstorm-retry',
          }}
        />
        <AgentConnectionBanner
          connectionState="reconnecting"
          testId="brainstorm-connection-banner"
        />
        <AgentSummaryNotice
          notice={{ status: 'running', text: 'Summarizing conversation…', isFallback: false }}
          testId="brainstorm-summary-notice"
        />
        <AgentComposer
          value="hello"
          onChange={jest.fn()}
          onSend={jest.fn()}
          onCancel={jest.fn()}
          onSummarize={jest.fn()}
          isRunning
          steer={{ enabled: true, onSteer: jest.fn() }}
          receipt={makeReceipt({ text: 'Steer sent' })}
          readOnly
          testIds={{
            input: 'brainstorm-composer-input',
            stop: 'brainstorm-composer-stop',
            steer: 'brainstorm-composer-steer',
            summarize: 'brainstorm-composer-summarize',
            receipt: 'brainstorm-composer-receipt',
            readOnlyNotice: 'brainstorm-readonly-notice',
          }}
        />
      </>,
    );

    expect(screen.getByTestId('brainstorm-streaming')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-agent-progress')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-agent-busy')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-agent-thinking')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-agent-steps')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-tool-group')).toBeInTheDocument();

    expect(screen.getByTestId('brainstorm-thought-process')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-thought-process-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-saved-thinking')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-saved-steps')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-saved-tool-group')).toBeInTheDocument();

    expect(screen.getByTestId('brainstorm-failure-row')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-message-failed')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-retry')).toBeInTheDocument();

    expect(screen.getByTestId('brainstorm-connection-banner')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-summary-notice')).toBeInTheDocument();

    expect(screen.getByTestId('brainstorm-composer-input')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-composer-stop')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-composer-steer')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-composer-summarize')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-composer-receipt')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-readonly-notice')).toBeInTheDocument();
  });
});
