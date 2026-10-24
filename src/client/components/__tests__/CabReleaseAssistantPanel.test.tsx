import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CabReleaseAssistantPanel } from '../CabReleaseAssistantPanel';

const mutateAsync = jest.fn();
const send = jest.fn();
const cancel = jest.fn();
let sessionIsPreparing = false;
let skillConfigPending = false;

jest.mock('../../hooks/useChatThreads', () => ({
  useStartChat: () => ({ mutateAsync, isPending: false }),
}));

jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useProjectSkillConfig: () => ({
    data: skillConfigPending ? undefined : {
      id: 'settings-1',
      skillRepo: 'MaxView',
      skillBranch: 'main',
      skillProvider: 'ado',
    },
    isPending: skillConfigPending,
    isError: false,
    error: null,
  }),
}));

jest.mock('../../hooks/useAgentChatSession', () => ({
  useAgentChatSession: () => ({
    messages: [],
    visibleMessages: [
      { id: 'm1', role: 'user', text: 'Run /cab-release', ts: '2026-01-01T00:00:00Z' },
    ],
    streamingText: 'Wiki URL: https://example',
    isRunning: true,
    isSending: false,
    isPreparing: sessionIsPreparing,
    showTypingIndicator: false,
    send,
    cancel,
  }),
  shouldShowAgentTypingIndicator: () => false,
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));

function renderPanel(open = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = jest.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <CabReleaseAssistantPanel
        open={open}
        onClose={onClose}
        project="MaxView"
        targetVersion="2026.13.0"
        apexReleaseEpicId={12345}
        relatedWorkItemIds={[53247]}
        previousReleaseBranch="Release/2026.12.0"
        snowMode="dry-run"
        cutReleaseBranch={false}
      />
    </QueryClientProvider>,
  );
  return { onClose };
}

describe('CabReleaseAssistantPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionIsPreparing = false;
    skillConfigPending = false;
    mutateAsync.mockResolvedValue({ threadId: 'thread-cab-1' });
    send.mockResolvedValue(undefined);
  });

  it('renders nothing when closed', () => {
    renderPanel(false);
    expect(screen.queryByTestId('cab-release-assistant-panel')).not.toBeInTheDocument();
  });

  it('starts a cab-release thread and sends the kickoff message', async () => {
    renderPanel(true);

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
        skipAutoKickoff: true,
        kickoff: expect.objectContaining({
          project: 'MaxView',
          repo: 'MaxView',
          skillPath: '.cursor/skills/cab-release/SKILL.md',
        }),
      }));
    });

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        expect.stringContaining('Apex Release Epic id: 12345'),
        expect.objectContaining({
          skill: { name: 'cab-release', path: '.cursor/skills/cab-release/SKILL.md' },
        }),
      );
    });

    expect(screen.getByTestId('cab-release-assistant-panel')).toBeInTheDocument();
    expect(screen.getByText(/Wiki URL/)).toBeInTheDocument();
  });

  it('waits for skill settings before reporting a missing skill repo', async () => {
    skillConfigPending = true;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <CabReleaseAssistantPanel
          open
          onClose={jest.fn()}
          project="MaxView"
          targetVersion="2026.13.0"
          apexReleaseEpicId={12345}
          relatedWorkItemIds={[53247]}
          previousReleaseBranch="Release/2026.12.0"
          snowMode="dry-run"
          cutReleaseBranch={false}
        />
      </QueryClientProvider>,
    );

    expect(screen.queryByTestId('cab-release-assistant-error')).not.toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText('Starting cab-release…')).toBeInTheDocument();

    skillConfigPending = false;
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <CabReleaseAssistantPanel
          open
          onClose={jest.fn()}
          project="MaxView"
          targetVersion="2026.13.0"
          apexReleaseEpicId={12345}
          relatedWorkItemIds={[53247]}
          previousReleaseBranch="Release/2026.12.0"
          snowMode="dry-run"
          cutReleaseBranch={false}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('cab-release-assistant-error')).not.toBeInTheDocument();
  });

  it('holds the kickoff until the session is no longer preparing', async () => {
    sessionIsPreparing = true;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <CabReleaseAssistantPanel
          open
          onClose={jest.fn()}
          project="MaxView"
          targetVersion="2026.13.0"
          apexReleaseEpicId={12345}
          relatedWorkItemIds={[53247]}
          previousReleaseBranch="Release/2026.12.0"
          snowMode="dry-run"
          cutReleaseBranch={false}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalled();
    });
    expect(send).not.toHaveBeenCalled();

    sessionIsPreparing = false;
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <CabReleaseAssistantPanel
          open
          onClose={jest.fn()}
          project="MaxView"
          targetVersion="2026.13.0"
          apexReleaseEpicId={12345}
          relatedWorkItemIds={[53247]}
          previousReleaseBranch="Release/2026.12.0"
          snowMode="dry-run"
          cutReleaseBranch={false}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        expect.stringContaining('Apex Release Epic id: 12345'),
        expect.any(Object),
      );
    });
  });

  it('shows a kickoff error instead of sending when the previous branch is not a release', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CabReleaseAssistantPanel
          open
          onClose={jest.fn()}
          project="MaxView"
          targetVersion="2026.13.0"
          apexReleaseEpicId={12345}
          relatedWorkItemIds={[53247]}
          previousReleaseBranch="development"
          snowMode="dry-run"
          cutReleaseBranch={false}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('cab-release-assistant-error')).toHaveTextContent(
      'Invalid previous release branch: development',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('closes from the panel close control', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel(true);
    await user.click(screen.getByTestId('cab-release-assistant-close'));
    expect(onClose).toHaveBeenCalled();
  });
});
