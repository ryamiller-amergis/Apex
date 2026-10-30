import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BrainstormWorkspace } from '../BrainstormWorkspace';
import { useBrainstormChat } from '../../hooks/useBrainstormChat';
import { BrainstormApiError, useBrainstormMessages, useBrainstormSession } from '../../hooks/useBrainstormSessions';
import type { BrainstormMessageDto, BrainstormSessionDetail } from '../../../shared/types/brainstorm';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../hooks/useBrainstormChat', () => ({ useBrainstormChat: jest.fn() }));
jest.mock('../../hooks/useBrainstormSessions', () => {
  const actual = jest.requireActual('../../hooks/useBrainstormSessions');
  return {
    BrainstormApiError: actual.BrainstormApiError,
    useBrainstormSession: jest.fn(),
    useBrainstormMessages: jest.fn(),
    useRenameBrainstormSession: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  };
});
jest.mock('../BrainstormArtifactPanel', () => ({
  BrainstormArtifactPanel: ({ turnRunning }: { turnRunning: boolean }) => (
    <section {...{ 'data-testid': 'brainstorm-artifact-panel' }} data-turn-running={String(turnRunning)} />
  ),
}));
jest.mock('../../hooks/useBrainstormActions', () => ({
  useBrainstormActions: () => ({ data: undefined }),
}));
jest.mock('../../hooks/useBrainstormArtifact', () => ({
  useBrainstormArtifact: () => ({
    data: { id: null, sessionId: 's-1', type: null, markdown: '', version: 0, updatedAt: null, lastOrigin: null, lastChangeFailure: null },
  }),
  useSwitchArtifactType: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock('../../hooks/useBrainstormSources', () => ({
  useBrainstormSources: () => ({ data: [], isError: false, isLoading: false }),
  useBrainstormCitations: () => ({ data: [] }),
  useBrainstormSourceOptions: () => ({ data: undefined, error: null }),
  useAttachBrainstormSource: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useRemoveBrainstormSource: () => ({ mutate: jest.fn(), isPending: false }),
  useEndBrainstormSession: () => ({ mutate: jest.fn(), isPending: false, error: null }),
}));
jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useAvailableModels: () => ({
    data: [{ id: 'm', displayName: 'Model M' }],
    isLoading: false,
  }),
}));

const chatHook = useBrainstormChat as jest.Mock;
const sessionHook = useBrainstormSession as jest.Mock;
const messagesHook = useBrainstormMessages as jest.Mock;

const readOnlySession: BrainstormSessionDetail = {
  id: 's-1',
  title: 'Billing ideas',
  creatorId: 'creator',
  creatorName: 'Ada',
  state: 'active',
  model: 'm',
  artifactType: null,
  lastActivityAt: '2026-10-29T10:00:00.000Z',
  createdAt: '2026-10-29T10:00:00.000Z',
  canMutate: false,
  threadId: 't-1',
  version: 1,
  failureReason: null,
};

const failedReply: BrainstormMessageDto = {
  id: 'a-1',
  role: 'assistant',
  content: '',
  status: 'failed',
  runId: 'run-1',
  turnId: 'turn-1',
  failureCode: 'model_error',
  failureSummary: 'The model returned an error before finishing.',
  retryOfMessageId: null,
  supersededByMessageId: null,
  createdAt: '2026-10-29T10:00:00.000Z',
  completedAt: '2026-10-29T10:00:05.000Z',
};

function renderWorkspace() {
  return render(
    <MemoryRouter>
      <BrainstormWorkspace project="Apex" sessionId="s-1" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  chatHook.mockReturnValue({
    streamingText: '',
    status: 'idle',
    isInteractionBusy: false,
    isRunning: false,
    isCancelling: false,
    sendError: null,
    send: jest.fn(),
    retryFailedRun: jest.fn(),
    cancel: jest.fn(),
  });
});

describe('BrainstormWorkspace (VT-30, VT-32)', () => {
  it('PBI-004 (a), PBI-003 (d): a non-creator reads the failure but gets no composer and no Retry', () => {
    sessionHook.mockReturnValue({ data: readOnlySession, isLoading: false, error: null, refetch: jest.fn() });
    messagesHook.mockReturnValue({ data: [failedReply], isLoading: false, isError: false, refetch: jest.fn() });
    renderWorkspace();

    expect(screen.getByTestId('brainstorm-readonly-banner')).toHaveTextContent(
      'You can read this session. Only its creator can reply.',
    );
    expect(screen.queryByTestId('brainstorm-composer-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('brainstorm-composer-send')).not.toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-message-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('brainstorm-retry')).not.toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-artifact-panel')).toHaveAttribute('data-turn-running', 'false');
    expect(screen.getByTestId('brainstorm-session-status')).toHaveTextContent('Active');
    expect(screen.getByTestId('brainstorm-back-to-sessions')).toHaveAttribute('href', '/brainstorm');
  });

  it('PBI-004 (c): a non-creator sees the empty-content state on an empty session', () => {
    sessionHook.mockReturnValue({ data: readOnlySession, isLoading: false, error: null, refetch: jest.fn() });
    messagesHook.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: jest.fn() });
    renderWorkspace();

    expect(screen.getByTestId('brainstorm-empty-readonly')).toHaveTextContent('has not added content');
  });

  it('PBI-004 (d): a 404 shows the not-found state with a link back to /brainstorm', () => {
    sessionHook.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new BrainstormApiError(404, 'Session not found'),
      refetch: jest.fn(),
    });
    messagesHook.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: jest.fn() });
    renderWorkspace();

    expect(screen.getByTestId('brainstorm-not-found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Brainstorm sessions' })).toHaveAttribute('href', '/brainstorm');
  });

  it('shows a retryable error state for other load failures', () => {
    const refetch = jest.fn();
    sessionHook.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new BrainstormApiError(500, 'boom'),
      refetch,
    });
    renderWorkspace();

    fireEvent.click(screen.getByTestId('brainstorm-workspace-retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('allows minimizing and expanding the artifact and sources section', () => {
    sessionHook.mockReturnValue({ data: readOnlySession, isLoading: false, error: null, refetch: jest.fn() });
    messagesHook.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: jest.fn() });
    renderWorkspace();

    expect(screen.getByTestId('brainstorm-artifact-panel')).toBeInTheDocument();

    // Expand wider and restore
    fireEvent.click(screen.getByTestId('brainstorm-side-expand'));
    expect(screen.getByTestId('brainstorm-side-expand')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('brainstorm-side-expand'));
    expect(screen.getByTestId('brainstorm-side-expand')).toHaveAttribute('aria-pressed', 'false');

    // Minimize hides the active panel
    fireEvent.click(screen.getByTestId('brainstorm-side-minimize'));
    expect(screen.queryByTestId('brainstorm-artifact-panel')).not.toBeInTheDocument();

    // Clicking Expand restores the active panel
    fireEvent.click(screen.getByTestId('brainstorm-side-expand'));
    expect(screen.getByTestId('brainstorm-artifact-panel')).toBeInTheDocument();

    // Keep transition to sources tab
    fireEvent.click(screen.getByTestId('brainstorm-side-minimize'));
    expect(screen.queryByTestId('brainstorm-sources-panel')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('brainstorm-sources-tab'));
    expect(screen.getByTestId('brainstorm-sources-panel')).toBeInTheDocument();
  });

  it('allows the creator of an active session to rename the session title in the header', () => {
    const renameMutate = jest.fn();
    const { useRenameBrainstormSession } = jest.requireMock('../../hooks/useBrainstormSessions') as {
      useRenameBrainstormSession?: jest.Mock;
    };
    expect(typeof useRenameBrainstormSession).toBe('function');
    useRenameBrainstormSession?.mockReturnValue({ mutateAsync: renameMutate, isPending: false });

    sessionHook.mockReturnValue({
      data: { ...readOnlySession, canMutate: true },
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    messagesHook.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: jest.fn() });
    renderWorkspace();

    fireEvent.click(screen.getByTestId('brainstorm-session-rename-button'));
    const input = screen.getByTestId('brainstorm-session-rename-input');
    fireEvent.change(input, { target: { value: 'MatterWorx Home Redesign' } });
    fireEvent.click(screen.getByTestId('brainstorm-session-rename-save'));
    expect(renameMutate).toHaveBeenCalledWith({
      sessionId: 's-1',
      title: 'MatterWorx Home Redesign',
    });
  });
});
