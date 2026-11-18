import type { ReactNode } from 'react';
import {
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrdAssistantPanel } from '../PrdAssistantPanel';

const mockSend = jest.fn();

jest.mock('../../hooks/useAgentChatSession', () => ({
  useAgentChatSession: () => ({
    messages: [],
    streamingText: '',
    isRunning: false,
    isSending: false,
    showTypingIndicator: false,
    progressLabel: null,
    progressPhase: null,
    toolProgress: [],
    send: (...args: unknown[]) => mockSend(...args),
    cancel: jest.fn(),
  }),
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PrdAssistantPanel
        prdId="prd-1"
        open
        onClose={jest.fn()}
        existingThreadId="thread-1"
      />
    </QueryClientProvider>
  );
}

describe('PrdAssistantPanel screenshot paste', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue(true);
  });

  it('adds a pasted image chip and sends that image with the typed text', async () => {
    renderPanel();

    const input = screen.getByTestId('prd-assistant-message-input');
    const pngBytes = Uint8Array.from([137, 80, 78, 71]);
    const image = new File([pngBytes], 'image.png', { type: 'image/png' });
    const paste = createEvent.paste(input, {
      clipboardData: {
        items: [{ kind: 'file', getAsFile: () => image }],
      },
    });
    fireEvent(input, paste);

    expect(
      await screen.findByText(/^screenshot-\d+-1\.png$/)
    ).toBeInTheDocument();

    fireEvent.change(input, {
      target: { value: 'What does this screen show?' },
    });
    fireEvent.click(screen.getByTestId('prd-assistant-send-btn'));

    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    const [text, options] = mockSend.mock.calls[0] as [
      string,
      {
        attachments: Array<{
          name: string;
          type: string;
          encoding?: string;
          content: string;
        }>;
      },
    ];
    expect(text).toBe('What does this screen show?');
    expect(options.attachments).toHaveLength(1);
    const attachment = options.attachments[0];
    expect(attachment.name).toMatch(/^screenshot-\d+-1\.png$/);
    expect(attachment.type).toBe('image/png');
    expect(attachment.encoding).toBe('base64');
    expect(attachment.content).toBe(btoa(String.fromCharCode(...pngBytes)));
  });
});
