import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  activitySummaryLabel,
  BuildWorkspace,
  derivePipelineSteps,
  groupChatMessagesIntoTurns,
} from '../BuildWorkspace';
import {
  BuildApiError,
  useAcceptBuild,
  useBuild,
  useBuildEvents,
  useBuildRepositories,
  useCancelBuild,
  useConfirmBuildIntake,
  useEnsureBuildPlanning,
  useRequestBuildRevision,
  useResumeBuild,
  useStartBuild,
} from '../../hooks/useBuilds';
import { useInterview } from '../../hooks/useInterviews';
import { useChatThread } from '../../hooks/useChatThreads';
import { useAgentChatSession } from '../../hooks/useAgentChatSession';
import { useAvailableModels } from '../../hooks/useProjectSkillConfig';

jest.mock('../../hooks/useBuilds', () => {
  const actual = jest.requireActual('../../hooks/useBuilds');
  return {
    ...actual,
    useBuildRepositories: jest.fn(),
    useStartBuild: jest.fn(),
    useBuild: jest.fn(),
    useBuildEvents: jest.fn(),
    useConfirmBuildIntake: jest.fn(),
    useEnsureBuildPlanning: jest.fn(),
    useAcceptBuild: jest.fn(),
    useRequestBuildRevision: jest.fn(),
    useCancelBuild: jest.fn(),
    useResumeBuild: jest.fn(),
  };
});

jest.mock('../../hooks/useInterviews', () => ({
  useInterview: jest.fn(),
}));

jest.mock('../../hooks/useChatThreads', () => ({
  useChatThread: jest.fn(),
}));

jest.mock('../../hooks/useAgentChatSession', () => ({
  useAgentChatSession: jest.fn(),
}));

jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useAvailableModels: jest.fn(),
}));

const mockRepos = useBuildRepositories as jest.Mock;
const mockStartBuild = useStartBuild as jest.Mock;
const mockUseBuild = useBuild as jest.Mock;
const mockUseBuildEvents = useBuildEvents as jest.Mock;
const mockConfirmIntake = useConfirmBuildIntake as jest.Mock;
const mockEnsurePlanning = useEnsureBuildPlanning as jest.Mock;
const mockAcceptBuild = useAcceptBuild as jest.Mock;
const mockRequestRevision = useRequestBuildRevision as jest.Mock;
const mockCancelBuild = useCancelBuild as jest.Mock;
const mockResumeBuild = useResumeBuild as jest.Mock;
const mockUseInterview = useInterview as jest.Mock;
const mockUseChatThread = useChatThread as jest.Mock;
const mockUseAgentChat = useAgentChatSession as jest.Mock;
const mockAvailableModels = useAvailableModels as jest.Mock;

function baseDetail(overrides: Record<string, unknown> = {}) {
  return {
    build: {
      id: '16dd6dcc-595d-48b8-8da8-1110751a2320',
      project: 'Amergis Connect - ATS',
      repository: 'Amergis Connect - ATS',
      status: 'intake',
      currentRevisionNumber: 1,
      intakeInterviewId: 'iv-1',
      createdAt: '2026-11-04T04:09:49.610Z',
      endedAt: null,
    },
    stage: {
      kind: 'stage',
      key: 'intake',
      tasks: null,
      queuePosition: null,
      suspendReason: null,
    },
    timing: {
      elapsedSeconds: 45,
      targetSeconds: 3600,
      state: 'within',
      includesDeployment: true,
    },
    caps: {
      cost: { usedUsd: '0.0000', limitUsd: '25.0000' },
      revisions: { used: 0, limit: 5 },
      elapsedSeconds: { used: 45, limit: 14400 },
      parallelism: { used: 0, limit: 4 },
    },
    supportContacts: [{ displayName: 'Ryan Miller', email: 'ryan@example.test' }],
    revisions: [
      {
        number: 1,
        createdAt: '2026-11-04T04:11:03.302Z',
        classification: 'full',
        deploymentStatus: 'not_started',
        previewUrl: null,
      },
    ],
    currentRevision: {
      number: 1,
      classification: 'full',
      repairAttempts: 0,
      brief: {
        status: 'ok',
        overview: null,
        requirements: [
          { id: 'AC-1', kind: 'ac', text: 'Renders calendar on the home page', retired: false },
        ],
        assumptions: ['Signed-in users can view the calendar'],
        exclusions: [],
        riskDecisions: [],
      },
      tasks: [],
    },
    verificationSummary: { total: 1, pass: 0, fail: 0, deferred: 0, retired: 0 },
    lease: null,
    ...overrides,
  };
}

const LocationProbe: React.FC = () => {
  const location = useLocation();
  return <span {...{ 'data-testid': 'location' }}>{location.pathname}</span>;
};

describe('BuildWorkspace (Brainstorm-style unified build UX)', () => {
  const startMutateAsync = jest.fn();
  const confirmMutateAsync = jest.fn();
  const ensurePlanningMutate = jest.fn();
  const acceptMutateAsync = jest.fn();
  const revisionMutateAsync = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockAvailableModels.mockReturnValue({
      isLoading: false,
      data: [{ id: 'composer-2.5', displayName: 'Composer 2.5' }],
    });
    mockRepos.mockReturnValue({
      isLoading: false,
      isSuccess: true,
      data: {
        repositories: [
          { repository: 'Amergis Connect - ATS', label: 'Amergis Connect - ATS' },
        ],
      },
    });
    mockStartBuild.mockReturnValue({
      mutateAsync: startMutateAsync,
      isPending: false,
      isError: false,
      error: null,
    });
    mockConfirmIntake.mockReturnValue({
      mutateAsync: confirmMutateAsync,
      isPending: false,
    });
    mockEnsurePlanning.mockReturnValue({
      mutate: ensurePlanningMutate,
      isPending: false,
    });
    mockAcceptBuild.mockReturnValue({
      mutateAsync: acceptMutateAsync,
      isPending: false,
    });
    mockRequestRevision.mockReturnValue({
      mutateAsync: revisionMutateAsync,
      isPending: false,
    });
    mockCancelBuild.mockReturnValue({ mutateAsync: jest.fn(), isPending: false });
    mockResumeBuild.mockReturnValue({ mutateAsync: jest.fn(), isPending: false });
    mockUseBuild.mockReturnValue({
      data: null,
      isLoading: false,
      refetch: jest.fn(),
    });
    mockUseBuildEvents.mockReturnValue({
      data: { events: [], total: 0 },
      refetch: jest.fn(),
    });
    mockUseInterview.mockReturnValue({
      data: { id: 'iv-1', chatThreadId: 'thread-1' },
    });
    mockUseChatThread.mockReturnValue({
      data: { id: 'thread-1', messages: [], status: 'idle', activeRunId: null },
    });
    mockUseAgentChat.mockReturnValue({
      messages: [],
      streamingText: '',
      isRunning: false,
      isSending: false,
      isPreparing: false,
      isAwaitingAgentResponse: false,
      isCancelling: false,
      progressLabel: null,
      progressPhase: null,
      toolProgress: [],
      sendError: null,
      send: jest.fn().mockResolvedValue(true),
      cancel: jest.fn(),
    });
  });

  it('derives pipeline step states across intake, planning, building, checking, and PR', () => {
    expect(derivePipelineSteps('intake', false).map((s) => s.state)).toEqual([
      'active',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(derivePipelineSteps('planning', false).map((s) => s.state)).toEqual([
      'done',
      'active',
      'pending',
      'pending',
      'pending',
    ]);
    expect(derivePipelineSteps('accepted', true).map((s) => s.state)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
    ]);
  });

  it('renders New Build mode in the split workspace and navigates directly to /builds/:id on submit', async () => {
    startMutateAsync.mockResolvedValue({
      buildRunId: '16dd6dcc-595d-48b8-8da8-1110751a2320',
      playbookRunId: 'pb-1',
      status: 'intake',
      queuePosition: null,
      queueReason: null,
      replayed: false,
    });

    render(
      <MemoryRouter initialEntries={['/builds/new']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <BuildWorkspace project="Amergis Connect - ATS" />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('build-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('build-workspace-empty')).toBeInTheDocument();
    expect(screen.getByTestId('build-workspace-sandbox-frame')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('build-workspace-composer-input'), {
      target: { value: 'Add a calendar component to the home page' },
    });
    fireEvent.click(screen.getByTestId('build-workspace-composer-send'));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/builds/16dd6dcc-595d-48b8-8da8-1110751a2320',
      ),
    );
    expect(startMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: 'Amergis Connect - ATS',
        prompt: 'Add a calendar component to the home page',
      }),
    );
  });

  it('displays preflight refusals in the error banner when startBuild fails', () => {
    mockStartBuild.mockReturnValue({
      mutateAsync: startMutateAsync,
      isPending: false,
      isError: true,
      error: new BuildApiError(
        409,
        '2 things need fixing before this build can start.',
        'BUILD_PREFLIGHT_REFUSED',
        ['No deploy pipeline is set.', 'No quality manifest path is set.'],
      ),
    });

    render(
      <MemoryRouter initialEntries={['/builds/new']}>
        <BuildWorkspace project="Amergis Connect - ATS" />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('build-workspace-error-banner')).toHaveTextContent(
      '2 things need fixing before this build can start.',
    );
    expect(screen.getByTestId('build-workspace-refusal-list').querySelectorAll('li')).toHaveLength(
      2,
    );
  });

  it('groups _reasoning, _thinking, and tool rows into Brainstorm-style collapsible activity traces', () => {
    const grouped = groupChatMessagesIntoTurns([
      { id: 'u1', role: 'user', text: 'Build a calendar', ts: '2026-11-04T05:00:00Z' },
      {
        id: 'r1',
        role: 'agent',
        toolName: '_reasoning',
        text: 'Loading repository grounding docs so intake defaults match the product.',
        ts: '2026-11-04T05:00:01Z',
      },
      {
        id: 't1',
        role: 'tool',
        toolName: 'read_file',
        text: '.cursor/CODEMAP.md',
        ts: '2026-11-04T05:00:02Z',
      },
      {
        id: 'a1',
        role: 'agent',
        text: 'Here is the calendar summary.',
        ts: '2026-11-04T05:00:03Z',
      },
    ]);

    expect(grouped.turns).toHaveLength(2);
    expect(grouped.turns[1].activity).toHaveLength(2);
    expect(activitySummaryLabel(grouped.turns[1].activity)).toBe('Thought process · 1 step');
    expect(grouped.pendingActivity).toEqual([]);
  });

  it('renders intake conversation, live thought process trace, and Confirm & Start Build action', async () => {
    mockUseBuild.mockReturnValue({
      data: baseDetail({ build: { ...baseDetail().build, status: 'intake' } }),
      isLoading: false,
      refetch: jest.fn(),
    });
    mockUseAgentChat.mockReturnValue({
      messages: [
        { id: 'm1', role: 'user', text: 'Add a calendar component to the home page', ts: '1' },
        {
          id: 'm1-think',
          role: 'agent',
          toolName: '_reasoning',
          text: 'Inspecting .cursor/CODEMAP.md for existing home route.',
          ts: '2',
        },
        {
          id: 'm2',
          role: 'agent',
          text: "I'll add a monthly calendar widget to the home page.\n\n[[build-intake:confirm]]\nDoes this match what you want?\na. Confirm\nb. Change it",
          ts: '3',
        },
      ],
      streamingText: '',
      thinkingText: '',
      isRunning: false,
      isSending: false,
      isPreparing: false,
      isAwaitingAgentResponse: false,
      isCancelling: false,
      progressLabel: null,
      progressPhase: null,
      toolProgress: [],
      sendError: null,
      send: jest.fn().mockResolvedValue(true),
      cancel: jest.fn(),
    });

    render(
      <MemoryRouter initialEntries={['/builds/16dd6dcc-595d-48b8-8da8-1110751a2320']}>
        <BuildWorkspace
          project="Amergis Connect - ATS"
          buildId="16dd6dcc-595d-48b8-8da8-1110751a2320"
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('build-workspace-user-msg')).toHaveTextContent(
      'Add a calendar component to the home page',
    );
    expect(screen.getByTestId('build-workspace-thought-process')).toHaveTextContent(
      'Thought process',
    );
    expect(screen.getByTestId('build-workspace-confirm-bar')).toBeInTheDocument();
  });

  it('triggers ensurePlanning on planning status and renders live autonomous activity and task pills', () => {
    mockUseBuild.mockReturnValue({
      data: baseDetail({
        build: { ...baseDetail().build, status: 'planning' },
        currentRevision: {
          ...baseDetail().currentRevision,
          tasks: [
            {
              key: 't-impl-1',
              role: 'implementer',
              dependsOn: [],
              ownedFiles: ['apps/web/src/features/calendar/CalendarWidget.tsx'],
              reuse: [],
              runMode: 'own_agent',
              branch: 'apex/build/16dd6dcc/t-impl-1-1',
              status: 'running',
              attempt: 1,
              omittedReason: null,
            },
          ],
        },
      }),
      isLoading: false,
      refetch: jest.fn(),
    });
    mockUseBuildEvents.mockReturnValue({
      data: {
        events: [
          {
            id: 'ev-1',
            occurredAt: '2026-11-04T04:11:53.210Z',
            kind: 'build.planning_started',
            message: 'Planning started',
            taskKey: null,
          },
        ],
        total: 1,
      },
      refetch: jest.fn(),
    });

    render(
      <MemoryRouter initialEntries={['/builds/16dd6dcc-595d-48b8-8da8-1110751a2320']}>
        <BuildWorkspace
          project="Amergis Connect - ATS"
          buildId="16dd6dcc-595d-48b8-8da8-1110751a2320"
        />
      </MemoryRouter>,
    );

    expect(ensurePlanningMutate).toHaveBeenCalledWith({});
    expect(screen.getByTestId('build-workspace-autonomous-card')).toBeInTheDocument();
    expect(screen.getByTestId('build-workspace-event-row')).toHaveTextContent('Planning started');
    expect(screen.getByTestId('build-workspace-task-pill-t-impl-1')).toHaveTextContent(
      't-impl-1· running',
    );
  });

  it('renders Create Pull Request when preview_ready and View Pull Request link once accepted', async () => {
    acceptMutateAsync.mockResolvedValue({ status: 'accepted' });

    const { rerender } = render(
      <MemoryRouter initialEntries={['/builds/16dd6dcc-595d-48b8-8da8-1110751a2320']}>
        <BuildWorkspace
          project="Amergis Connect - ATS"
          buildId="16dd6dcc-595d-48b8-8da8-1110751a2320"
        />
      </MemoryRouter>,
    );

    mockUseBuild.mockReturnValue({
      data: baseDetail({
        build: { ...baseDetail().build, status: 'preview_ready' },
      }),
      isLoading: false,
      refetch: jest.fn(),
    });

    rerender(
      <MemoryRouter initialEntries={['/builds/16dd6dcc-595d-48b8-8da8-1110751a2320']}>
        <BuildWorkspace
          project="Amergis Connect - ATS"
          buildId="16dd6dcc-595d-48b8-8da8-1110751a2320"
        />
      </MemoryRouter>,
    );

    const createPrBtn = screen.getByTestId('build-workspace-create-pr-button');
    fireEvent.click(createPrBtn);
    await waitFor(() => expect(acceptMutateAsync).toHaveBeenCalledWith({ revisionNumber: 1 }));

    mockUseBuild.mockReturnValue({
      data: baseDetail({
        build: { ...baseDetail().build, status: 'accepted' },
        pullRequest: {
          state: 'pull_request_open',
          url: 'https://dev.azure.com/amergis/Amergis%20Connect%20-%20ATS/_git/Amergis%20Connect%20-%20ATS/pullrequest/42',
          syncCommitSha: null,
          reviewersAdded: true,
          reviewerNames: ['Ryan Miller'],
        },
      }),
      isLoading: false,
      refetch: jest.fn(),
    });

    rerender(
      <MemoryRouter initialEntries={['/builds/16dd6dcc-595d-48b8-8da8-1110751a2320']}>
        <BuildWorkspace
          project="Amergis Connect - ATS"
          buildId="16dd6dcc-595d-48b8-8da8-1110751a2320"
        />
      </MemoryRouter>,
    );

    const prLink = screen.getByTestId('build-workspace-pr-link');
    expect(prLink).toHaveAttribute(
      'href',
      'https://dev.azure.com/amergis/Amergis%20Connect%20-%20ATS/_git/Amergis%20Connect%20-%20ATS/pullrequest/42',
    );
  });

  it('switches between Sandbox Preview and Plan & Checks tabs and supports Expand / Minimize', () => {
    mockUseBuild.mockReturnValue({
      data: baseDetail({
        build: { ...baseDetail().build, status: 'building' },
      }),
      isLoading: false,
      refetch: jest.fn(),
    });

    render(
      <MemoryRouter initialEntries={['/builds/16dd6dcc-595d-48b8-8da8-1110751a2320']}>
        <BuildWorkspace
          project="Amergis Connect - ATS"
          buildId="16dd6dcc-595d-48b8-8da8-1110751a2320"
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('build-workspace-preview-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('build-workspace-plan-tab'));
    expect(screen.getByTestId('build-workspace-plan-panel')).toBeInTheDocument();
    expect(screen.getByTestId('build-workspace-requirements-list')).toHaveTextContent(
      'AC-1: Renders calendar on the home page',
    );

    fireEvent.click(screen.getByTestId('build-workspace-side-minimize'));
    expect(screen.queryByTestId('build-workspace-plan-panel')).not.toBeInTheDocument();
  });
});
