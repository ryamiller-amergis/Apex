import { type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProductHome } from '../ProductHome';
import { useChatThread } from '../../hooks/useChatThreads';
import type { ProductBuildSummary } from '../../../shared/types/productBuild';
import type { ProductBuildSetupStatus } from '../../hooks/useProductSetup';

const mockStartNext = jest.fn();

jest.mock('../../hooks/useChatThreads', () => ({
  useChatThread: jest.fn(),
}));

jest.mock('../../hooks/useUiLab', () => ({
  useUiLabDesign: jest.fn(() => ({
    data: {
      id: 'design-1',
      status: 'ready',
      html: '<html><body><h1>Preview</h1></body></html>',
    },
  })),
}));

jest.mock('../../hooks/useProductSetup', () => ({
  useStartNextProductBuild: () => ({
    mutate: mockStartNext,
    isPending: false,
    error: null,
  }),
}));

const summary: ProductBuildSummary = {
  id: 'build-1',
  kind: 'initial',
  status: 'merged',
  request: 'See today\'s tasks',
  summary: 'A person can see today\'s tasks.',
  createdAt: '2026-10-05T16:00:00.000Z',
  mergedAt: '2026-10-05T19:00:00.000Z',
  outOfScope: ['Reminders'],
  deferred: ['Sharing'],
  designId: 'design-1',
  chatThreadId: 'thread-1',
  adoWorkItemId: 4521,
  agentRunId: 'run-9',
  prUrl: 'https://dev.azure.com/org/project/_git/todo/pullrequest/9',
  checks: [{ kind: 'unit', outcome: 'passed' }, { kind: 'lint', outcome: 'failed' }],
};

function homeStatus(): ProductBuildSetupStatus {
  return {
    active: true,
    phase: 'build',
    skillPath: '.agents/skills/product-discovery/SKILL.md',
    model: 'gemini-3.8-flash',
    candidates: [],
    foundationAnswers: [],
    project: 'To Do App',
    build: {
      id: 'build-1',
      kind: 'initial',
      status: 'merged',
      project: 'To Do App',
      rfpRequestId: 'rfp-1',
      chatThreadId: 'thread-1',
      uiLabDesignId: 'design-1',
      prototypeVersion: 1,
      devSessionId: null,
      agentRunId: 'run-9',
      brief: null,
      requesterId: 'user-1',
      reviewerId: null,
      adoWorkItemId: 4521,
      prUrl: summary.prUrl,
      errorMessage: null,
      approvedAt: '2026-10-05T17:00:00.000Z',
      prOpenedAt: '2026-10-05T18:00:00.000Z',
      mergedAt: '2026-10-05T19:00:00.000Z',
      createdAt: summary.createdAt,
      updatedAt: '2026-10-05T19:00:00.000Z',
    },
    chatThreadId: 'thread-1',
    thread: null,
    design: {
      id: 'design-1',
      project: 'To Do App',
      authorId: 'user-1',
      title: 'Today',
      prompt: 'Preview',
      status: 'ready',
      html: '<html><body><h1>To Do</h1></body></html>',
      version: 1,
      history: [],
      createdAt: summary.createdAt,
      updatedAt: summary.mergedAt ?? summary.createdAt,
    },
    history: [summary],
  };
}

function renderHome() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<ProductHome project="To Do App" status={homeStatus()} />, { wrapper });
}

describe('ProductHome', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useChatThread as jest.Mock).mockReturnValue({
      data: {
        id: 'thread-1',
        messages: [
          { id: 'hidden', role: 'user', text: 'Internal kickoff', hidden: true, ts: '2026-10-05T16:00:00.000Z' },
          { id: 'ask', role: 'user', text: 'See today\'s tasks', ts: '2026-10-05T16:01:00.000Z' },
          { id: 'answer', role: 'agent', text: 'Should reminders wait?', ts: '2026-10-05T16:02:00.000Z' },
          { id: 'tool', role: 'tool', text: 'tool output', toolName: 'read', ts: '2026-10-05T16:03:00.000Z' },
        ],
      },
    });
  });

  it('shows the preview and does not start a build until the person sends a request', async () => {
    renderHome();

    expect(screen.getByTitle('Your app')).toHaveAttribute('sandbox', 'allow-scripts');
    expect(screen.getByTestId('product-home-prompt')).toBeInTheDocument();
    expect(mockStartNext).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('product-home-prompt'), {
      target: { value: 'Add a reminder for tomorrow' },
    });
    fireEvent.click(screen.getByTestId('product-home-send'));

    await waitFor(() => {
      expect(mockStartNext).toHaveBeenCalledTimes(1);
    });
    expect(mockStartNext).toHaveBeenCalledWith('Add a reminder for tomorrow');
  });

  it('opens a build card with details folded, then shows the review link inside details', () => {
    renderHome();

    expect(screen.queryByTestId('product-build-detail')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('product-build-card-build-1'));

    const details = screen.getByTestId('product-build-detail-details');
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByTestId('product-build-detail-request')).toHaveTextContent("See today's tasks");
    expect(screen.getByTestId('product-build-detail-message-ask')).toHaveTextContent("See today's tasks");
    expect(screen.getByTestId('product-build-detail-message-answer')).toHaveTextContent('Should reminders wait?');
    expect(screen.queryByText('Internal kickoff')).not.toBeInTheDocument();
    expect(screen.queryByText('tool output')).not.toBeInTheDocument();
    expect(screen.getByTestId('product-build-detail-checks')).toHaveTextContent('Unit tests: Pass');
    expect(screen.getByTestId('product-build-detail-checks')).toHaveTextContent('Lint: Fail');
    expect(screen.getByTestId('product-build-detail-preview')).toHaveAttribute('sandbox', 'allow-scripts');

    fireEvent.click(screen.getByTestId('product-build-detail-details-toggle'));
    expect(screen.getByTestId('product-build-pr')).toHaveAttribute('href', summary.prUrl);
    expect(screen.getByTestId('product-build-work-item')).toHaveTextContent('4521');
    expect(screen.getByTestId('product-build-run')).toHaveTextContent('run-9');
  });
});
