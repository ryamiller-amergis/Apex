import { fireEvent, render, screen } from '@testing-library/react';
import type { CodeLabSession } from '../../../shared/types/codeLab';
import { CodeLabView } from '../CodeLabView';

const mutation = () => ({ mutate: jest.fn(), isPending: false, error: null, data: undefined });
const mockStart = mutation();
const mockActive = { isLoading: false, error: null, data: null as CodeLabSession | null };

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

jest.mock('../../hooks/useCodeLab', () => ({
  codeLabKeys: { diff: (id: string) => ['code-lab', 'diff', id] },
  useActiveCodeLabSession: () => mockActive,
  useStartCodeLabSession: () => mockStart,
  useStopCodeLabSession: () => mutation(),
  useRestartCodeLabPreview: () => mutation(),
  usePushCodeLabBranch: () => mutation(),
  useCodeLabDiff: () => ({ isLoading: false, error: null, data: undefined }),
  useCodeLabLogs: () => ({ data: undefined }),
}));

jest.mock('../../hooks/useAgentChatSession', () => ({
  useAgentChatSession: () => ({
    visibleMessages: [],
    streamingText: '',
    isRunning: false,
    isSending: false,
    isCancelling: false,
    showTypingIndicator: false,
    progressLabel: null,
    sendError: null,
    send: jest.fn(),
    cancel: jest.fn(),
  }),
}));

jest.mock('../agentChat', () => ({
  AgentTranscript: () => <div data-testid="transcript" />,
  AgentTypingIndicator: () => null,
  AgentComposer: () => <div data-testid="composer" />,
}));

function session(overrides: Partial<CodeLabSession> = {}): CodeLabSession {
  return {
    id: 's1',
    project: 'Apex',
    repo: 'Apex',
    baseBranch: 'main',
    branchName: 'code-lab/s1',
    status: 'ready',
    statusDetail: null,
    preview: { kind: 'vite', label: 'React + Vite', appDir: '.' },
    previewUrl: '/api/code-lab/preview/s1/tok/',
    chatThreadId: 't1',
    branchPushed: false,
    createdAt: '2026-10-22T00:00:00.000Z',
    lastActivityAt: '2026-10-22T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockActive.data = null;
});

describe('CodeLabView', () => {
  it('starts a session for the selected project', () => {
    render(<CodeLabView selectedProject="Apex" />);
    fireEvent.click(screen.getByTestId('code-lab-start'));
    expect(mockStart.mutate).toHaveBeenCalledWith({ project: 'Apex' });
  });

  it('renders the live preview in a sandbox without same-origin access', () => {
    mockActive.data = session();
    render(<CodeLabView selectedProject="Apex" />);
    const frame = screen.getByTestId('code-lab-preview-frame');
    expect(frame).toHaveAttribute('src', '/api/code-lab/preview/s1/tok/');
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(screen.getByTestId('code-lab-status')).toHaveTextContent('Live');
  });

  it('explains why the preview is unavailable for an unsupported stack', () => {
    mockActive.data = session({
      status: 'preview_unavailable',
      previewUrl: null,
      statusDetail: 'Next.js apps are not supported by the Code Lab preview yet.',
      preview: { kind: 'unsupported', label: 'Next.js', appDir: '.', reason: 'Next.js apps are not supported.' },
    });
    render(<CodeLabView selectedProject="Apex" />);
    expect(screen.getByText(/Next.js apps are not supported by the Code Lab preview yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('code-lab-preview-frame')).not.toBeInTheDocument();
  });
});
