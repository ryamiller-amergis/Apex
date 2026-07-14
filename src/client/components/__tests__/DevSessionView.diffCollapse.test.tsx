import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DevSessionView } from '../DevSessionView';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

jest.mock('remark-gfm', () => jest.fn());

jest.mock('../../hooks/useChatThreads', () => ({
  useChatThread: jest.fn(),
  useSendMessage: jest.fn(),
  useCancelRun: jest.fn(),
}));

jest.mock('../../hooks/useChatStream', () => ({
  useChatStream: jest.fn(),
}));

jest.mock('../../hooks/useDevWorkbench', () => ({
  useDevSession: jest.fn(),
  useDevDiff: jest.fn(),
  usePushBranch: jest.fn(),
  useCreatePr: jest.fn(),
}));

import { useChatThread, useSendMessage, useCancelRun } from '../../hooks/useChatThreads';
import { useChatStream } from '../../hooks/useChatStream';
import { useDevSession, useDevDiff, usePushBranch, useCreatePr } from '../../hooks/useDevWorkbench';

const diffText = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1,2 @@',
  ' context a',
  '+added in file a',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1 +1,2 @@',
  ' context b',
  '+added in file b',
].join('\n');

function renderSessionView() {
  return render(
    <MemoryRouter initialEntries={['/my-work/session/session-1']}>
      <Routes>
        <Route path="/my-work/session/:sessionId" element={<DevSessionView />} />
      </Routes>
    </MemoryRouter>,
  );
}

function setupMocks() {
  (useDevSession as jest.Mock).mockReturnValue({
    data: {
      id: 'session-1',
      workItemId: 42,
      chatThreadId: 'thread-1',
      branchName: 'feature/42',
      status: 'in_progress',
      setupError: null,
      createdAt: '2026-06-01T00:00:00Z',
    },
  });

  (useChatThread as jest.Mock).mockReturnValue({
    data: {
      id: 'thread-1',
      messages: [],
      status: 'idle',
    },
  });

  (useChatStream as jest.Mock).mockReturnValue({
    messages: [],
    streamingText: '',
    thinkingText: '',
    toolProgress: [],
    status: 'idle',
    isConnected: true,
    lastProgressAt: null,
    isRetrying: false,
    retryReason: null,
  });

  (useSendMessage as jest.Mock).mockReturnValue({
    mutateAsync: jest.fn(),
  });

  (useCancelRun as jest.Mock).mockReturnValue({
    mutateAsync: jest.fn(),
  });

  (useDevDiff as jest.Mock).mockReturnValue({
    data: {
      diffText,
      changedFiles: ['src/a.ts', 'src/b.ts'],
      branch: 'feature/42',
    },
    refetch: jest.fn(),
  });

  (usePushBranch as jest.Mock).mockReturnValue({
    mutateAsync: jest.fn(),
    isPending: false,
    error: null,
  });

  (useCreatePr as jest.Mock).mockReturnValue({
    mutateAsync: jest.fn(),
    isPending: false,
    error: null,
  });
}

function getFileHeader(path: string) {
  return screen.getByRole('button', { name: new RegExp(path.replace('.', '\\.')) });
}

describe('DevSessionView — diff expand/collapse', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupMocks();
  });

  it('renders changed files collapsed by default', () => {
    renderSessionView();

    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('src/b.ts')).toBeInTheDocument();
    expect(screen.queryByText('added in file a')).not.toBeInTheDocument();
    expect(screen.queryByText('added in file b')).not.toBeInTheDocument();
    expect(within(getFileHeader('src/a.ts')).getByText('▶')).toBeInTheDocument();
    expect(within(getFileHeader('src/b.ts')).getByText('▶')).toBeInTheDocument();
  });

  it('expands and collapses an individual file when its header is clicked', () => {
    renderSessionView();

    const fileAHeader = getFileHeader('src/a.ts');

    fireEvent.click(fileAHeader);
    expect(screen.getByText('added in file a')).toBeInTheDocument();
    expect(screen.queryByText('added in file b')).not.toBeInTheDocument();
    expect(within(fileAHeader).getByText('▼')).toBeInTheDocument();

    fireEvent.click(fileAHeader);
    expect(screen.queryByText('added in file a')).not.toBeInTheDocument();
    expect(within(fileAHeader).getByText('▶')).toBeInTheDocument();
  });

  it('expands all files when Expand all is clicked', () => {
    renderSessionView();

    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));

    expect(screen.getByText('added in file a')).toBeInTheDocument();
    expect(screen.getByText('added in file b')).toBeInTheDocument();
    expect(within(getFileHeader('src/a.ts')).getByText('▼')).toBeInTheDocument();
    expect(within(getFileHeader('src/b.ts')).getByText('▼')).toBeInTheDocument();
  });

  it('collapses all files when Collapse all is clicked', () => {
    renderSessionView();

    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByText('added in file a')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));

    expect(screen.queryByText('added in file a')).not.toBeInTheDocument();
    expect(screen.queryByText('added in file b')).not.toBeInTheDocument();
    expect(within(getFileHeader('src/a.ts')).getByText('▶')).toBeInTheDocument();
    expect(within(getFileHeader('src/b.ts')).getByText('▶')).toBeInTheDocument();
  });
});
