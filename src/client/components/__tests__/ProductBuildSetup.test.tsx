import { type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProductBuildSetup } from '../ProductBuildSetup';
import { useChatThread } from '../../hooks/useChatThreads';
import { useAgentChatSession } from '../../hooks/useAgentChatSession';
import type { ProductBuild, ProductBuildBrief } from '../../../shared/types/productBuild';
import type { UiLabDesign } from '../../../shared/types/uiLab';
import type { ProductBuildSetupStatus } from '../../hooks/useProductSetup';

const mockSend = jest.fn().mockResolvedValue(undefined);
const mockCancel = jest.fn().mockResolvedValue(undefined);
const mockRetryLast = jest.fn();
const mockSync = jest.fn();
const mockRegenerate = jest.fn();
const mockApprove = jest.fn();
const mockStartNext = jest.fn();

let mockApprovePending = false;
let mockRegeneratePending = false;
let mockApproveError: Error | null = null;

jest.mock('../../hooks/useChatThreads', () => ({
  useChatThread: jest.fn(),
}));

jest.mock('../../hooks/useUiLab', () => ({
  useUiLabDesign: jest.fn(() => ({ data: undefined })),
}));

jest.mock('../../hooks/useAgentChatSession', () => ({
  useAgentChatSession: jest.fn(),
}));

jest.mock('../../hooks/useProductSetup', () => ({
  useSyncProductBuild: () => ({ mutate: mockSync, isPending: false, error: null }),
  useRegenerateProductPrototype: () => ({
    mutate: mockRegenerate,
    isPending: mockRegeneratePending,
    error: null,
  }),
  useApproveProductBuild: () => ({
    mutate: mockApprove,
    isPending: mockApprovePending,
    error: mockApproveError,
  }),
  useStartNextProductBuild: () => ({
    mutate: mockStartNext,
    isPending: false,
    error: null,
  }),
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => children,
}));

jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: jest.fn(),
}));

const KICKOFF = "Let's get started. Read PRODUCT.md, summarize it, and propose the smallest usable initial build that fits one pull request.";

const brief: ProductBuildBrief = {
  version: 1,
  kind: 'initial',
  product: {
    name: 'Benefits Tracker',
    audience: 'Employees',
    problem: 'People cannot tell which benefits they can use.',
    scopeSummary: 'The product will eventually cover enrollment, claims status, and dependent updates.',
    successCriteria: ['An employee can see the benefits they are enrolled in.'],
  },
  initialBuild: {
    summary: 'An employee can sign in and see enrolled benefits.',
    coreWorkflow: 'Sign in, open My Benefits, and read the current enrollments.',
    personas: [{ name: 'Employee', goal: 'See which benefits are active.' }],
    screens: [{ name: 'My Benefits', purpose: 'List current enrollments.' }],
    data: [{ name: 'Enrollment', fields: ['plan name', 'coverage start'] }],
    integrations: [],
    auth: 'Company sign-in. One employee role.',
    visualDirection: 'Calm, readable, and close to the company intranet.',
    nonFunctionalRequirements: ['The benefits list loads with the page.'],
    acceptanceCriteria: [{ id: 'AC-1', statement: 'A signed-in employee sees each enrolled plan name.' }],
    outOfScope: ['Editing enrollments'],
    deferred: ['Claims status'],
  },
  stack: {
    client: 'React + TypeScript + Vite',
    server: 'Express',
    database: 'PostgreSQL',
    overrideReason: null,
  },
  deployment: {
    localSetup: 'npm install, then npm run dev',
    migrations: 'node-pg-migrate',
    ci: 'lint, typecheck, unit tests, and build',
    hosting: 'Document the deploy path. A hosted preview comes later.',
  },
  singlePr: {
    fitsSinglePr: true,
    rationale: 'One screen, one table, and one acceptance criterion fit in one pull request.',
  },
  confirmedBy: null,
  confirmedAt: null,
};

function build(overrides: Partial<ProductBuild> = {}): ProductBuild {
  return {
    id: 'build-1',
    kind: 'initial',
    status: 'discovery',
    project: 'Benefits Tracker',
    rfpRequestId: 'rfp-1',
    chatThreadId: 'thread-1',
    uiLabDesignId: null,
    prototypeVersion: null,
    devSessionId: null,
    agentRunId: null,
    brief: null,
    requesterId: 'user-1',
    reviewerId: null,
    adoWorkItemId: null,
    prUrl: null,
    errorMessage: null,
    approvedAt: null,
    prOpenedAt: null,
    mergedAt: null,
    createdAt: '2026-10-05T16:00:00.000Z',
    updatedAt: '2026-10-05T16:00:00.000Z',
    ...overrides,
  };
}

function status(overrides: Partial<ProductBuild> = {}, design: UiLabDesign | null = null): ProductBuildSetupStatus {
  const current = build(overrides);
  return {
    active: true,
    phase: 'build',
    skillPath: '.agents/skills/product-discovery/SKILL.md',
    model: 'gemini-3.8-flash',
    candidates: [],
    foundationAnswers: [],
    project: 'Benefits Tracker',
    build: current,
    chatThreadId: current.chatThreadId,
    thread: null,
    design,
    history: [],
  };
}

const readyDesign: UiLabDesign = {
  id: 'design-1',
  project: 'Benefits Tracker',
  authorId: 'user-1',
  title: 'My Benefits',
  prompt: 'Prototype only this initial build.',
  status: 'ready',
  html: '<html><body><h1>My Benefits</h1></body></html>',
  version: 2,
  history: [
    {
      version: 1,
      html: '<html><body>First pass</body></html>',
      feedback: 'First pass',
      createdAt: '2026-10-05T16:00:00.000Z',
    },
    {
      version: 2,
      html: '<html><body><h1>My Benefits</h1></body></html>',
      createdAt: '2026-10-05T16:05:00.000Z',
    },
  ],
  createdAt: '2026-10-05T16:00:00.000Z',
  updatedAt: '2026-10-05T16:05:00.000Z',
};

function idleSession(overrides: Record<string, unknown> = {}) {
  return {
    visibleMessages: [
      { id: 'kickoff', role: 'user', text: KICKOFF, ts: '2026-10-05T16:00:00.000Z' },
      { id: 'reply', role: 'agent', text: 'The smallest pull request is My Benefits.', ts: '2026-10-05T16:01:00.000Z' },
    ],
    streamingText: 'Asking about auth.',
    progressLabel: 'Reading PRODUCT.md',
    isRunning: false,
    isSending: false,
    isInteractionBusy: false,
    isAwaitingAgentResponse: false,
    sendError: null,
    hasConnectionError: false,
    showTypingIndicator: false,
    send: mockSend,
    cancel: mockCancel,
    retryLast: mockRetryLast,
    ...overrides,
  };
}

function renderSetup(value: ProductBuildSetupStatus) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProductBuildSetup project="Benefits Tracker" status={value} />
    </QueryClientProvider>,
  );
}

describe('ProductBuildSetup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApprovePending = false;
    mockRegeneratePending = false;
    mockApproveError = null;
    (useChatThread as jest.Mock).mockReturnValue({
      data: {
        id: 'thread-1',
        status: 'idle',
        messages: [{ id: 'kickoff', role: 'user', text: KICKOFF, ts: '2026-10-05T16:00:00.000Z' }],
      },
    });
    (useAgentChatSession as jest.Mock).mockReturnValue(idleSession());
  });

  it('shows the planning heading and sends one answer through the shared chat session', async () => {
    renderSetup(status());

    expect(screen.getByRole('heading', { name: "Let's plan your app" })).toBeInTheDocument();
    expect(screen.getByTestId('product-build-intro')).toHaveTextContent(
      "We'll ask a few questions, then show you a preview of this build.",
    );
    expect(screen.getByText(KICKOFF)).toBeInTheDocument();
    expect(screen.getByText('The smallest pull request is My Benefits.')).toBeInTheDocument();
    expect(screen.getByTestId('product-build-streaming')).toHaveTextContent('Asking about auth.');
    expect(screen.getByTestId('product-build-progress')).toHaveTextContent('Reading PRODUCT.md');
    expect(useChatThread).toHaveBeenCalledWith('thread-1');
    expect(useAgentChatSession).toHaveBeenCalledWith('thread-1', expect.objectContaining({
      enablePreparationState: true,
      initialStatus: 'idle',
      initialMessages: [expect.objectContaining({ text: KICKOFF })],
    }));

    fireEvent.change(screen.getByTestId('product-build-answer'), {
      target: { value: 'Keep the first pull request to My Benefits.' },
    });
    fireEvent.click(screen.getByTestId('product-build-send'));

    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith('Keep the first pull request to My Benefits.');
    });
  });

  it('stops a running turn and retries a failed send', () => {
    (useAgentChatSession as jest.Mock).mockReturnValue(idleSession({
      isRunning: true,
      isInteractionBusy: true,
      streamingText: '',
      progressLabel: 'Writing the build brief',
    }));
    const { rerender } = renderSetup(status());

    fireEvent.click(screen.getByTestId('product-build-stop'));
    expect(mockCancel).toHaveBeenCalled();
    expect(screen.queryByTestId('product-build-send')).not.toBeInTheDocument();

    (useAgentChatSession as jest.Mock).mockReturnValue(idleSession({
      sendError: 'The message did not send.',
      streamingText: '',
      progressLabel: null,
    }));
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ProductBuildSetup project="Benefits Tracker" status={status()} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The message did not send.');
    fireEvent.click(screen.getByTestId('product-build-retry'));
    expect(mockRetryLast).toHaveBeenCalled();
  });

  it('shows an accessible generating state before the prototype is ready', () => {
    renderSetup(status(
      { status: 'prototype', brief, uiLabDesignId: 'design-1' },
      { ...readyDesign, status: 'generating', html: null, history: [] },
    ));

    const generating = screen.getByTestId('product-build-generating');
    expect(generating).toHaveAttribute('role', 'status');
    expect(generating).toHaveAttribute('aria-busy', 'true');
    expect(generating).toHaveTextContent(/prototype/i);
    expect(screen.queryByTitle(/UI mock/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('product-build-approve')).toBeDisabled();
    expect(screen.queryByTestId('product-build-answer-form')).not.toBeInTheDocument();
  });

  it('previews the sandboxed prototype, shows deferred scope, and regenerates from feedback', () => {
    renderSetup(status(
      { status: 'prototype', brief, uiLabDesignId: 'design-1', prototypeVersion: 2 },
      readyDesign,
    ));

    const frame = screen.getByTitle('UI mock v2');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(frame).toHaveAttribute('srcdoc', readyDesign.html);
    expect(screen.getByLabelText('Version:')).toBeInTheDocument();
    expect(screen.getByTestId('product-build-summary')).toHaveTextContent(brief.initialBuild.summary);
    expect(screen.getByTestId('product-build-out-of-scope')).toHaveTextContent('Editing enrollments');
    expect(screen.getByTestId('product-build-deferred')).toHaveTextContent('Claims status');
    expect(screen.getByTestId('product-build-approve')).toHaveTextContent('Build this');
    expect(screen.getByTestId('product-build-approve-note')).toHaveTextContent(
      "We'll build this and let you know when it's ready to review.",
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen preview' }));
    fireEvent.click(screen.getByRole('button', { name: /Suggest changes/i }));
    fireEvent.change(screen.getByPlaceholderText(/Describe the changes/i), {
      target: { value: 'Larger type' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Regenerate/i }));

    expect(mockRegenerate).toHaveBeenCalledWith({ buildId: 'build-1', feedback: 'Larger type' });
  });

  it('disables approval while a prototype change is in progress and shows the server error', () => {
    mockRegeneratePending = true;
    const { rerender } = renderSetup(status(
      { status: 'prototype', brief, uiLabDesignId: 'design-1', prototypeVersion: 2 },
      readyDesign,
    ));
    expect(screen.getByTestId('product-build-approve')).toBeDisabled();

    mockRegeneratePending = false;
    mockApproveError = new Error('Ryan Miller is not an Apex user, so this build cannot be approved yet.');
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ProductBuildSetup
          project="Benefits Tracker"
          status={status(
            { status: 'prototype', brief, uiLabDesignId: 'design-1', prototypeVersion: 2 },
            readyDesign,
          )}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Ryan Miller is not an Apex user, so this build cannot be approved yet.');
    expect(screen.getByTestId('product-build-error-guidance')).toHaveTextContent(/try again/i);
    fireEvent.click(screen.getByTestId('product-build-error-retry'));
    expect(mockApprove).toHaveBeenCalledWith('build-1');
  });

  it('shows the status label while building, and keeps review details folded on the card', () => {
    const summary = {
      id: 'build-1',
      kind: 'initial' as const,
      status: 'building' as const,
      request: 'See enrolled benefits',
      summary: brief.initialBuild.summary,
      createdAt: '2026-10-05T16:00:00.000Z',
      mergedAt: null,
      outOfScope: brief.initialBuild.outOfScope,
      deferred: brief.initialBuild.deferred,
      designId: 'design-1',
      chatThreadId: 'thread-1',
      adoWorkItemId: 4521,
      agentRunId: 'run-9',
      prUrl: null,
      checks: [],
    };
    const { rerender } = renderSetup({
      ...status({
        status: 'building',
        brief,
        approvedAt: '2026-10-05T17:00:00.000Z',
        adoWorkItemId: 4521,
        agentRunId: 'run-9',
      }, readyDesign),
      history: [summary],
    });

    expect(screen.getByRole('heading', { name: 'Building' })).toBeInTheDocument();
    expect(screen.queryByTestId('product-build-approve')).not.toBeInTheDocument();
    expect(screen.queryByTestId('product-build-pr')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('product-build-card-build-1'));
    const details = screen.getByTestId('product-build-detail-details');
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByTestId('product-build-detail')).toBeInTheDocument();

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ProductBuildSetup
          project="Benefits Tracker"
          status={{
            ...status({
              status: 'pr-open',
              brief,
              approvedAt: '2026-10-05T17:00:00.000Z',
              adoWorkItemId: 4521,
              agentRunId: 'run-9',
              prUrl: 'https://dev.azure.com/org/project/_git/benefits/pullrequest/9',
            }, readyDesign),
            history: [{
              ...summary,
              status: 'pr-open',
              prUrl: 'https://dev.azure.com/org/project/_git/benefits/pullrequest/9',
            }],
          }}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Ready for review' })).toBeInTheDocument();
  });

  it('uses the person\'s request as the heading for a later build', () => {
    renderSetup({
      ...status({ kind: 'feature', brief }),
      history: [{
        id: 'build-1',
        kind: 'feature',
        status: 'discovery',
        request: 'Add a reminder for tomorrow',
        summary: '',
        createdAt: '2026-10-05T16:00:00.000Z',
        mergedAt: null,
        outOfScope: [],
        deferred: [],
        designId: null,
        chatThreadId: 'thread-1',
        adoWorkItemId: null,
        agentRunId: null,
        prUrl: null,
        checks: [],
      }],
    });

    expect(screen.getByRole('heading', { name: 'Add a reminder for tomorrow' })).toBeInTheDocument();
  });
});
