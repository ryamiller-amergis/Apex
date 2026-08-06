import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { InterviewChatView } from '../InterviewChatView';
import type { Interview, PrdSummary } from '../../../shared/types/interview';
import type { ChatThreadStatus } from '../../../shared/types/chat';

// ── Module mocks ───────────────────────────────────────────────────────────────

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: jest.fn(() => ({
    selectedProject: 'MaxView',
    can: jest.fn(() => true),
    userId: 'user-1',
    isAdmin: false,
    isInAnyGroup: jest.fn(() => true),
  })),
}));

jest.mock('../../hooks/useChatThreads', () => ({
  useSkillRepos: jest.fn(() => ({
    data: [{ id: 'repo-1', name: 'MaxView', defaultBranch: 'main' }],
  })),
  useSkillList: jest.fn(() => ({
    data: [
      { id: 'skill-1', name: 'grill-with-docs', path: '.cursor/skills/grill-with-docs/SKILL.md' },
      { id: 'skill-2', name: 'to-prd', path: '.cursor/skills/to-prd/SKILL.md' },
    ],
  })),
  useStartChat: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useChatThread: jest.fn(() => ({ data: null })),
}));

jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useProjectSkillConfig: jest.fn(() => ({ data: null })),
  useGlobalDefaultModel: jest.fn(() => ({ data: { key: 'defaultModel', value: 'composer-2' } })),
  useAvailableModels: jest.fn(() => ({
    data: [
      { id: 'composer-2', displayName: 'Composer 2' },
      { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' },
      { id: 'grok-4.5', displayName: 'Grok 4.5' },
    ],
    isLoading: false,
  })),
}));

const mockUpdateStatus = jest.fn();
jest.mock('../../hooks/useInterviews', () => ({
  useCreateInterview: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useInterview: jest.fn(),
  useUpdateInterviewStatus: jest.fn(() => ({ mutateAsync: mockUpdateStatus, isPending: false })),
  useUpdateInterviewTitle: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useCreatePrd: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useDeleteInterview: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
}));

const mockUseAgentChatSession = jest.fn();
jest.mock('../../hooks/useAgentChatSession', () => ({
  useAgentChatSession: (...args: unknown[]) => mockUseAgentChatSession(...args),
}));

jest.mock('../../hooks/useChatAttachments', () => ({
  useChatAttachments: jest.fn(() => ({
    attachments: [],
    attachmentError: null,
    addFiles: jest.fn(),
    addTextAttachments: jest.fn(),
    removeAttachment: jest.fn(),
    clearAttachments: jest.fn(),
  })),
  formatAttachmentSize: jest.fn((s: number) => `${s}B`),
}));

jest.mock('../../hooks/useSpeechInput', () => ({
  useSpeechInput: jest.fn(() => ({
    isListening: false,
    isSpeechSupported: false,
    speechError: null,
    toggle: jest.fn(),
    stop: jest.fn(),
  })),
}));

jest.mock('../../hooks/useSpeechOutput', () => ({
  useSpeechOutput: jest.fn(() => ({
    speak: jest.fn(),
    stop: jest.fn(),
    isSpeaking: false,
    isSpeechOutputSupported: true,
  })),
}));

jest.mock('../LinkedContextPicker', () => ({
  LinkedContextPicker: ({
    mode,
    project,
    interviewId,
    canManage,
    interviewStatus,
    initialErrorText,
    onClose,
  }: {
    mode: string;
    project: string;
    interviewId?: string;
    canManage: boolean;
    interviewStatus?: string;
    initialErrorText?: string;
    onClose?: () => void;
  }) => {
    const canEdit = canManage && interviewStatus === 'in_progress';
    return (
      <section
        data-testid="mock-linked-context-picker"
        data-mode={mode}
        data-project={project}
        data-interview-id={interviewId}
        data-can-manage={String(canManage)}
        data-interview-status={interviewStatus}
      >
        {initialErrorText && <div role="status">{initialErrorText}</div>}
        <button
          type="button"
          aria-label="Close linked context"
          data-testid="linked-context-close"
          onClick={onClose}
        >
          Close
        </button>
        <span>Current link: Payments Module</span>
        {canEdit && <button type="button">Remove Payments Module</button>}
        {canEdit && <button type="button">Add context</button>}
      </section>
    );
  },
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../RunGroundingStatus', () => ({
  RunGroundingStatus: ({
    surface,
    domainRunId,
    project,
  }: {
    surface: string;
    domainRunId: string;
    project: string;
  }) => (
    <div
      data-testid="interview-grounding-embed"
      data-surface={surface}
      data-domain-run-id={domainRunId}
      data-project={project}
    />
  ),
}));

// ── Imports needed after mocks ─────────────────────────────────────────────────

import { within } from '@testing-library/react';
import { useAppShell } from '../../hooks/useAppShell';
import { useInterview, useUpdateInterviewStatus, useCreatePrd } from '../../hooks/useInterviews';
import { useStartChat, useChatThread } from '../../hooks/useChatThreads';
import { useProjectSkillConfig, useGlobalDefaultModel, useAvailableModels } from '../../hooks/useProjectSkillConfig';

// ── Factories ──────────────────────────────────────────────────────────────────

function makePrd(overrides: Partial<PrdSummary> = {}): PrdSummary {
  return {
    id: 'prd-1',
    interviewId: 'iv-1',
    chatThreadId: 'thread-prd-1',
    authorId: 'user-1',
    project: 'proj-alpha',
    title: 'Email Resend Feature',
    status: 'draft',
    createdAt: '2026-01-02T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

function makeInterview(overrides: Partial<Interview> = {}): Interview {
  return {
    id: 'iv-1',
    chatThreadId: 'thread-iv-1',
    authorId: 'user-1',
    title: 'Email Resend Feature',
    project: 'MaxView',
    repo: 'MaxView',
    status: 'in_progress',
    prdCount: 0,
    prds: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const mockSend = jest.fn().mockResolvedValue(undefined);
const mockCancel = jest.fn().mockResolvedValue(undefined);
const mockRetryLast = jest.fn();
const mockClearSendError = jest.fn();

const idleStream = {
  messages: [],
  visibleMessages: [],
  streamingText: '',
  thinkingText: '',
  toolProgress: [],
  phaseEvents: [],
  runHealth: null,
  progressLabel: null,
  progressPhase: null,
  prdReady: false,
  backlogReady: false,
  isRetrying: false,
  retryReason: null,
  isConnected: true,
  lastProgressAt: null,
  status: 'idle' as const,
  isRunning: false,
  isSending: false,
  isAwaitingAgentResponse: false,
  isPreparing: false,
  hasPreparationError: false,
  isInteractionBusy: false,
  send: mockSend,
  retryLast: mockRetryLast,
  cancel: mockCancel,
  sendError: null,
  clearSendError: mockClearSendError,
};

// ── Render helper ──────────────────────────────────────────────────────────────

function renderExistingInterview(
  interviewId = 'iv-1',
  state?: Record<string, unknown>,
) {
  return render(
    <MemoryRouter
      initialEntries={[{
        pathname: `/backlog/interview/${interviewId}`,
        state,
      }]}
    >
      <InterviewChatView />
    </MemoryRouter>,
  );
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  HTMLElement.prototype.scrollIntoView = jest.fn();
  mockUseAgentChatSession.mockReturnValue(idleStream);
  (useChatThread as jest.Mock).mockReturnValue({ data: null });
  (useInterview as jest.Mock).mockReturnValue({
    data: makeInterview(),
    isLoading: false,
    isError: false,
  });
  (useUpdateInterviewStatus as jest.Mock).mockReturnValue({
    mutateAsync: mockUpdateStatus,
    isPending: false,
  });
  (useAppShell as jest.Mock).mockReturnValue({
    selectedProject: 'MaxView',
    can: jest.fn(() => true),
    userId: 'user-1',
    isAdmin: false,
  });
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ ok: true }),
  }) as jest.Mock;
});

describe('PBI-004 Interview grounding status embed', () => {
  it('AC-2 / VT-03 Given an existing Interview, When its run view renders, Then reusable grounding status receives the Interview scope', () => {
    // Arrange / Act
    renderExistingInterview();

    // Assert
    expect(screen.getByTestId('interview-grounding-embed')).toHaveAttribute(
      'data-surface',
      'interview'
    );
    expect(screen.getByTestId('interview-grounding-embed')).toHaveAttribute(
      'data-domain-run-id',
      'iv-1'
    );
    expect(screen.getByTestId('interview-grounding-embed')).toHaveAttribute(
      'data-project',
      'MaxView'
    );
  });
});

describe('PBI-004 AC-3 / VT-04 Linked Context panel read-only gating', () => {
  it('Given a terminal Interview, When an authorized viewer opens Linked Context, Then links remain visible and mutation controls are unavailable', () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'complete' }),
      isLoading: false,
      isError: false,
    });

    renderExistingInterview();
    fireEvent.click(screen.getByTestId('interview-linked-context-trigger'));

    const picker = screen.getByTestId('mock-linked-context-picker');
    expect(picker).toHaveAttribute('data-mode', 'persisted');
    expect(picker).toHaveAttribute('data-interview-status', 'complete');
    expect(within(picker).getByText('Current link: Payments Module')).toBeInTheDocument();
    expect(within(picker).queryByText('Remove Payments Module')).not.toBeInTheDocument();
    expect(within(picker).queryByText('Add context')).not.toBeInTheDocument();
  });

  it('Given a view-only user, When Linked Context opens, Then the trigger remains available and canManage is false', () => {
    (useAppShell as jest.Mock).mockReturnValue({
      selectedProject: 'MaxView',
      can: jest.fn((permission: string) => permission === 'interviews:view'),
      userId: 'viewer-2',
      isAdmin: false,
    });

    renderExistingInterview();
    const trigger = screen.getByTestId('interview-linked-context-trigger');
    expect(trigger).toBeInTheDocument();
    fireEvent.click(trigger);

    const picker = screen.getByTestId('mock-linked-context-picker');
    expect(picker).toHaveAttribute('data-can-manage', 'false');
    expect(within(picker).getByText('Current link: Payments Module')).toBeInTheDocument();
    expect(within(picker).queryByText('Remove Payments Module')).not.toBeInTheDocument();
    expect(within(picker).queryByText('Add context')).not.toBeInTheDocument();
  });
});

describe('TBI keyboard/focus NFR / VT-09 Linked Context panel focus management', () => {
  it('Given the panel is opened, When focus reaches either edge, Then Tab and Shift+Tab remain trapped', async () => {
    renderExistingInterview();
    const trigger = screen.getByTestId('interview-linked-context-trigger');
    trigger.focus();
    fireEvent.click(trigger);

    const close = await screen.findByTestId('linked-context-close');
    await waitFor(() => expect(close).toHaveFocus());

    const add = screen.getByRole('button', { name: 'Add context' });
    add.focus();
    fireEvent.keyDown(add, { key: 'Tab' });
    expect(close).toHaveFocus();

    close.focus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(add).toHaveFocus();
  });

  it('Given the panel is open, When Escape is pressed, Then it closes and restores focus to the trigger', async () => {
    renderExistingInterview();
    const trigger = screen.getByTestId('interview-linked-context-trigger');
    fireEvent.click(trigger);
    const panel = await screen.findByTestId('interview-linked-context-panel');

    fireEvent.keyDown(panel, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('interview-linked-context-panel')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
  });

  it('Given kickoff persistence failure state, When the Interview loads, Then the panel auto-opens with nonblocking retry context', async () => {
    renderExistingInterview('iv-1', {
      openLinkedContext: true,
      linkedContextInitialErrorText:
        'Legacy ADR could not be linked. Open Linked Context to retry.',
    });

    const panel = await screen.findByTestId('interview-linked-context-panel');
    expect(within(panel).getByRole('status')).toHaveTextContent(
      'Legacy ADR could not be linked. Open Linked Context to retry.',
    );
    await waitFor(() =>
      expect(screen.getByTestId('linked-context-close')).toHaveFocus(),
    );
  });
});

// ── PRD link chips ─────────────────────────────────────────────────────────────

describe('ExistingInterviewView — PRD link chips', () => {
  it('shows no PRD chips when the interview has no linked PRDs', () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ prds: [], prdCount: 0 }),
      isLoading: false,
      isError: false,
    });
    renderExistingInterview();
    expect(screen.queryByTitle(/View PRD:/)).not.toBeInTheDocument();
  });

  it('renders a chip for each linked PRD', () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({
        prds: [
          makePrd({ id: 'prd-1', title: 'Feature A' }),
          makePrd({ id: 'prd-2', title: 'Feature B' }),
        ],
        prdCount: 2,
      }),
      isLoading: false,
      isError: false,
    });
    renderExistingInterview();
    expect(screen.getByTitle('View PRD: Feature A')).toBeInTheDocument();
    expect(screen.getByTitle('View PRD: Feature B')).toBeInTheDocument();
  });

  it('displays the PRD title text inside the chip', () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({
        prds: [makePrd({ title: 'Email Resend Feature' })],
        prdCount: 1,
      }),
      isLoading: false,
      isError: false,
    });
    renderExistingInterview();
    // The chip button has a unique title attribute — scope text query inside it
    // so we don't collide with the interview page title which has the same text.
    const chip = screen.getByTitle('View PRD: Email Resend Feature');
    expect(within(chip).getByText('Email Resend Feature')).toBeInTheDocument();
  });

  it('navigates to the PRD route when a chip is clicked', () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({
        prds: [makePrd({ id: 'prd-42', title: 'Feature A' })],
        prdCount: 1,
      }),
      isLoading: false,
      isError: false,
    });
    renderExistingInterview();
    fireEvent.click(screen.getByTitle('View PRD: Feature A'));
    expect(mockNavigate).toHaveBeenCalledWith('/backlog/prd/prd-42');
  });
});

// ── Chat input locked (complete / archived) ────────────────────────────────────

describe('ExistingInterviewView — input locked when not in_progress', () => {
  it('shows repository preparation instead of a blank in-progress interview', () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'in_progress' }),
      isLoading: false,
      isError: false,
    });
    mockUseAgentChatSession.mockReturnValue({
      ...idleStream,
      status: 'running',
      isRunning: true,
      isPreparing: true,
      isInteractionBusy: true,
      progressLabel: 'Refreshing the repository mirror…',
    });
    renderExistingInterview();
    expect(screen.getByTestId('interview-preparation-state')).toHaveTextContent(
      'Refreshing the repository mirror…'
    );
    expect(screen.getByPlaceholderText(/Preparing the latest requirements/i)).toBeDisabled();
    expect(screen.queryByText(/complete and the chat is closed/i)).not.toBeInTheDocument();
  });

  it('shows a recoverable error when repository preparation fails', () => {
    (useChatThread as jest.Mock).mockReturnValue({
      data: {
        status: 'error',
        lastError: 'Unable to prepare the repository for this interview.',
        kickoff: { model: 'composer-2' },
      },
    });
    mockUseAgentChatSession.mockReturnValue({
      ...idleStream,
      status: 'error',
      hasPreparationError: true,
    });

    renderExistingInterview();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Unable to prepare the repository for this interview.'
    );
    expect(screen.getByPlaceholderText(/Continue the interview/i)).toBeEnabled();
  });

  it('replaces the input with a locked notice when status is "complete"', () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'complete', prds: [] }),
      isLoading: false,
      isError: false,
    });
    renderExistingInterview();
    expect(screen.queryByPlaceholderText(/Continue the interview/i)).not.toBeInTheDocument();
    expect(screen.getByText(/complete and the chat is closed/i)).toBeInTheDocument();
  });

  it('replaces the input with a locked notice when status is "archived"', () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'archived' }),
      isLoading: false,
      isError: false,
    });
    renderExistingInterview();
    expect(screen.queryByPlaceholderText(/Continue the interview/i)).not.toBeInTheDocument();
    expect(screen.getByText(/archived and the chat is read-only/i)).toBeInTheDocument();
  });
});

// ── Read-only viewer (non-author) ─────────────────────────────────────────────

describe('ExistingInterviewView — read-only viewer', () => {
  it('hides the compose area and shows a read-only notice for a non-author viewer', () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ authorId: 'author-1', status: 'in_progress' }),
      isLoading: false,
      isError: false,
    });
    (useAppShell as jest.Mock).mockReturnValue({
      selectedProject: 'MaxView',
      can: jest.fn(() => true),
      userId: 'viewer-2',
      isAdmin: false,
    });
    renderExistingInterview();
    expect(screen.queryByPlaceholderText(/Continue the interview/i)).not.toBeInTheDocument();
    expect(screen.getByText(/viewing another user's interview \(read-only\)/i)).toBeInTheDocument();
  });
});

// ── Locked notice content ──────────────────────────────────────────────────────

describe('ExistingInterviewView — locked notice copy', () => {
  it('mentions "View the linked PRD above" when complete with linked PRDs', () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({
        status: 'complete',
        prds: [makePrd()],
        prdCount: 1,
      }),
      isLoading: false,
      isError: false,
    });
    renderExistingInterview();
    expect(screen.getByText(/View the linked PRD above/i)).toBeInTheDocument();
  });

  it('does NOT mention PRD when complete without linked PRDs', () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'complete', prds: [], prdCount: 0 }),
      isLoading: false,
      isError: false,
    });
    renderExistingInterview();
    expect(screen.getByText(/complete and the chat is closed/i)).toBeInTheDocument();
    expect(screen.queryByText(/View the linked PRD above/i)).not.toBeInTheDocument();
  });

  it('shows archived-specific copy when status is "archived"', () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'archived' }),
      isLoading: false,
      isError: false,
    });
    renderExistingInterview();
    expect(screen.getByText(/archived and the chat is read-only/i)).toBeInTheDocument();
  });
});

// ── Reopen button ──────────────────────────────────────────────────────────────

describe('ExistingInterviewView — Reopen button in locked notice', () => {
  it('shows a Reopen button in the locked notice for managers when status is "complete"', () => {
    (useAppShell as jest.Mock).mockReturnValue({
      selectedProject: 'MaxView',
      can: jest.fn(() => true),
      userId: 'user-1',
      isAdmin: false,
    });
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'complete', prds: [] }),
      isLoading: false,
      isError: false,
    });
    renderExistingInterview();
    const notice = screen.getByTestId('locked-notice');
    expect(within(notice).getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
  });

  it('does NOT show a Reopen button for non-managers', () => {
    (useAppShell as jest.Mock).mockReturnValue({
      selectedProject: 'MaxView',
      can: jest.fn(() => false),
      userId: 'user-1',
      isAdmin: false,
    });
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'complete', prds: [] }),
      isLoading: false,
      isError: false,
    });
    renderExistingInterview();
    expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
  });

  it('does NOT show a Reopen button for archived interviews even for managers', () => {
    (useAppShell as jest.Mock).mockReturnValue({
      selectedProject: 'MaxView',
      can: jest.fn(() => true),
      userId: 'user-1',
      isAdmin: false,
    });
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'archived' }),
      isLoading: false,
      isError: false,
    });
    renderExistingInterview();
    expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
  });

  it('calls updateStatus with "in_progress" when the locked notice Reopen is clicked', async () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'complete', prds: [] }),
      isLoading: false,
      isError: false,
    });
    renderExistingInterview();
    const notice = screen.getByTestId('locked-notice');
    fireEvent.click(within(notice).getByRole('button', { name: 'Reopen' }));
    await waitFor(() => {
      expect(mockUpdateStatus).toHaveBeenCalledWith({ id: 'iv-1', status: 'in_progress' });
    });
  });

  it('hides the locked notice Reopen button when a PRD already exists', () => {
    (useAppShell as jest.Mock).mockReturnValue({
      selectedProject: 'MaxView',
      can: jest.fn(() => true),
    });
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'complete', prds: [makePrd()] }),
      isLoading: false,
      isError: false,
    });
    renderExistingInterview();
    const notice = screen.getByTestId('locked-notice');
    expect(within(notice).queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
  });
});

// ── Header Reopen button — disabled when PRD exists ───────────────────────────

describe('ExistingInterviewView — header Reopen button disabled when PRD exists', () => {
  it('enables the header Reopen button when the interview has no PRDs', () => {
    (useAppShell as jest.Mock).mockReturnValue({
      selectedProject: 'MaxView',
      can: jest.fn(() => true),
      userId: 'user-1',
      isAdmin: false,
    });
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'complete', prds: [] }),
      isLoading: false,
      isError: false,
    });
    renderExistingInterview();
    const btn = screen.getByTitle('Reopen this interview');
    expect(btn).not.toBeDisabled();
  });

  it('disables the header Reopen button when a PRD already exists', () => {
    (useAppShell as jest.Mock).mockReturnValue({
      selectedProject: 'MaxView',
      can: jest.fn(() => true),
      userId: 'user-1',
      isAdmin: false,
    });
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'complete', prds: [makePrd()] }),
      isLoading: false,
      isError: false,
    });
    renderExistingInterview();
    const btn = screen.getByTitle('Cannot reopen — a PRD has already been generated');
    expect(btn).toBeDisabled();
  });
});

// ── Read Aloud on agent messages ───────────────────────────────────────────────

describe('ExistingInterviewView — Read Aloud', () => {
  it('shows a Read Aloud button on agent messages', () => {
    mockUseAgentChatSession.mockReturnValue({
      ...idleStream,
      messages: [
        {
          id: 'msg-1',
          role: 'agent' as const,
          text: 'Here is the interview question.',
          ts: '2026-01-01T00:00:00Z',
        },
      ],
    });
    renderExistingInterview();
    expect(screen.getByRole('button', { name: 'Read aloud' })).toBeInTheDocument();
  });
});

// ── Choice block submit hidden when interview is locked ────────────────────────

describe('ExistingInterviewView — choice block submit gating', () => {
  const choiceMessage = {
    id: 'msg-1',
    role: 'agent' as const,
    text: 'Which approach do you prefer?\n\na. Option Alpha\nb. Option Beta\nc. Option Gamma',
    ts: '2026-01-01T00:00:00Z',
  };

  it('hides the "Submit answers" button when the interview is complete', () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'complete', prds: [] }),
      isLoading: false,
      isError: false,
    });
    mockUseAgentChatSession.mockReturnValue({
      ...idleStream,
      messages: [choiceMessage],
    });
    renderExistingInterview();
    expect(screen.queryByRole('button', { name: /Submit answers/i })).not.toBeInTheDocument();
  });

  it('hides the "Submit answers" button when the interview is archived', () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'archived' }),
      isLoading: false,
      isError: false,
    });
    mockUseAgentChatSession.mockReturnValue({
      ...idleStream,
      messages: [choiceMessage],
    });
    renderExistingInterview();
    expect(screen.queryByRole('button', { name: /Submit answers/i })).not.toBeInTheDocument();
  });

  it('shows the "Submit answers" button when the interview is in_progress', () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'in_progress' }),
      isLoading: false,
      isError: false,
    });
    mockUseAgentChatSession.mockReturnValue({
      ...idleStream,
      messages: [choiceMessage],
    });
    renderExistingInterview();
    expect(screen.getByRole('button', { name: /Submit answers/i })).toBeInTheDocument();
  });
});

// ── Optimistic processing state ───────────────────────────────────────────────

describe('ExistingInterviewView — processing state after send', () => {
  const initialAgentMessage = {
    id: 'agent-question-1',
    role: 'agent' as const,
    text: 'What problem should we explore?',
    ts: '2026-01-01T00:00:00Z',
  };

  it('disables input and shows bouncing dots while session is busy', async () => {
    // Simulate session in "awaiting agent response" state
    mockUseAgentChatSession.mockReturnValue({
      ...idleStream,
      messages: [initialAgentMessage],
      isAwaitingAgentResponse: true,
      isInteractionBusy: true,
    });

    const view = renderExistingInterview();
    const input = screen.getByTestId('interview-message-input');
    expect(input).toBeDisabled();
    expect(screen.getByTestId('interview-agent-processing')).toBeInTheDocument();
    expect(input).toHaveAttribute('placeholder', 'Agent is thinking…');

    // Simulate agent responding
    mockUseAgentChatSession.mockReturnValue({
      ...idleStream,
      messages: [
        initialAgentMessage,
        {
          id: 'agent-response-1',
          role: 'agent' as const,
          text: 'Here is the next question.',
          ts: '2026-01-01T00:00:01Z',
        },
      ],
    });
    view.rerender(
      <MemoryRouter initialEntries={['/backlog/interview/iv-1']}>
        <InterviewChatView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('interview-message-input')).toBeEnabled();
      expect(screen.queryByTestId('interview-agent-processing')).not.toBeInTheDocument();
    });
  });

  it('shows error and re-enables input when the session has a send error', () => {
    mockUseAgentChatSession.mockReturnValue({
      ...idleStream,
      messages: [initialAgentMessage],
      sendError: 'Unable to queue message',
    });

    renderExistingInterview();
    const input = screen.getByTestId('interview-message-input');
    expect(screen.getByText('Unable to queue message')).toBeInTheDocument();
    expect(input).toBeEnabled();
    expect(screen.queryByTestId('interview-agent-processing')).not.toBeInTheDocument();
  });

  it('stays disabled throughout the running state and unlocks when the run ends', () => {
    let streamState = {
      ...idleStream,
      messages: [initialAgentMessage],
      status: 'running' as ChatThreadStatus,
      isRunning: true,
      isInteractionBusy: true,
    };
    mockUseAgentChatSession.mockImplementation(() => streamState);

    const view = renderExistingInterview();
    const renderCurrentStream = () => {
      view.rerender(
        <MemoryRouter initialEntries={['/backlog/interview/iv-1']}>
          <InterviewChatView />
        </MemoryRouter>,
      );
    };

    expect(screen.getByTestId('interview-message-input')).toBeDisabled();
    expect(screen.getByTestId('interview-agent-processing')).toBeInTheDocument();

    streamState = { ...streamState, status: 'idle' as ChatThreadStatus, isRunning: false, isInteractionBusy: false };
    renderCurrentStream();
    expect(screen.getByTestId('interview-message-input')).toBeEnabled();
    expect(screen.queryByTestId('interview-agent-processing')).not.toBeInTheDocument();
  });
});

// ── handleGeneratePrd — model resolution ──────────────────────────────────────

describe('ExistingInterviewView — handleGeneratePrd model resolution', () => {
  const mockStartChatMutate = jest.fn();
  const mockCreatePrdMutate = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    HTMLElement.prototype.scrollIntoView = jest.fn();
    mockUseAgentChatSession.mockReturnValue(idleStream);

    // Interview is complete so the "Generate PRD" button is visible
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'complete', prds: [] }),
      isLoading: false,
      isError: false,
    });
    (useAppShell as jest.Mock).mockReturnValue({
      selectedProject: 'MaxView',
      can: jest.fn(() => true),
      userId: 'user-1',
      isAdmin: false,
    });

    mockStartChatMutate.mockResolvedValue({ threadId: 'new-thread-1' });
    mockCreatePrdMutate.mockResolvedValue({ prdId: 'prd-new' });

    (useStartChat as jest.Mock).mockReturnValue({
      mutateAsync: mockStartChatMutate,
      isPending: false,
    });
    (useCreatePrd as jest.Mock).mockReturnValue({
      mutateAsync: mockCreatePrdMutate,
      isPending: false,
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    }) as jest.Mock;
  });

  it('passes skillConfig.prdModel to the startChat kickoff when set', async () => {
    (useProjectSkillConfig as jest.Mock).mockReturnValue({
      data: {
        project: 'MaxView',
        skillRepo: 'MaxView',
        skillBranch: 'main',
        prdModel: 'claude-opus-4-6',
      },
    });
    (useGlobalDefaultModel as jest.Mock).mockReturnValue({
      data: { key: 'defaultModel', value: 'composer-2' },
    });

    renderExistingInterview();
    fireEvent.click(screen.getByTitle('Generate a PRD from this interview'));

    await waitFor(() => {
      expect(mockStartChatMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          kickoff: expect.objectContaining({ model: 'claude-opus-4-6' }),
        }),
      );
      expect(mockCreatePrdMutate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-opus-4-6' }),
      );
    });
  });

  it('falls back to globalDefaultModel.value when skillConfig.prdModel is null', async () => {
    (useProjectSkillConfig as jest.Mock).mockReturnValue({
      data: {
        project: 'MaxView',
        skillRepo: 'MaxView',
        skillBranch: 'main',
        prdModel: null,
      },
    });
    (useGlobalDefaultModel as jest.Mock).mockReturnValue({
      data: { key: 'defaultModel', value: 'composer-2' },
    });

    renderExistingInterview();
    fireEvent.click(screen.getByTitle('Generate a PRD from this interview'));

    await waitFor(() => {
      expect(mockStartChatMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          kickoff: expect.objectContaining({ model: 'composer-2' }),
        }),
      );
    });
  });

  it('falls back to globalDefaultModel.value when skillConfig is null', async () => {
    (useProjectSkillConfig as jest.Mock).mockReturnValue({ data: null });
    (useGlobalDefaultModel as jest.Mock).mockReturnValue({
      data: { key: 'defaultModel', value: 'composer-2' },
    });

    renderExistingInterview();
    fireEvent.click(screen.getByTitle('Generate a PRD from this interview'));

    await waitFor(() => {
      expect(mockStartChatMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          kickoff: expect.objectContaining({ model: 'composer-2' }),
        }),
      );
    });
  });

  it('uses DEFAULT_MODEL_ID when both skillConfig.prdModel and globalDefaultModel are null/undefined', async () => {
    (useProjectSkillConfig as jest.Mock).mockReturnValue({ data: null });
    (useGlobalDefaultModel as jest.Mock).mockReturnValue({ data: undefined });

    renderExistingInterview();
    fireEvent.click(screen.getByTitle('Generate a PRD from this interview'));

    await waitFor(() => {
      expect(mockStartChatMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          kickoff: expect.objectContaining({ model: expect.any(String) }),
        }),
      );
    });
    const calledWith = mockStartChatMutate.mock.calls[0][0] as {
      kickoff: { model: string };
    };
    // DEFAULT_MODEL_ID is the hard-coded fallback — it must be a non-empty string
    expect(calledWith.kickoff.model).toBeTruthy();
  });
});

// ── Generate PRD button — disabled when PRD already exists ────────────────────

describe('ExistingInterviewView — Generate PRD button disabled when PRD exists', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    HTMLElement.prototype.scrollIntoView = jest.fn();
    mockUseAgentChatSession.mockReturnValue(idleStream);
    (useAppShell as jest.Mock).mockReturnValue({
      selectedProject: 'MaxView',
      can: jest.fn(() => true),
      userId: 'user-1',
      isAdmin: false,
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    }) as jest.Mock;
  });

  it('enables the Generate PRD button when the interview has no PRDs', () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'complete', prds: [] }),
      isLoading: false,
      isError: false,
    });

    renderExistingInterview();

    const btn = screen.getByTitle('Generate a PRD from this interview');
    expect(btn).not.toBeDisabled();
  });

  it('disables the Generate PRD button when the interview already has a PRD', () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'complete', prds: [makePrd()] }),
      isLoading: false,
      isError: false,
    });

    renderExistingInterview();

    const btn = screen.getByTitle('A PRD has already been generated for this interview');
    expect(btn).toBeDisabled();
  });

  it('does not call createPrd when the button is disabled due to existing PRD', () => {
    const mockCreatePrdMutate = jest.fn();
    (useCreatePrd as jest.Mock).mockReturnValue({
      mutateAsync: mockCreatePrdMutate,
      isPending: false,
    });
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'complete', prds: [makePrd()] }),
      isLoading: false,
      isError: false,
    });

    renderExistingInterview();

    const btn = screen.getByTitle('A PRD has already been generated for this interview');
    fireEvent.click(btn);

    expect(mockCreatePrdMutate).not.toHaveBeenCalled();
  });
});

// ── Model hydration from kickoff ───────────────────────────────────────────────

describe('ExistingInterviewView — model select reflects kickoff model', () => {
  it('shows the kickoff model in the session dropdown (not the hardcoded Composer 2 default)', async () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ model: 'grok-4.5' }),
      isLoading: false,
      isError: false,
    });
    (useChatThread as jest.Mock).mockReturnValue({
      data: {
        id: 'thread-iv-1',
        kickoff: { project: 'MaxView', repo: 'MaxView', model: 'grok-4.5' },
        messages: [],
        status: 'idle',
      },
    });
    (useAvailableModels as jest.Mock).mockReturnValue({
      data: [
        { id: 'composer-2', displayName: 'Composer 2' },
        { id: 'grok-4.5', displayName: 'Grok 4.5' },
      ],
      isLoading: false,
    });

    renderExistingInterview();

    const modelSelect = await screen.findByLabelText('Model');
    expect(modelSelect).toHaveValue('grok-4.5');
  });

  it('falls back to interview.model when kickoff.model is missing', async () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ model: 'claude-opus-4-6' }),
      isLoading: false,
      isError: false,
    });
    (useChatThread as jest.Mock).mockReturnValue({
      data: {
        id: 'thread-iv-1',
        kickoff: { project: 'MaxView', repo: 'MaxView' },
        messages: [],
        status: 'idle',
      },
    });

    renderExistingInterview();

    const modelSelect = await screen.findByLabelText('Model');
    expect(modelSelect).toHaveValue('claude-opus-4-6');
  });
});
