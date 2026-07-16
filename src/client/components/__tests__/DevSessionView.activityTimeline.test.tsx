import { render, screen } from '@testing-library/react';
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
  useSessionConflicts: jest.fn(),
  useResolveConflict: jest.fn(),
  useCompleteMerge: jest.fn(),
  useAbortMerge: jest.fn(),
}));

import {
  useChatThread,
  useSendMessage,
  useCancelRun,
} from '../../hooks/useChatThreads';
import { useChatStream } from '../../hooks/useChatStream';
import {
  useDevSession,
  useDevDiff,
  usePushBranch,
  useCreatePr,
} from '../../hooks/useDevWorkbench';

describe('DevSessionView activity timeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-14T12:10:00Z'));

    (useDevSession as jest.Mock).mockReturnValue({
      data: {
        id: 'session-1',
        chatThreadId: 'thread-1',
        branchName: 'feature/reliable-session',
        status: 'in_progress',
        setupError: null,
        createdAt: '2026-07-14T12:00:00Z',
      },
    });
    (useChatThread as jest.Mock).mockReturnValue({
      data: { id: 'thread-1', messages: [], status: 'running' },
    });
    (useChatStream as jest.Mock).mockReturnValue({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          text: 'Make sessions reliable',
          ts: '2026-07-14T12:00:00Z',
        },
        {
          id: 'thinking-1',
          role: 'tool',
          toolName: '_thinking',
          text: 'RAW PRIVATE MODEL THOUGHT',
          ts: '2026-07-14T12:01:00Z',
        },
        {
          id: 'edit-1',
          role: 'tool',
          toolName: 'edit_file',
          text: 'raw tool result',
          ts: '2026-07-14T12:02:00Z',
          toolInput: { path: 'src/client/example.tsx' },
        },
      ],
      streamingText: '',
      thinkingText: 'live private thought',
      toolProgress: [],
      status: 'running',
      isConnected: true,
      lastProgressAt: new Date('2026-07-14T12:09:50Z').getTime(),
      phaseEvents: [
        {
          id: 'phase-1',
          runId: 'run-1',
          phase: 'typecheck',
          status: 'running',
          detail: 'Checking client types',
          timestamp: new Date('2026-07-14T12:09:50Z').getTime(),
        },
      ],
      runHealth: null,
      isRetrying: false,
      retryReason: null,
    });
    (useSendMessage as jest.Mock).mockReturnValue({ mutateAsync: jest.fn() });
    (useCancelRun as jest.Mock).mockReturnValue({ mutate: jest.fn() });
    (useDevDiff as jest.Mock).mockReturnValue({
      data: {
        diffText: '',
        changedFiles: [],
        branch: 'feature/reliable-session',
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
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('integrates grouped activity without rendering historical or live raw thinking', () => {
    render(
      <MemoryRouter initialEntries={['/my-work/session/session-1']}>
        <Routes>
          <Route
            path="/my-work/session/:sessionId"
            element={<DevSessionView />}
          />
        </Routes>
      </MemoryRouter>
    );

    expect(
      screen.getByRole('region', { name: 'Agent activity' })
    ).toBeInTheDocument();
    expect(screen.getByText('Planning and analysis')).toBeInTheDocument();
    expect(screen.getByText('Implementation')).toBeInTheDocument();
    expect(
      screen.getByText('Type-check').closest('[data-state]')
    ).toHaveAttribute('data-state', 'current');
    expect(screen.getByText('Checking client types')).toBeInTheDocument();
    expect(
      screen.queryByText('RAW PRIVATE MODEL THOUGHT')
    ).not.toBeInTheDocument();
    expect(screen.queryByText('live private thought')).not.toBeInTheDocument();
  });
});
