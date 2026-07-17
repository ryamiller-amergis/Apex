import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdrChatView } from '../AdrChatView';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => jest.fn(),
}));

const startChat = jest.fn();
const createAdr = jest.fn();
const clearAttachments = jest.fn();

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    selectedProject: 'Apex',
    selectedSkillSettingsId: null,
    authenticatedUser: { name: 'ADR Owner' },
    permissionsLoaded: true,
    can: () => true,
  }),
}));

jest.mock('../../hooks/useChatThreads', () => ({
  useSkillRepos: () => ({ data: [{ name: 'Apex', defaultBranch: 'main' }] }),
  useStartChat: () => ({ mutateAsync: startChat, isPending: false }),
  useChatThread: () => ({ data: null }),
}));

jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useProjectSkillConfig: () => ({ data: null }),
  useGlobalDefaultModel: () => ({ data: { value: 'composer-2' } }),
  useAvailableModels: () => ({ data: [{ id: 'composer-2', displayName: 'Composer 2' }] }),
}));

jest.mock('../../hooks/useAdrs', () => ({
  useCreateAdr: () => ({ mutateAsync: createAdr, isPending: false }),
}));

jest.mock('../../hooks/useChatAttachments', () => ({
  useChatAttachments: () => ({
    attachments: [{
      id: 'attachment-1',
      name: 'constraints.txt',
      size: 12,
      type: 'text/plain',
      content: 'must remain backward compatible',
    }],
    attachmentError: null,
    addFiles: jest.fn(),
    removeAttachment: jest.fn(),
    clearAttachments,
  }),
  formatAttachmentSize: () => '12B',
}));

jest.mock('../../hooks/useSpeechInput', () => ({
  useSpeechInput: () => ({
    isListening: false,
    isSpeechSupported: true,
    speechError: null,
    toggle: jest.fn(),
    stop: jest.fn(),
  }),
}));

jest.mock('../AdrReviewerModal', () => ({
  AdrReviewerModal: ({ onConfirm }: { onConfirm: (ids: string[]) => void }) => (
    <button type="button" onClick={() => onConfirm(['reviewer-1'])}>Confirm reviewers</button>
  ),
}));

describe('NewAdrCompose', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    startChat.mockResolvedValue({ threadId: 'thread-1' });
    createAdr.mockResolvedValue({ adrId: 'adr-1', threadId: 'thread-1' });
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as jest.Mock;
  });

  it('opens reviewer selection and sends reviewers plus attachments', async () => {
    render(
      <MemoryRouter initialEntries={['/adr/new']}>
        <AdrChatView />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Choose event transport' } });
    fireEvent.change(screen.getByPlaceholderText(/describe what is being built/i), {
      target: { value: 'Compare queue and event-stream options.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start ADR' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm reviewers' }));

    await waitFor(() => expect(createAdr).toHaveBeenCalledWith(expect.objectContaining({
      reviewerIds: ['reviewer-1'],
      title: 'Choose event transport',
    })));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/chat/threads/thread-1/messages',
      expect.objectContaining({
        body: expect.stringContaining('"constraints.txt"'),
      }),
    );
    expect(clearAttachments).toHaveBeenCalled();
  });
});
