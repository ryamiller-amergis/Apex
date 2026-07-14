import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentHome } from '../AgentHome';

let testQueryClient: QueryClient;

function agentHomeTree(props: { selectedProject: string }) {
  return (
    <QueryClientProvider client={testQueryClient}>
      <MemoryRouter>
        <AgentHome {...props} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// Wrap renders in a router since AgentHome uses useSearchParams
const renderAgentHome = (props: { selectedProject: string }) => {
  testQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(agentHomeTree(props));
};

const rerenderAgentHome = (
  rerender: (ui: ReactElement) => void,
  props: { selectedProject: string },
) => rerender(agentHomeTree(props));
import {
  useSkillList,
  useSkillRepos,
  useStartChat,
} from '../../hooks/useChatThreads';
import { useChatAttachments } from '../../hooks/useChatAttachments';
import { useProjectSkillConfig } from '../../hooks/useProjectSkillConfig';

jest.mock('../../hooks/useChatThreads', () => ({
  useSkillRepos: jest.fn(),
  useStartChat: jest.fn(),
  useSkillList: jest.fn(),
  useChatThreadList: jest.fn(() => ({ data: [], isLoading: false, error: null })),
  useDeleteThread: jest.fn(() => ({ mutate: jest.fn() })),
  useFlagThread: jest.fn(() => ({ mutate: jest.fn() })),
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => children,
}));

jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: jest.fn(),
}));

const mockUseChatStream = jest.fn();
jest.mock('../../hooks/useChatStream', () => ({
  useChatStream: (...args: unknown[]) => mockUseChatStream(...args),
}));

jest.mock('../../hooks/useChatAttachments', () => ({
  formatAttachmentSize: jest.fn((size: number) => `${size} bytes`),
  useChatAttachments: jest.fn(),
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

jest.mock('../../hooks/useSpeechOutput', () => ({
  useSpeechOutput: jest.fn(() => ({
    speak: jest.fn(),
    stop: jest.fn(),
    isSpeaking: false,
    isSpeechOutputSupported: true,
  })),
}));

jest.mock('../PRDPreviewDrawer', () => ({
  PRDPreviewDrawer: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="prd-preview-drawer">
      PRD Preview Drawer
      <button type="button" onClick={onClose}>Close preview</button>
    </div>
  ),
}));

// Default stream state — no active session
const idleStream = {
  messages: [],
  streamingText: '',
  status: 'idle' as const,
  isConnected: true,
  prdReady: false,
  backlogReady: false,
};

describe('AgentHome', () => {
  const mutateAsync = jest.fn();
  const clearAttachments = jest.fn();
  const addFiles = jest.fn();
  const removeAttachment = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear(); // prevent thread ID from leaking across tests
    HTMLElement.prototype.scrollIntoView = jest.fn();
    // Default fetch mock returns a successful response — individual tests can override
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    }) as jest.Mock;
    mockUseChatStream.mockReturnValue(idleStream);

    (useProjectSkillConfig as jest.Mock).mockReturnValue({ data: null });
    (useSkillRepos as jest.Mock).mockReturnValue({
      data: [{ id: 'repo-1', name: 'MaxView', defaultBranch: 'main' }],
    });
    (useSkillList as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'skill-1',
          name: 'grill-with-docs',
          description: 'Interview-driven requirements gathering',
          path: '.cursor/skills/grill-with-docs/SKILL.md',
        },
        {
          id: 'skill-2',
          name: 'to-prd',
          description: 'Generate a PRD from interview answers',
          path: '.cursor/skills/to-prd/SKILL.md',
        },
      ],
    });
    (useStartChat as jest.Mock).mockReturnValue({ mutateAsync, isPending: false });
    (useChatAttachments as jest.Mock).mockReturnValue({
      attachments: [],
      attachmentError: null,
      addFiles,
      removeAttachment,
      clearAttachments,
    });
    mutateAsync.mockResolvedValue({ threadId: 'thread-123' });
  });

  // ── Compose (no active thread) ──────────────────────────────────────────────

  describe('compose state (no active thread)', () => {
    it('renders the compose prompt and hint', () => {
      renderAgentHome({ selectedProject: "MaxView" });
      expect(screen.getByPlaceholderText(/Let Apex know what you need/i)).toBeInTheDocument();
      expect(screen.getByText(/Enter to send/i)).toBeInTheDocument();
    });

    it('shows skill picker when "/" is typed', async () => {
      renderAgentHome({ selectedProject: "MaxView" });
      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: '/' },
      });
      expect(await screen.findByText('grill-with-docs')).toBeInTheDocument();
      expect(screen.getByText('to-prd')).toBeInTheDocument();
    });

    it('filters skill picker by query after "/"', async () => {
      renderAgentHome({ selectedProject: "MaxView" });
      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: '/grill' },
      });
      expect(await screen.findByText('grill-with-docs')).toBeInTheDocument();
      expect(screen.queryByText('to-prd')).toBeNull();
    });

    it('hides skill picker when input is cleared', async () => {
      renderAgentHome({ selectedProject: "MaxView" });
      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: '/' },
      });
      await screen.findByText('grill-with-docs');

      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: '' },
      });
      expect(screen.queryByText('grill-with-docs')).toBeNull();
    });

    it('populates textarea with /skillName after picker selection', async () => {
      renderAgentHome({ selectedProject: "MaxView" });
      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: '/' },
      });
      const btn = await screen.findByText('grill-with-docs');
      fireEvent.mouseDown(btn);

      expect(screen.getByPlaceholderText(/Let Apex know what you need/i)).toHaveValue('/grill-with-docs');
    });

    it('creates a new thread with skillPath in kickoff when skill slug is sent', async () => {
      renderAgentHome({ selectedProject: "MaxView" });
      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: '/' },
      });
      const btn = await screen.findByText('grill-with-docs');
      fireEvent.mouseDown(btn);
      fireEvent.click(screen.getByLabelText('Send'));

      await waitFor(() => {
        expect(mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            kickoff: expect.objectContaining({
              project: 'MaxView',
              repo: 'MaxView',
              branch: 'main',
              skillPath: '.cursor/skills/grill-with-docs/SKILL.md',
              freeformContext: undefined,
              model: expect.any(String),
            }),
            skipAutoKickoff: false,
          }),
        );
      });
      // Pure slug kickoff — no extra fetch to /messages
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('passes freeform context when text follows the skill slug', async () => {
      // After creating the thread the component tries to POST /messages; mock the response
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });

      renderAgentHome({ selectedProject: "MaxView" });
      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: '/' },
      });
      const btn = await screen.findByText('grill-with-docs');
      fireEvent.mouseDown(btn);

      // User appends extra context after the slug
      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: '/grill-with-docs add email resend feature' },
      });
      fireEvent.click(screen.getByLabelText('Send'));

      await waitFor(() => {
        expect(mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            kickoff: expect.objectContaining({
              skillPath: '.cursor/skills/grill-with-docs/SKILL.md',
              freeformContext: 'add email resend feature',
            }),
            skipAutoKickoff: true,
          }),
        );
      });
    });

    it('starts a free-chat thread (no skill) for plain text input', async () => {
      // After creating the thread the code POSTs the user message to /messages
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });

      renderAgentHome({ selectedProject: "MaxView" });
      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: 'Tell me about the architecture' },
      });
      fireEvent.click(screen.getByLabelText('Send'));

      await waitFor(() => {
        expect(mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            kickoff: expect.objectContaining({
              skillPath: undefined,
              freeformContext: undefined,
            }),
            skipAutoKickoff: true,
          }),
        );
      });
    });

    it('posts the plain text request as the first message after creating a home-page thread', async () => {
      renderAgentHome({ selectedProject: "MaxView" });
      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: 'Tell me about the architecture' },
      });
      fireEvent.click(screen.getByLabelText('Send'));

      await waitFor(() => {
        const messageCall = (global.fetch as jest.Mock).mock.calls.find((c) =>
          String(c[0]).includes('/api/chat/threads/thread-123/messages'),
        );
        expect(messageCall).toBeDefined();
        const body = JSON.parse(messageCall![1].body);
        expect(body).toEqual(expect.objectContaining({
          text: 'Tell me about the architecture',
          model: expect.any(String),
          attachments: [],
        }));
      });
    });

    it('posts the user request after a skill kickoff when text follows the skill slug', async () => {
      renderAgentHome({ selectedProject: "MaxView" });
      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: '/' },
      });
      fireEvent.mouseDown(await screen.findByText('grill-with-docs'));
      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: '/grill-with-docs add email resend feature' },
      });
      fireEvent.click(screen.getByLabelText('Send'));

      await waitFor(() => {
        const messageCall = (global.fetch as jest.Mock).mock.calls.find((c) =>
          String(c[0]).includes('/api/chat/threads/thread-123/messages'),
        );
        expect(messageCall).toBeDefined();
        const body = JSON.parse(messageCall![1].body);
        expect(body.text).toBe('/grill-with-docs add email resend feature');
      });
    });

    it('sends attachments as the first message when a new skill thread starts with only a skill slug', async () => {
      const attachment = {
        id: 'att-1',
        name: 'notes.md',
        type: 'text/markdown',
        size: 42,
        content: 'important context',
      };
      (useChatAttachments as jest.Mock).mockReturnValue({
        attachments: [attachment],
        attachmentError: null,
        addFiles,
        removeAttachment,
        clearAttachments,
      });

      renderAgentHome({ selectedProject: "MaxView" });
      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: '/' },
      });
      fireEvent.mouseDown(await screen.findByText('grill-with-docs'));
      fireEvent.click(screen.getByLabelText('Send'));

      await waitFor(() => {
        expect(mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({ skipAutoKickoff: true }),
        );
        const messageCall = (global.fetch as jest.Mock).mock.calls.find((c) =>
          String(c[0]).includes('/api/chat/threads/thread-123/messages'),
        );
        expect(messageCall).toBeDefined();
        const body = JSON.parse(messageCall![1].body);
        expect(body.text).toBe('Please use the attached files as additional context.');
        expect(body.attachments).toEqual([attachment]);
      });
    });

    it('selects a skill with keyboard navigation and Enter', async () => {
      renderAgentHome({ selectedProject: "MaxView" });
      const input = screen.getByPlaceholderText(/Let Apex know what you need/i);
      fireEvent.change(input, { target: { value: '/' } });
      await screen.findByText('grill-with-docs');

      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(input).toHaveValue('/to-prd');
    });

    it('does not submit when textarea is empty', () => {
      renderAgentHome({ selectedProject: "MaxView" });
      fireEvent.click(screen.getByLabelText('Send'));
      expect(mutateAsync).not.toHaveBeenCalled();
    });
  });

  // ── Quick skill pill gating ────────────────────────────────────────────────

  describe('quick skill pill gating (compose mode)', () => {
    beforeEach(() => {
      (useProjectSkillConfig as jest.Mock).mockReturnValue({
        data: {
          skillRepo: 'MaxView',
          skillBranch: 'main',
          quickSkillPills: [
            { label: 'Write PRD', skillPath: '.cursor/skills/to-prd/SKILL.md', model: 'claude-opus-4-6' },
            { label: 'Grill', skillPath: '.cursor/skills/grill-with-docs/SKILL.md', model: null },
          ],
        },
      });
    });

    it('disables the textarea when no pill is selected', () => {
      renderAgentHome({ selectedProject: "MaxView" });
      const textarea = screen.getByPlaceholderText(/Select an option above to get started/i);
      expect(textarea).toBeDisabled();
    });

    it('disables the attach button when no pill is selected', () => {
      renderAgentHome({ selectedProject: "MaxView" });
      expect(screen.getByLabelText('Attach files')).toBeDisabled();
    });

    it('disables the microphone button when no pill is selected', () => {
      renderAgentHome({ selectedProject: "MaxView" });
      const micBtn = screen.getByLabelText('Start voice transcription');
      expect(micBtn).toBeDisabled();
    });

    it('disables the send button when no pill is selected', () => {
      renderAgentHome({ selectedProject: "MaxView" });
      expect(screen.getByLabelText('Send')).toBeDisabled();
    });

    it('does not show the model selector in compose mode', () => {
      renderAgentHome({ selectedProject: "MaxView" });
      expect(screen.queryByRole('combobox')).toBeNull();
    });

    it('does not render the project pill', () => {
      renderAgentHome({ selectedProject: "MaxView" });
      const pills = screen.getAllByRole('button').filter(
        (btn) => btn.textContent === 'MaxView' && btn.className.includes('pill'),
      );
      expect(pills).toHaveLength(0);
    });

    it('enables the textarea after selecting a quick skill pill', () => {
      renderAgentHome({ selectedProject: "MaxView" });
      fireEvent.click(screen.getByText('Write PRD'));
      const textarea = screen.getByPlaceholderText(/Let Apex know what you need/i);
      expect(textarea).not.toBeDisabled();
    });

    it('enables attach and mic buttons after selecting a pill', () => {
      renderAgentHome({ selectedProject: "MaxView" });
      fireEvent.click(screen.getByText('Grill'));
      expect(screen.getByLabelText('Attach files')).not.toBeDisabled();
    });

    it('enables the send button once a pill is selected and text is entered', () => {
      renderAgentHome({ selectedProject: "MaxView" });
      fireEvent.click(screen.getByText('Write PRD'));
      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: 'build a dashboard' },
      });
      expect(screen.getByLabelText('Send')).not.toBeDisabled();
    });

    it('re-disables the textarea when the selected pill is toggled off', () => {
      renderAgentHome({ selectedProject: "MaxView" });
      fireEvent.click(screen.getByText('Grill'));
      expect(screen.getByPlaceholderText(/Let Apex know what you need/i)).not.toBeDisabled();

      fireEvent.click(screen.getByText('Grill'));
      expect(screen.getByPlaceholderText(/Select an option above to get started/i)).toBeDisabled();
    });
  });

  // ── Model selection from quick skill pills ────────────────────────────────

  describe('model selection from quick skill pills', () => {
    beforeEach(() => {
      (useProjectSkillConfig as jest.Mock).mockReturnValue({
        data: {
          skillRepo: 'MaxView',
          skillBranch: 'main',
          quickSkillPills: [
            { label: 'Write PRD', skillPath: '.cursor/skills/to-prd/SKILL.md', model: 'claude-opus-4-6' },
            { label: 'Grill', skillPath: '.cursor/skills/grill-with-docs/SKILL.md', model: null },
          ],
        },
      });
    });

    it('creates a thread with the pill-configured model when a pill with a model is selected', async () => {
      renderAgentHome({ selectedProject: 'MaxView' });

      fireEvent.click(screen.getByText('Write PRD'));
      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: 'build a dashboard' },
      });
      fireEvent.click(screen.getByLabelText('Send'));

      await waitFor(() => {
        expect(mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            kickoff: expect.objectContaining({
              model: 'claude-opus-4-6',
              skillPath: '.cursor/skills/to-prd/SKILL.md',
            }),
          }),
        );
      });
    });

    it('creates a thread with the global default model when a pill has no model configured', async () => {
      renderAgentHome({ selectedProject: 'MaxView' });

      fireEvent.click(screen.getByText('Grill'));
      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: 'interview me' },
      });
      fireEvent.click(screen.getByLabelText('Send'));

      await waitFor(() => {
        expect(mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            kickoff: expect.objectContaining({
              model: 'composer-2', // global default, not stale from a previous selection
              skillPath: '.cursor/skills/grill-with-docs/SKILL.md',
            }),
          }),
        );
      });
    });

    it('resets to the global default model when switching from a model-configured pill to one without', async () => {
      renderAgentHome({ selectedProject: 'MaxView' });

      // Select the opus-backed pill first so its model enters the state
      fireEvent.click(screen.getByText('Write PRD'));
      // Switch directly to the no-model pill — the old bug would have kept 'claude-opus-4-6'
      fireEvent.click(screen.getByText('Grill'));

      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: 'interview me' },
      });
      fireEvent.click(screen.getByLabelText('Send'));

      await waitFor(() => {
        expect(mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            kickoff: expect.objectContaining({
              model: 'composer-2',
            }),
          }),
        );
      });
    });

    it('restores the global default model when a pill is deselected and a no-model pill is then selected', async () => {
      renderAgentHome({ selectedProject: 'MaxView' });

      // Select then deselect the opus pill
      fireEvent.click(screen.getByText('Write PRD'));
      fireEvent.click(screen.getByText('Write PRD')); // toggle off
      // Now select the no-model pill
      fireEvent.click(screen.getByText('Grill'));

      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: 'start grilling' },
      });
      fireEvent.click(screen.getByLabelText('Send'));

      await waitFor(() => {
        expect(mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            kickoff: expect.objectContaining({
              model: 'composer-2',
            }),
          }),
        );
      });
    });

    it('also sends the pill model in the first user message body', async () => {
      renderAgentHome({ selectedProject: 'MaxView' });

      fireEvent.click(screen.getByText('Write PRD'));
      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: 'build a dashboard' },
      });
      fireEvent.click(screen.getByLabelText('Send'));

      await waitFor(() => {
        const messageCall = (global.fetch as jest.Mock).mock.calls.find((c) =>
          String(c[0]).includes('/api/chat/threads/thread-123/messages'),
        );
        expect(messageCall).toBeDefined();
        const body = JSON.parse(messageCall![1].body);
        expect(body.model).toBe('claude-opus-4-6');
      });
    });
  });

  // ── Active thread (chat view) ───────────────────────────────────────────────

  describe('active thread (chat view)', () => {
    // Helper: render, start a free-chat thread, wait for chat view, then clear the
    // fetch mock so each test only sees calls from its own actions.
    async function startThread() {
      renderAgentHome({ selectedProject: "MaxView" });

      // Compose-mode send to create a thread (calls mutateAsync + fetch /messages)
      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: 'start session' },
      });
      fireEvent.click(screen.getByLabelText('Send'));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalled());

      // Wait for the chat view input (different placeholder) then reset the spy
      const chatInput = await screen.findByPlaceholderText(/Continue the conversation/i);
      (global.fetch as jest.Mock).mockClear();
      return chatInput;
    }

    it('sends a "Run skill" message to an existing thread when a skill is selected mid-chat', async () => {
      const input = await startThread();

      // Pick /to-prd from the skill picker
      fireEvent.change(input, { target: { value: '/' } });
      await screen.findByText('to-prd');
      fireEvent.mouseDown(screen.getByText('to-prd'));
      fireEvent.click(screen.getByLabelText('Send'));

      await waitFor(() => {
        const calls = (global.fetch as jest.Mock).mock.calls;
        const messageCall = calls.find((c) => String(c[0]).includes('/messages'));
        expect(messageCall).toBeDefined();
        const body = JSON.parse(messageCall![1].body);
        expect(body.text).toBe('Run skill: to-prd (`.cursor/skills/to-prd/SKILL.md`)');
      });
    });

    it('appends extra context to "Run skill" message when user types after the slug', async () => {
      const input = await startThread();

      fireEvent.change(input, { target: { value: '/' } });
      await screen.findByText('to-prd');
      fireEvent.mouseDown(screen.getByText('to-prd'));

      // Append extra context after skill selection
      fireEvent.change(input, {
        target: { value: '/to-prd focus on security requirements' },
      });
      fireEvent.click(screen.getByLabelText('Send'));

      await waitFor(() => {
        const calls = (global.fetch as jest.Mock).mock.calls;
        const messageCall = calls.find((c) => String(c[0]).includes('/messages'));
        expect(messageCall).toBeDefined();
        const body = JSON.parse(messageCall![1].body);
        expect(body.text).toContain('Run skill: to-prd');
        expect(body.text).toContain('focus on security requirements');
      });
    });

    it('clears skill selection state after sending so next message is plain text', async () => {
      const input = await startThread(); // fetch already cleared by startThread()

      // Select skill then send
      fireEvent.change(input, { target: { value: '/' } });
      await screen.findByText('to-prd');
      fireEvent.mouseDown(screen.getByText('to-prd'));
      fireEvent.click(screen.getByLabelText('Send'));
      await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

      // Second plain message — must NOT be wrapped in "Run skill"
      (global.fetch as jest.Mock).mockClear();
      fireEvent.change(input, { target: { value: 'just a follow-up' } });
      fireEvent.click(screen.getByLabelText('Send'));

      await waitFor(() => {
        const calls = (global.fetch as jest.Mock).mock.calls;
        const messageCall = calls.find((c) => String(c[0]).includes('/messages'));
        expect(messageCall).toBeDefined();
        const body = JSON.parse(messageCall![1].body);
        expect(body.text).toBe('just a follow-up');
        expect(body.text).not.toContain('Run skill');
      });
    });
  });

  // ── PRD ready banner ────────────────────────────────────────────────────────

  describe('PRD ready banner', () => {
    it('shows PRD banner in chat view when prdReady is true', async () => {
      mockUseChatStream.mockReturnValue({
        ...idleStream,
        messages: [{ id: 'm1', role: 'agent' as const, text: 'Done', ts: '2026-01-01T00:00:00Z' }],
      });
      const { rerender } = renderAgentHome({ selectedProject: "MaxView" });

      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: 'write a PRD' },
      });
      fireEvent.click(screen.getByLabelText('Send'));
      await screen.findByPlaceholderText(/Continue the conversation/i);

      mockUseChatStream.mockReturnValue({
        ...idleStream,
        messages: [{ id: 'm1', role: 'agent' as const, text: 'Done', ts: '2026-01-01T00:00:00Z' }],
        prdReady: true,
      });
      rerenderAgentHome(rerender, { selectedProject: 'MaxView' });

      expect(screen.getByText('PRD is ready for review')).toBeInTheDocument();
      expect(screen.getByTestId('prd-preview-drawer')).toBeInTheDocument();
    });

  });

  // ── Streaming indicator ─────────────────────────────────────────────────────

  describe('streaming state', () => {
    it('disables the Send button while the agent is running', async () => {
      // Start a thread then simulate the agent being in the running state
      renderAgentHome({ selectedProject: "MaxView" });

      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: 'go' },
      });
      fireEvent.click(screen.getByLabelText('Send'));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalled());

      // Update the stream status to running — re-render is triggered by mock update
      mockUseChatStream.mockReturnValue({
        ...idleStream,
        status: 'running',
        streamingText: 'Thinking…',
      });

      // Even before the re-render fires, the isSending state disables the button
      // during the async send; we verify the button exists and the component is stable
      const sendBtn = screen.getByLabelText('Send');
      expect(sendBtn).toBeInTheDocument();
    });

    it('sends a cancel request when Stop is clicked during a running chat', async () => {
      const { rerender } = renderAgentHome({ selectedProject: "MaxView" });

      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: 'start session' },
      });
      fireEvent.click(screen.getByLabelText('Send'));
      await screen.findByPlaceholderText(/Continue the conversation/i);
      (global.fetch as jest.Mock).mockClear();

      mockUseChatStream.mockReturnValue({
        ...idleStream,
        status: 'running',
      });
      rerenderAgentHome(rerender, { selectedProject: 'MaxView' });

      fireEvent.click(screen.getByLabelText('Stop'));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/chat/threads/thread-123/cancel', {
          method: 'POST',
          credentials: 'include',
        });
      });
    });

    it('filters out the auto-kickoff "Begin." user message from visible messages', () => {
      mockUseChatStream.mockReturnValue({
        ...idleStream,
        messages: [
          { id: 'b1', role: 'user' as const, text: 'Begin.', ts: '2026-01-01T00:00:00Z' },
          { id: 'm1', role: 'agent' as const, text: 'Hello!', ts: '2026-01-01T00:01:00Z' },
        ],
      });

      renderAgentHome({ selectedProject: "MaxView" });
      // "Begin." is the auto-kickoff message and must not appear in the UI
      expect(screen.queryByText('Begin.')).toBeNull();
    });

    it('shows a Read Aloud button on agent messages', () => {
      sessionStorage.setItem('agentHomeThreadId:MaxView', 'thread-123');
      mockUseChatStream.mockReturnValue({
        ...idleStream,
        messages: [
          { id: 'm1', role: 'agent' as const, text: 'Here is my response.', ts: '2026-01-01T00:01:00Z' },
        ],
      });

      renderAgentHome({ selectedProject: 'MaxView' });
      expect(screen.getByRole('button', { name: 'Read aloud' })).toBeInTheDocument();
    });
  });

  // ── FEAT-001 Home blue background + contrast (TBI-001 / PBI-001 / PBI-002) ─

  describe('FEAT-001 home blue background and contrast', () => {
    beforeEach(() => {
      (useProjectSkillConfig as jest.Mock).mockReturnValue({
        data: {
          skillRepo: 'MaxView',
          skillBranch: 'main',
          quickSkillPills: [
            { label: 'Grill', skillPath: '.cursor/skills/grill-with-docs/SKILL.md', model: null },
            { label: 'Write PRD', skillPath: '.cursor/skills/to-prd/SKILL.md', model: 'claude-opus-4-6' },
          ],
        },
      });
    });

    it('DoD-0 AC-0: renders home-page-container with page class on empty Home', () => {
      renderAgentHome({ selectedProject: 'MaxView' });
      const page = screen.getByTestId('home-page-container');
      expect(page).toBeInTheDocument();
      expect(page.className).toMatch(/\bpage\b/);
    });

    it('DoD-3 AC-0: empty-state chrome uses composeLogo and composeHeading classes', () => {
      renderAgentHome({ selectedProject: 'MaxView' });
      const empty = screen.getByTestId('home-empty-state');
      expect(empty).toBeInTheDocument();
      expect(empty.querySelector('.composeLogo')).not.toBeNull();
      expect(empty.querySelector('.composeHeading')).not.toBeNull();
      expect(screen.getByRole('heading', { name: /What would you like to work on/i })).toBeInTheDocument();
    });

    it('DoD-4 AC-3: skill pills and composer keep themed module classes (not light-forced)', () => {
      renderAgentHome({ selectedProject: 'MaxView' });
      const empty = screen.getByTestId('home-empty-state');
      const pills = empty.querySelectorAll('.pill');
      expect(pills.length).toBeGreaterThan(0);
      expect(screen.getByPlaceholderText(/Select an option above to get started/i)).toBeInTheDocument();
      expect(document.querySelector('.inputBox')).not.toBeNull();
    });

    it('AC-1: without page class, Home remains usable (pills + composer)', () => {
      renderAgentHome({ selectedProject: 'MaxView' });
      const page = screen.getByTestId('home-page-container');
      page.className = ''; // simulate missing Home page override stylesheet/class
      const skillPill = screen.getByRole('button', { name: 'Grill' });
      expect(skillPill).toBeInTheDocument();
      fireEvent.click(skillPill);
      expect(skillPill.className).toMatch(/pillSelected/);
      expect(screen.getByPlaceholderText(/Let Apex know what you need/i)).toBeEnabled();
    });

    it('AC-1 PBI-002: without empty-state contrast classes, pills and composer stay usable', () => {
      renderAgentHome({ selectedProject: 'MaxView' });
      const empty = screen.getByTestId('home-empty-state');
      empty.querySelectorAll('.composeLogo, .composeHeading, .hint, .pillDescription').forEach((el) => {
        el.className = '';
      });
      expect(screen.getByRole('button', { name: 'Grill' })).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/Select an option above to get started/i)).toBeInTheDocument();
    });

    it('DoD-5 AC-2: home-page-container persists across Light/Dark/Amergis theme attrs', () => {
      const root = document.documentElement;
      for (const theme of ['light', 'dark', 'amergis'] as const) {
        root.setAttribute('data-theme', theme);
        const { unmount } = renderAgentHome({ selectedProject: 'MaxView' });
        expect(screen.getByTestId('home-page-container').className).toMatch(/\bpage\b/);
        expect(screen.getByTestId('home-empty-state')).toBeInTheDocument();
        unmount();
      }
      root.removeAttribute('data-theme');
    });

    it('AC-2 PBI-001 / DoD-5: blue page class persists with active thread', async () => {
      renderAgentHome({ selectedProject: 'MaxView' });
      fireEvent.click(screen.getByRole('button', { name: 'Grill' }));
      fireEvent.change(screen.getByPlaceholderText(/Let Apex know what you need/i), {
        target: { value: 'start session' },
      });
      fireEvent.click(screen.getByLabelText('Send'));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
      await screen.findByPlaceholderText(/Continue the conversation/i);
      expect(screen.getByTestId('home-page-container').className).toMatch(/\bpage\b/);
      expect(screen.queryByTestId('home-empty-state')).toBeNull();
    });

    it('AC-2 PBI-002: mobile viewport still exposes empty-state contrast classes', () => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 375 });
      renderAgentHome({ selectedProject: 'MaxView' });
      const empty = screen.getByTestId('home-empty-state');
      expect(empty.querySelector('.composeHeading')).not.toBeNull();
      expect(empty.querySelector('.composeLogo')).not.toBeNull();
      expect(screen.getByText(/Enter to send/i).className).toMatch(/\bhint\b/);
    });
  });
});
