import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { InterviewChatView } from '../InterviewChatView';

// ── Module mocks ───────────────────────────────────────────────────────────────

const mockLinkInterviewMutateAsync = jest.fn();

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: jest.fn(() => ({
    selectedProject: 'MaxView',
    can: jest.fn(() => true),
    isInAnyGroup: jest.fn(() => true),
    permissionsLoaded: true,
  })),
}));

jest.mock('../../hooks/useFeatureRequests', () => ({
  useLinkFeatureRequestInterview: () => ({
    mutateAsync: mockLinkInterviewMutateAsync,
  }),
}));

jest.mock('../../hooks/useChatThreads', () => ({
  useSkillRepos: jest.fn(() => ({
    data: [{ id: 'repo-1', name: 'MaxView', defaultBranch: 'main' }],
  })),
  useSkillList: jest.fn(() => ({
    data: [
      {
        id: 'skill-1',
        name: 'grill-with-docs',
        path: '.cursor/skills/grill-with-docs/SKILL.md',
      },
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

jest.mock('../../hooks/useInterviews', () => ({
  useCreateInterview: jest.fn(),
  useInterview: jest.fn(() => ({ data: null, isLoading: true, isError: false })),
  useUpdateInterviewStatus: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useUpdateInterviewTitle: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useCreatePrd: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useDeleteInterview: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useActiveUsers: jest.fn(() => ({ data: [], isLoading: false })),
}));

jest.mock('../SectionOwnerModal', () => ({
  SectionOwnerModal: jest.fn(),
}));

jest.mock('../../hooks/useChatStream', () => ({
  useChatStream: jest.fn(() => ({
    messages: [],
    streamingText: '',
    status: 'idle',
  })),
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

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));

// ── Helpers ────────────────────────────────────────────────────────────────────

import { useEffect } from 'react';
import { useCreateInterview } from '../../hooks/useInterviews';
import { useStartChat, useSkillList } from '../../hooks/useChatThreads';
import { useProjectSkillConfig } from '../../hooks/useProjectSkillConfig';
import { SectionOwnerModal } from '../SectionOwnerModal';

const MockSectionOwnerModal = SectionOwnerModal as jest.Mock;

function renderCompose() {
  return render(
    <MemoryRouter initialEntries={['/backlog/interview/new']}>
      <InterviewChatView />
    </MemoryRouter>,
  );
}

function renderFeatureRequestCompose(overrides?: {
  type?: 'feature' | 'technical' | 'issue';
  linkedAdrs?: Array<{ id: string; title: string; slug: string | null }>;
}) {
  return render(
    <MemoryRouter
      initialEntries={[{
        pathname: '/backlog/interview/new',
        state: {
          featureRequest: {
            id: 'fr-1',
            type: overrides?.type ?? 'feature',
            title: 'Dark mode',
            request: 'Add dark mode support',
            advantage: 'Better UX at night',
            linkedAdrs: overrides?.linkedAdrs ?? [],
          },
        },
      }]}
    >
      <InterviewChatView />
    </MemoryRouter>,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('NewInterviewCompose — title required', () => {
  let startChatMutateAsync: jest.Mock;
  let createInterviewMutateAsync: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLinkInterviewMutateAsync.mockResolvedValue({ interviewId: 'iv-1' });

    startChatMutateAsync = jest.fn().mockResolvedValue({ threadId: 'thread-abc' });
    (useStartChat as jest.Mock).mockReturnValue({
      mutateAsync: startChatMutateAsync,
      isPending: false,
    });

    createInterviewMutateAsync = jest.fn().mockResolvedValue({ interviewId: 'iv-1' });
    (useCreateInterview as jest.Mock).mockReturnValue({
      mutateAsync: createInterviewMutateAsync,
      isPending: false,
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    }) as jest.Mock;

    MockSectionOwnerModal.mockImplementation(({ onConfirm }: { onConfirm: (s: Record<string, unknown>) => void }) => {
      useEffect(() => { onConfirm({}); }, [onConfirm]);
      return null;
    });
  });

  it('renders a required title field and message textarea', () => {
    renderCompose();
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/describe what you'd like/i)).toBeInTheDocument();
  });

  it('prefills the title and description from a feature request', () => {
    renderFeatureRequestCompose();

    expect(screen.getByLabelText(/title/i)).toHaveValue('Dark mode');
    expect(screen.getByPlaceholderText(/describe what you'd like/i)).toHaveValue(
      [
        'This interview originated from a feature request.',
        '',
        'Add dark mode support',
        '',
        'Advantage:',
        'Better UX at night',
      ].join('\n'),
    );
  });

  it('prefills technical work items without an advantage section', () => {
    renderFeatureRequestCompose({ type: 'technical' });

    expect(screen.getByPlaceholderText(/describe what you'd like/i)).toHaveValue(
      [
        'This interview originated from a technical work item.',
        '',
        'Add dark mode support',
      ].join('\n'),
    );
  });

  it('seeds linked ADR markdown attachments when kicking off from a work item', async () => {
    const { useChatAttachments } = jest.requireMock('../../hooks/useChatAttachments') as {
      useChatAttachments: jest.Mock;
    };
    const addTextAttachments = jest.fn();
    useChatAttachments.mockReturnValue({
      attachments: [],
      attachmentError: null,
      addFiles: jest.fn(),
      addTextAttachments,
      removeAttachment: jest.fn(),
      clearAttachments: jest.fn(),
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        id: 'adr-1',
        content: '# Scale PDF\n\nUse a broker and workers.',
      }),
    }) as jest.Mock;

    renderFeatureRequestCompose({
      type: 'technical',
      linkedAdrs: [{ id: 'adr-1', title: 'Scale PDF', slug: 'scale-pdf' }],
    });

    await waitFor(() => {
      expect(addTextAttachments).toHaveBeenCalledWith([
        {
          name: 'scale-pdf.md',
          content: '# Scale PDF\n\nUse a broker and workers.',
          type: 'text/markdown',
        },
      ]);
    });
    expect(
      (screen.getByPlaceholderText(/describe what you'd like/i) as HTMLTextAreaElement).value,
    ).toContain('Linked accepted ADRs are attached');
  });

  it('links the feature request after creating the interview', async () => {
    renderFeatureRequestCompose();
    fireEvent.click(screen.getByLabelText('Start interview'));

    await waitFor(() => {
      expect(mockLinkInterviewMutateAsync).toHaveBeenCalledWith({
        id: 'fr-1',
        interviewId: 'iv-1',
      });
    });
  });

  it('continues posting the kickoff message when feature request linking fails', async () => {
    mockLinkInterviewMutateAsync.mockRejectedValueOnce(new Error('Link failed'));
    renderFeatureRequestCompose();
    fireEvent.click(screen.getByLabelText('Start interview'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/chat/threads/thread-abc/messages',
        expect.any(Object),
      );
    });
  });

  it('title field is marked required with an asterisk', () => {
    renderCompose();
    expect(screen.getByText('*')).toBeInTheDocument();
  });

  it('send button is disabled when title is empty even if message is filled', () => {
    renderCompose();
    fireEvent.change(screen.getByPlaceholderText(/describe what you'd like/i), {
      target: { value: 'A very detailed feature request for the whole system' },
    });
    expect(screen.getByLabelText('Start interview')).toBeDisabled();
  });

  it('does not show the error message before the user touches the title field', () => {
    renderCompose();
    expect(screen.queryByText(/title is required/i)).not.toBeInTheDocument();
  });

  it('shows "A title is required" error after the title field is blurred empty', () => {
    renderCompose();
    const titleInput = screen.getByLabelText(/title/i);
    fireEvent.blur(titleInput);
    expect(screen.getByText(/a title is required/i)).toBeInTheDocument();
  });

  it('shows error and keeps focus on title field when Send is clicked without a title', async () => {
    renderCompose();
    fireEvent.change(screen.getByPlaceholderText(/describe what you'd like/i), {
      target: { value: 'Some request text' },
    });
    // Manually fire click on a disabled send button won't call handleSend,
    // so we trigger the keyboard shortcut from the textarea instead
    fireEvent.keyDown(screen.getByPlaceholderText(/describe what you'd like/i), {
      key: 'Enter',
      shiftKey: false,
    });
    await waitFor(() => {
      expect(screen.getByText(/a title is required/i)).toBeInTheDocument();
    });
    expect(startChatMutateAsync).not.toHaveBeenCalled();
  });

  it('send button becomes enabled when both title and message are filled', () => {
    renderCompose();
    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: 'Email Resend Feature' },
    });
    fireEvent.change(screen.getByPlaceholderText(/describe what you'd like/i), {
      target: { value: 'Add ability to resend notification emails' },
    });
    expect(screen.getByLabelText('Start interview')).not.toBeDisabled();
  });

  it('error message disappears once the user types a title', () => {
    renderCompose();
    const titleInput = screen.getByLabelText(/title/i);
    fireEvent.blur(titleInput);
    expect(screen.getByText(/a title is required/i)).toBeInTheDocument();

    fireEvent.change(titleInput, { target: { value: 'My feature' } });
    expect(screen.queryByText(/a title is required/i)).not.toBeInTheDocument();
  });

  it('creates the interview using the exact title the user entered', async () => {
    renderCompose();
    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: 'Email Resend Feature' },
    });
    fireEvent.change(screen.getByPlaceholderText(/describe what you'd like/i), {
      target: {
        value: 'As a user I want to be able to resend notification emails that may have been missed or lost in spam so that I never miss an important system communication',
      },
    });
    fireEvent.click(screen.getByLabelText('Start interview'));

    await waitFor(() => expect(createInterviewMutateAsync).toHaveBeenCalled());

    expect(createInterviewMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Email Resend Feature' }),
    );
  });

  it('does NOT truncate or auto-derive the title from the message body', async () => {
    const longMessage = 'A'.repeat(200);
    renderCompose();
    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: 'Short Title' },
    });
    fireEvent.change(screen.getByPlaceholderText(/describe what you'd like/i), {
      target: { value: longMessage },
    });
    fireEvent.click(screen.getByLabelText('Start interview'));

    await waitFor(() => expect(createInterviewMutateAsync).toHaveBeenCalled());

    const { title } = createInterviewMutateAsync.mock.calls[0][0];
    expect(title).toBe('Short Title');
    expect(title).not.toContain('A'.repeat(60));
  });

  it('posts the user message to the chat thread after creating the interview', async () => {
    renderCompose();
    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: 'My Interview' },
    });
    fireEvent.change(screen.getByPlaceholderText(/describe what you'd like/i), {
      target: { value: 'Tell me about the architecture' },
    });
    fireEvent.click(screen.getByLabelText('Start interview'));

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    const messageCall = (global.fetch as jest.Mock).mock.calls.find((c) =>
      String(c[0]).includes('/api/chat/threads/thread-abc/messages'),
    );
    expect(messageCall).toBeDefined();
    const body = JSON.parse(messageCall![1].body);
    expect(body.text).toBe('Tell me about the architecture');
  });

  it('passes the selected model into the chat thread kickoff and first message', async () => {
    renderCompose();
    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: 'Model Test Interview' },
    });
    fireEvent.change(screen.getByPlaceholderText(/describe what you'd like/i), {
      target: { value: 'Scope the feature' },
    });
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'claude-opus-4-6' },
    });
    fireEvent.click(screen.getByLabelText('Start interview'));

    await waitFor(() => expect(startChatMutateAsync).toHaveBeenCalled());

    expect(startChatMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        kickoff: expect.objectContaining({ model: 'claude-opus-4-6' }),
        skipAutoKickoff: true,
      }),
    );
    expect(createInterviewMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-4-6' }),
    );

    const messageCall = (global.fetch as jest.Mock).mock.calls.find((c) =>
      String(c[0]).includes('/api/chat/threads/thread-abc/messages'),
    );
    expect(JSON.parse(messageCall![1].body).model).toBe('claude-opus-4-6');
  });
});

// ── NewInterviewCompose — section owner modal ─────────────────────────────────

describe('NewInterviewCompose — section owner modal', () => {
  let startChatMutateAsync: jest.Mock;
  let createInterviewMutateAsync: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    startChatMutateAsync = jest.fn().mockResolvedValue({ threadId: 'thread-abc' });
    (useStartChat as jest.Mock).mockReturnValue({
      mutateAsync: startChatMutateAsync,
      isPending: false,
    });

    createInterviewMutateAsync = jest.fn().mockResolvedValue({ interviewId: 'iv-1' });
    (useCreateInterview as jest.Mock).mockReturnValue({
      mutateAsync: createInterviewMutateAsync,
      isPending: false,
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    }) as jest.Mock;
  });

  it('shows the SectionOwnerModal after Send is clicked with a valid title and message', async () => {
    MockSectionOwnerModal.mockImplementation(() => (
      <div data-testid="owner-modal">Owner Modal</div>
    ));

    renderCompose();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'My Interview' } });
    fireEvent.change(screen.getByPlaceholderText(/describe what you'd like/i), {
      target: { value: 'Some feature request text' },
    });
    fireEvent.click(screen.getByLabelText('Start interview'));

    await waitFor(() => {
      expect(screen.getByTestId('owner-modal')).toBeInTheDocument();
    });
    expect(createInterviewMutateAsync).not.toHaveBeenCalled();
  });

  it('passes selected owner IDs to createInterview when the modal is confirmed', async () => {
    MockSectionOwnerModal.mockImplementation(
      ({ onConfirm }: { onConfirm: (o: { prdOwnerId?: string; designDocOwnerId?: string }) => void }) => (
        <div data-testid="owner-modal">
          <button
            onClick={() => onConfirm({ prdOwnerId: 'user-prd', designDocOwnerId: 'user-dd' })}
          >
            Confirm
          </button>
        </div>
      ),
    );

    renderCompose();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Owners Interview' } });
    fireEvent.change(screen.getByPlaceholderText(/describe what you'd like/i), {
      target: { value: 'Please assign owners' },
    });
    fireEvent.click(screen.getByLabelText('Start interview'));

    await waitFor(() => expect(screen.getByTestId('owner-modal')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Confirm'));

    await waitFor(() => expect(createInterviewMutateAsync).toHaveBeenCalled());
    expect(createInterviewMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ prdOwnerId: 'user-prd', designDocOwnerId: 'user-dd' }),
    );
  });

  it('does NOT create the interview when the modal is cancelled', async () => {
    MockSectionOwnerModal.mockImplementation(
      ({ onCancel }: { onCancel: () => void }) => (
        <div data-testid="owner-modal">
          <button onClick={onCancel}>Cancel</button>
        </div>
      ),
    );

    renderCompose();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Cancel Owners Interview' } });
    fireEvent.change(screen.getByPlaceholderText(/describe what you'd like/i), {
      target: { value: 'Cancel and go back' },
    });
    fireEvent.click(screen.getByLabelText('Start interview'));

    await waitFor(() => expect(screen.getByTestId('owner-modal')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Cancel'));

    expect(createInterviewMutateAsync).not.toHaveBeenCalled();
    expect(screen.queryByTestId('owner-modal')).not.toBeInTheDocument();
  });
});

// ── NewInterviewCompose — no interview skill blocks submission ─────────────────

describe('NewInterviewCompose — no interview skill configured', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    (useProjectSkillConfig as jest.Mock).mockReturnValue({
      data: {
        id: 'settings-1',
        skillRepo: 'MaxView',
        skillBranch: 'main',
        interviewSkillPath: null,
      },
    });

    (useSkillList as jest.Mock).mockReturnValue({ data: [] });

    (useStartChat as jest.Mock).mockReturnValue({
      mutateAsync: jest.fn(),
      isPending: false,
    });

    (useCreateInterview as jest.Mock).mockReturnValue({
      mutateAsync: jest.fn(),
      isPending: false,
    });

    MockSectionOwnerModal.mockImplementation(() => null);
  });

  it('shows a warning pill when no interview skill is configured', () => {
    renderCompose();
    expect(screen.getByText(/no interview skill configured/i)).toBeInTheDocument();
  });

  it('shows an error message explaining the skill is missing', () => {
    renderCompose();
    expect(screen.getByText(/no interview skill is configured for this repo project/i)).toBeInTheDocument();
  });

  it('send button is disabled even when title and message are filled', () => {
    renderCompose();
    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: 'My Interview' },
    });
    fireEvent.change(screen.getByPlaceholderText(/describe what you'd like/i), {
      target: { value: 'Tell me about the architecture' },
    });
    expect(screen.getByLabelText('Start interview')).toBeDisabled();
  });

  it('does not show the skill hint paragraph', () => {
    renderCompose();
    expect(screen.queryByText(/skill will guide this structured interview/i)).not.toBeInTheDocument();
  });
});
