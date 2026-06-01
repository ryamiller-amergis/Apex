import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { InterviewChatView } from '../InterviewChatView';
import type { Interview, PrdSummary } from '../../../shared/types/interview';

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

const mockUseChatStream = jest.fn();
jest.mock('../../hooks/useChatStream', () => ({
  useChatStream: (...args: unknown[]) => mockUseChatStream(...args),
}));

jest.mock('../../hooks/useChatAttachments', () => ({
  useChatAttachments: jest.fn(() => ({
    attachments: [],
    attachmentError: null,
    addFiles: jest.fn(),
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

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));

// ── Imports needed after mocks ─────────────────────────────────────────────────

import { within } from '@testing-library/react';
import { useAppShell } from '../../hooks/useAppShell';
import { useInterview, useUpdateInterviewStatus, useCreatePrd } from '../../hooks/useInterviews';
import { useStartChat } from '../../hooks/useChatThreads';
import { useProjectSkillConfig, useGlobalDefaultModel } from '../../hooks/useProjectSkillConfig';

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

const idleStream = {
  messages: [],
  streamingText: '',
  status: 'idle' as const,
};

// ── Render helper ──────────────────────────────────────────────────────────────

function renderExistingInterview(interviewId = 'iv-1') {
  return render(
    <MemoryRouter initialEntries={[`/backlog/interview/${interviewId}`]}>
      <InterviewChatView />
    </MemoryRouter>,
  );
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  HTMLElement.prototype.scrollIntoView = jest.fn();
  mockUseChatStream.mockReturnValue(idleStream);
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
  });
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ ok: true }),
  }) as jest.Mock;
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
  it('shows the chat input area when the interview is in_progress', () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'in_progress' }),
      isLoading: false,
      isError: false,
    });
    renderExistingInterview();
    expect(screen.getByPlaceholderText(/Continue the interview/i)).toBeInTheDocument();
    expect(screen.queryByText(/complete and the chat is closed/i)).not.toBeInTheDocument();
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
    mockUseChatStream.mockReturnValue({
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
    mockUseChatStream.mockReturnValue({
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
    mockUseChatStream.mockReturnValue({
      ...idleStream,
      messages: [choiceMessage],
    });
    renderExistingInterview();
    expect(screen.getByRole('button', { name: /Submit answers/i })).toBeInTheDocument();
  });
});

// ── handleGeneratePrd — model resolution ──────────────────────────────────────

describe('ExistingInterviewView — handleGeneratePrd model resolution', () => {
  const mockStartChatMutate = jest.fn();
  const mockCreatePrdMutate = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    HTMLElement.prototype.scrollIntoView = jest.fn();
    mockUseChatStream.mockReturnValue(idleStream);

    // Interview is complete so the "Generate PRD" button is visible
    (useInterview as jest.Mock).mockReturnValue({
      data: makeInterview({ status: 'complete', prds: [] }),
      isLoading: false,
      isError: false,
    });
    (useAppShell as jest.Mock).mockReturnValue({
      selectedProject: 'MaxView',
      can: jest.fn(() => true),
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
    mockUseChatStream.mockReturnValue(idleStream);
    (useAppShell as jest.Mock).mockReturnValue({
      selectedProject: 'MaxView',
      can: jest.fn(() => true),
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
