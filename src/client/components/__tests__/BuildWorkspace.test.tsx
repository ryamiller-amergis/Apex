import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  activitySummaryLabel,
  BuildRevisionSections,
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
  useGenerateBuildLogoOptions,
  useDecideBuildLogoCandidate,
  useRequestBuildRevision,
  useRetryBuildFastEdit,
  useRollbackBuildFastEdit,
  useResumeBuild,
  useRetryBuildDeployment,
  useStartLocalBuildPreview,
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
    useGenerateBuildLogoOptions: jest.fn(),
    useDecideBuildLogoCandidate: jest.fn(),
    useAcceptBuild: jest.fn(),
    useRequestBuildRevision: jest.fn(),
    useRetryBuildFastEdit: jest.fn(),
    useRollbackBuildFastEdit: jest.fn(),
    useCancelBuild: jest.fn(),
    useResumeBuild: jest.fn(),
    useRetryBuildDeployment: jest.fn(),
    useStartLocalBuildPreview: jest.fn(),
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
const mockGenerateLogo = useGenerateBuildLogoOptions as jest.Mock;
const mockDecideLogo = useDecideBuildLogoCandidate as jest.Mock;
const mockAcceptBuild = useAcceptBuild as jest.Mock;
const mockRequestRevision = useRequestBuildRevision as jest.Mock;
const mockRetryFastEdit = useRetryBuildFastEdit as jest.Mock;
const mockRollbackFastEdit = useRollbackBuildFastEdit as jest.Mock;
const mockCancelBuild = useCancelBuild as jest.Mock;
const mockResumeBuild = useResumeBuild as jest.Mock;
const mockRetryBuildDeployment = useRetryBuildDeployment as jest.Mock;
const mockStartLocalPreview = useStartLocalBuildPreview as jest.Mock;
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
    supportContacts: [
      { displayName: 'Ryan Miller', email: 'ryan@example.test' },
    ],
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
          {
            id: 'AC-1',
            kind: 'ac',
            text: 'Renders calendar on the home page',
            retired: false,
          },
        ],
        assumptions: ['Signed-in users can view the calendar'],
        exclusions: [],
        riskDecisions: [],
      },
      tasks: [],
    },
    verificationSummary: {
      total: 1,
      pass: 0,
      fail: 0,
      deferred: 0,
      retired: 0,
    },
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
          {
            repository: 'Amergis Connect - ATS',
            label: 'Amergis Connect - ATS',
          },
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
    mockGenerateLogo.mockReturnValue({
      mutateAsync: jest.fn(),
      isPending: false,
    });
    mockDecideLogo.mockReturnValue({
      mutateAsync: jest.fn(),
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
    mockRetryFastEdit.mockReturnValue({
      mutateAsync: jest.fn(),
      isPending: false,
    });
    mockRollbackFastEdit.mockReturnValue({
      mutateAsync: jest.fn(),
      isPending: false,
    });
    mockCancelBuild.mockReturnValue({
      mutateAsync: jest.fn(),
      isPending: false,
    });
    mockResumeBuild.mockReturnValue({
      mutateAsync: jest.fn(),
      isPending: false,
    });
    mockRetryBuildDeployment.mockReturnValue({
      mutateAsync: jest.fn(),
      isPending: false,
    });
    mockStartLocalPreview.mockReturnValue({
      mutateAsync: jest.fn(),
      isPending: false,
    });
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
    expect(derivePipelineSteps('accepted', false).map((s) => s.state)).toEqual([
      'done',
      'done',
      'done',
      'active',
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
      </MemoryRouter>
    );

    expect(screen.getByTestId('build-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('build-workspace-empty')).toBeInTheDocument();
    expect(
      screen.getByTestId('build-workspace-sandbox-frame')
    ).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('build-workspace-composer-input'), {
      target: { value: 'Add a calendar component to the home page' },
    });
    fireEvent.click(screen.getByTestId('build-workspace-composer-send'));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/builds/16dd6dcc-595d-48b8-8da8-1110751a2320'
      )
    );
    expect(startMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: 'Amergis Connect - ATS',
        prompt: 'Add a calendar component to the home page',
      })
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
        ['No deploy pipeline is set.', 'No quality manifest path is set.']
      ),
    });

    render(
      <MemoryRouter initialEntries={['/builds/new']}>
        <BuildWorkspace project="Amergis Connect - ATS" />
      </MemoryRouter>
    );

    expect(
      screen.getByTestId('build-workspace-error-banner')
    ).toHaveTextContent('2 things need fixing before this build can start.');
    expect(
      screen.getByTestId('build-workspace-refusal-list').querySelectorAll('li')
    ).toHaveLength(2);
  });

  it('sends a logo review request to Cursor instead of creating a revision', async () => {
    const generate = jest.fn().mockResolvedValue({});
    mockGenerateLogo.mockReturnValue({
      mutateAsync: generate,
      isPending: false,
    });
    mockUseBuild.mockReturnValue({
      data: baseDetail({
        build: { ...baseDetail().build, status: 'preview_ready' },
      }),
      isLoading: false,
      refetch: jest.fn().mockResolvedValue({}),
    });
    render(
      <MemoryRouter
        initialEntries={['/builds/16dd6dcc-595d-48b8-8da8-1110751a2320']}
      >
        <BuildWorkspace
          project="Amergis Connect - ATS"
          buildId="16dd6dcc-595d-48b8-8da8-1110751a2320"
        />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByTestId('build-workspace-composer-input'), {
      target: {
        value:
          'create a custom logo I can review first and implement if it looks good',
      },
    });
    fireEvent.click(screen.getByTestId('build-workspace-composer-send'));

    await waitFor(() =>
      expect(generate).toHaveBeenCalledWith({
        prompt:
          'create a custom logo I can review first and implement if it looks good',
      })
    );
    expect(revisionMutateAsync).not.toHaveBeenCalled();
  });

  it('shows generated logo options and applies one only after approval', () => {
    mockUseBuild.mockReturnValue({
      data: baseDetail({
        build: { ...baseDetail().build, status: 'preview_ready' },
        logoReview: {
          batchId: 'batch-1',
          status: 'ready',
          prompt: 'review a logo first',
          failureMessage: null,
          approvedCandidateId: 'logo-1',
          candidates: [
            { id: 'logo-1', status: 'approved' },
            { id: 'logo-2', status: 'superseded' },
          ],
        },
      }),
      isLoading: false,
      refetch: jest.fn(),
    });
    render(
      <MemoryRouter
        initialEntries={['/builds/16dd6dcc-595d-48b8-8da8-1110751a2320']}
      >
        <BuildWorkspace
          project="Amergis Connect - ATS"
          buildId="16dd6dcc-595d-48b8-8da8-1110751a2320"
        />
      </MemoryRouter>
    );

    expect(screen.getByTestId('build-logo-review')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('build-logo-use'));
    expect(revisionMutateAsync).toHaveBeenCalledWith({
      feedback:
        'Place the approved logo from /brand/logo.png in the top navigation bar. Preserve the existing navigation behavior and change only the branding presentation.',
      approvedLogoCandidateId: 'logo-1',
    });
  });

  it('groups _reasoning, _thinking, and tool rows into Brainstorm-style collapsible activity traces', () => {
    const grouped = groupChatMessagesIntoTurns([
      {
        id: 'u1',
        role: 'user',
        text: 'Build a calendar',
        ts: '2026-11-04T05:00:00Z',
      },
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
    expect(activitySummaryLabel(grouped.turns[1].activity)).toBe(
      'Thought process · 1 step'
    );
    expect(grouped.pendingActivity).toEqual([]);
  });

  it('shows only what the requester typed in a status question', () => {
    const grouped = groupChatMessagesIntoTurns([
      {
        id: 'u1',
        role: 'user',
        text: 'Build status question: is it done yet?\n\nThe repository build is still running. Answer the requester in plain language.',
        ts: '1',
      },
    ]);

    expect(grouped.turns.map((turn) => turn.text)).toEqual(['is it done yet?']);
  });

  it('shows each revision in its own section with its own details', () => {
    render(
      <BuildRevisionSections
        revisions={[
          {
            number: 1,
            createdAt: '1',
            classification: 'small',
            deploymentStatus: 'succeeded',
            previewUrl: 'http://127.0.0.1:4100/',
            feedback: null,
          },
          {
            number: 2,
            createdAt: '2',
            classification: 'small',
            deploymentStatus: 'not_started',
            previewUrl: null,
            feedback: 'Use a darker token set.',
          },
        ]}
        events={[
          {
            id: 'e1',
            occurredAt: '1',
            kind: 'task.ready',
            message: 'Building the feature.',
            taskKey: null,
            revisionNumber: 1,
            cloudAgentUrl: null,
          },
          {
            id: 'e2',
            occurredAt: '2',
            kind: 'revision.fast_edit_requested',
            message: 'Started fast revision 2.',
            taskKey: null,
            revisionNumber: 2,
            cloudAgentUrl: null,
          },
        ]}
        currentRevisionNumber={2}
        currentHeadline="Updating the preview…"
        showSpinner
      />
    );

    const section = screen.getByTestId('build-workspace-revision-2');
    expect(section).toHaveTextContent('Revision 2');
    expect(section).toHaveTextContent('Use a darker token set.');
    expect(section).toHaveTextContent('Updating the preview…');
    expect(section).toHaveTextContent('Revision 2 details · 1 update');
    expect(screen.queryByTestId('build-workspace-revision-1')).toBeNull();
  });

  it('shows a waiting section for a change sent while the build runs', () => {
    render(
      <BuildRevisionSections
        revisions={[]}
        events={[
          {
            id: 'q1',
            occurredAt: '1',
            kind: 'revision.queued',
            message: 'Saved a change.',
            taskKey: null,
            revisionNumber: null,
            cloudAgentUrl: null,
          },
        ]}
        currentRevisionNumber={1}
        currentHeadline="Building…"
        showSpinner={false}
      />
    );

    expect(screen.getByTestId('build-workspace-revision-waiting')).toHaveTextContent(
      'Revision 2'
    );
  });

  it('keeps internal revision kickoffs hidden and starts new activity after the revision feedback turn', () => {
    const grouped = groupChatMessagesIntoTurns([
      { id: 'u1', role: 'user', text: 'Build a calendar', ts: '1' },
      { id: 'a1', role: 'agent', text: 'The preview is ready.', ts: '2' },
      { id: 'u2', role: 'user', text: 'Rename it to Shift Board', ts: '3' },
      {
        id: 'internal',
        role: 'user',
        text: '# Build Revision 2 Intake',
        hidden: true,
        ts: '4',
      },
      {
        id: 'r2',
        role: 'agent',
        toolName: '_reasoning',
        text: 'Applying the requested name.',
        ts: '5',
      },
      { id: 'a2', role: 'agent', text: 'Revision 2 is understood.', ts: '6' },
    ]);

    expect(grouped.turns.map((turn) => turn.text)).toEqual([
      'Build a calendar',
      'The preview is ready.',
      'Rename it to Shift Board',
      'Revision 2 is understood.',
    ]);
    expect(grouped.turns[3].activity).toEqual([
      expect.objectContaining({ id: 'r2', kind: 'thinking' }),
    ]);
  });

  it('renders intake conversation, live thought process trace, and Confirm & Start Build action', async () => {
    mockUseBuild.mockReturnValue({
      data: baseDetail({ build: { ...baseDetail().build, status: 'intake' } }),
      isLoading: false,
      refetch: jest.fn(),
    });
    mockUseAgentChat.mockReturnValue({
      messages: [
        {
          id: 'm1',
          role: 'user',
          text: 'Add a calendar component to the home page',
          ts: '1',
        },
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
      <MemoryRouter
        initialEntries={['/builds/16dd6dcc-595d-48b8-8da8-1110751a2320']}
      >
        <BuildWorkspace
          project="Amergis Connect - ATS"
          buildId="16dd6dcc-595d-48b8-8da8-1110751a2320"
        />
      </MemoryRouter>
    );

    expect(screen.getByTestId('build-workspace-user-msg')).toHaveTextContent(
      'Add a calendar component to the home page'
    );
    expect(
      screen.getByTestId('build-workspace-thought-process')
    ).toHaveTextContent('Thought process');
    expect(
      screen.getByTestId('build-workspace-confirm-bar')
    ).toBeInTheDocument();
  });

  it('triggers the build on planning status and keeps internal task names out of the primary experience', () => {
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
            taskKey: 't-impl-1',
            cloudAgentUrl: 'https://cursor.com/agents/bc-agent-1',
          },
        ],
        total: 1,
      },
      refetch: jest.fn(),
    });

    render(
      <MemoryRouter
        initialEntries={['/builds/16dd6dcc-595d-48b8-8da8-1110751a2320']}
      >
        <BuildWorkspace
          project="Amergis Connect - ATS"
          buildId="16dd6dcc-595d-48b8-8da8-1110751a2320"
        />
      </MemoryRouter>
    );

    expect(ensurePlanningMutate).toHaveBeenCalledWith({});
    expect(
      screen.getByTestId('build-workspace-autonomous-card')
    ).toBeInTheDocument();
    expect(screen.getByTestId('build-workspace-event-row')).toHaveTextContent(
      'Planning started'
    );
    expect(
      screen.getByTestId('build-workspace-agent-run-link')
    ).toHaveAttribute('href', 'https://cursor.com/agents/bc-agent-1');
    expect(
      screen.getByTestId('build-workspace-stage-headline')
    ).toHaveTextContent('Preparing your build');
    expect(
      screen.queryByTestId('build-workspace-task-pill-t-impl-1')
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId('build-workspace-event-row')
    ).not.toHaveTextContent('t-impl-1');
  });

  it('renders Create Pull Request when preview_ready and View Pull Request link once accepted', async () => {
    acceptMutateAsync.mockResolvedValue({ status: 'accepted' });

    const { rerender } = render(
      <MemoryRouter
        initialEntries={['/builds/16dd6dcc-595d-48b8-8da8-1110751a2320']}
      >
        <BuildWorkspace
          project="Amergis Connect - ATS"
          buildId="16dd6dcc-595d-48b8-8da8-1110751a2320"
        />
      </MemoryRouter>
    );

    mockUseBuild.mockReturnValue({
      data: baseDetail({
        build: { ...baseDetail().build, status: 'preview_ready' },
      }),
      isLoading: false,
      refetch: jest.fn(),
    });

    rerender(
      <MemoryRouter
        initialEntries={['/builds/16dd6dcc-595d-48b8-8da8-1110751a2320']}
      >
        <BuildWorkspace
          project="Amergis Connect - ATS"
          buildId="16dd6dcc-595d-48b8-8da8-1110751a2320"
        />
      </MemoryRouter>
    );

    const createPrBtn = screen.getByTestId('build-workspace-create-pr-button');
    fireEvent.click(createPrBtn);
    await waitFor(() =>
      expect(acceptMutateAsync).toHaveBeenCalledWith({ revisionNumber: 1 })
    );

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
      <MemoryRouter
        initialEntries={['/builds/16dd6dcc-595d-48b8-8da8-1110751a2320']}
      >
        <BuildWorkspace
          project="Amergis Connect - ATS"
          buildId="16dd6dcc-595d-48b8-8da8-1110751a2320"
        />
      </MemoryRouter>
    );

    const prLink = screen.getByTestId('build-workspace-pr-link');
    expect(prLink).toHaveAttribute(
      'href',
      'https://dev.azure.com/amergis/Amergis%20Connect%20-%20ATS/_git/Amergis%20Connect%20-%20ATS/pullrequest/42'
    );
  });

  it('keeps the revision composer usable at preview_ready after the same session confirmed intake', async () => {
    confirmMutateAsync.mockResolvedValue({});
    const refetchChatThread = jest.fn().mockResolvedValue({});
    const agentChat = {
      messages: [
        { id: 'm1', role: 'user', text: 'Add shifts', ts: '1' },
        {
          id: 'm2',
          role: 'agent',
          text: "I'll add shifts.\n\n[[build-intake:confirm]]\nDoes this match?",
          ts: '2',
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
    };
    mockUseAgentChat.mockReturnValue(agentChat);
    mockUseChatThread.mockReturnValue({
      data: { id: 'thread-1', messages: [], status: 'idle', activeRunId: null },
      refetch: refetchChatThread,
    });
    mockUseBuild.mockReturnValue({
      data: baseDetail({ build: { ...baseDetail().build, status: 'intake' } }),
      isLoading: false,
      refetch: jest.fn().mockResolvedValue({}),
    });
    mockUseBuildEvents.mockReturnValue({
      data: { events: [], total: 0 },
      refetch: jest.fn().mockResolvedValue({}),
    });
    const tree = () => (
      <MemoryRouter
        initialEntries={['/builds/16dd6dcc-595d-48b8-8da8-1110751a2320']}
      >
        <BuildWorkspace
          project="Amergis Connect - ATS"
          buildId="16dd6dcc-595d-48b8-8da8-1110751a2320"
        />
      </MemoryRouter>
    );
    const { rerender } = render(tree());

    fireEvent.click(screen.getByTestId('build-workspace-confirm-button'));
    await waitFor(() => expect(confirmMutateAsync).toHaveBeenCalled());
    refetchChatThread.mockClear();

    mockUseBuild.mockReturnValue({
      data: baseDetail({
        build: { ...baseDetail().build, status: 'preview_ready' },
      }),
      isLoading: false,
      refetch: jest.fn(),
    });
    rerender(tree());

    const input = screen.getByTestId('build-workspace-composer-input');
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: 'Rename the app' } });
    fireEvent.click(screen.getByTestId('build-workspace-composer-send'));
    await waitFor(() =>
      expect(revisionMutateAsync).toHaveBeenCalledWith({
        feedback: 'Rename the app',
      })
    );
    expect(refetchChatThread).toHaveBeenCalled();
  });

  it('pastes a screenshot into revision chat and sends it without saving a file first', async () => {
    const send = jest.fn().mockResolvedValue(true);
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
      send,
      cancel: jest.fn(),
    });
    mockUseBuild.mockReturnValue({
      data: baseDetail({
        build: { ...baseDetail().build, status: 'preview_ready' },
      }),
      isLoading: false,
      refetch: jest.fn(),
    });
    render(
      <MemoryRouter
        initialEntries={['/builds/16dd6dcc-595d-48b8-8da8-1110751a2320']}
      >
        <BuildWorkspace
          project="Amergis Connect - ATS"
          buildId="16dd6dcc-595d-48b8-8da8-1110751a2320"
        />
      </MemoryRouter>
    );

    const input = screen.getByTestId('build-workspace-composer-input');
    const screenshot = new File([new Uint8Array([137, 80, 78, 71])], '', {
      type: 'image/png',
    });
    fireEvent.paste(input, {
      clipboardData: {
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => screenshot,
          },
        ],
        files: [screenshot],
      },
    });

    expect(
      await screen.findByTestId('build-workspace-composer-attachments')
    ).toHaveTextContent(/screenshot-\d+-1\.png/);
    fireEvent.change(input, {
      target: { value: 'Match the spacing shown here' },
    });
    fireEvent.click(screen.getByTestId('build-workspace-composer-send'));

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'Match the spacing shown here',
        expect.objectContaining({
          attachments: [
            expect.objectContaining({
              type: 'image/png',
              encoding: 'base64',
            }),
          ],
        })
      )
    );
    expect(revisionMutateAsync).toHaveBeenCalledWith({
      feedback: 'Match the spacing shown here',
      hasAttachments: true,
    });
    expect(
      revisionMutateAsync.mock.invocationCallOrder[0]
    ).toBeLessThan(send.mock.invocationCallOrder[0]);
  });

  it('starts an exact-revision local preview from the preview panel', async () => {
    const mutateAsync = jest.fn().mockResolvedValue({
      status: 'started',
      revisionNumber: 1,
    });
    mockStartLocalPreview.mockReturnValue({
      mutateAsync,
      isPending: false,
    });
    mockUseBuild.mockReturnValue({
      data: baseDetail({
        build: { ...baseDetail().build, status: 'deployment_failed' },
        deployment: {
          status: 'failed',
          previewUrl: null,
          pipelineUrl: null,
          failedStage: 'trigger',
          error: 'No cloud preview pipeline is configured.',
        },
        viewer: { canRetryDeployment: true },
      }),
      isLoading: false,
      refetch: jest.fn(),
    });

    render(
      <MemoryRouter
        initialEntries={['/builds/16dd6dcc-595d-48b8-8da8-1110751a2320']}
      >
        <BuildWorkspace
          project="Amergis Connect - ATS"
          buildId="16dd6dcc-595d-48b8-8da8-1110751a2320"
        />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByTestId('build-workspace-start-local-preview'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({}));
    expect(
      screen.getByText(/builds the validated revision in Docker/i)
    ).toBeInTheDocument();
  });

  it('shows the current editable revision preview without a deployment lease', () => {
    const studioPreviewUrl = 'http://127.0.0.1:43123/';
    const detail = baseDetail();
    mockUseBuild.mockReturnValue({
      data: baseDetail({
        build: {
          ...detail.build,
          status: 'intake',
          currentRevisionNumber: 2,
        },
        revisions: [
          ...detail.revisions,
          {
            number: 2,
            createdAt: '2026-11-06T17:00:00.000Z',
            classification: null,
            deploymentStatus: 'not_started',
            previewUrl: studioPreviewUrl,
          },
        ],
        currentRevision: {
          ...detail.currentRevision,
          number: 2,
        },
        deployment: undefined,
        previews: [],
      }),
      isLoading: false,
      refetch: jest.fn(),
    });

    render(
      <MemoryRouter
        initialEntries={['/builds/16dd6dcc-595d-48b8-8da8-1110751a2320']}
      >
        <BuildWorkspace
          project="Amergis Connect - ATS"
          buildId="16dd6dcc-595d-48b8-8da8-1110751a2320"
        />
      </MemoryRouter>
    );

    expect(
      screen.getByTestId('build-workspace-preview-iframe')
    ).toHaveAttribute('src', studioPreviewUrl);
  });

  it('offers retry and rollback when fast revision checks fail', async () => {
    const retry = jest.fn().mockResolvedValue({ kind: 'started' });
    const rollback = jest.fn().mockResolvedValue({ kind: 'started' });
    mockRetryFastEdit.mockReturnValue({
      mutateAsync: retry,
      isPending: false,
    });
    mockRollbackFastEdit.mockReturnValue({
      mutateAsync: rollback,
      isPending: false,
    });
    mockUseBuild.mockReturnValue({
      data: baseDetail({
        build: { ...baseDetail().build, status: 'preview_ready' },
        revision: {
          attemptId: 'attempt-1',
          revisionNumber: 2,
          status: 'failed',
          route: 'fast_edit',
          requestedAt: '2026-11-06T18:00:00.000Z',
          previewUpdatedAt: '2026-11-06T18:00:02.000Z',
          checksCompletedAt: '2026-11-06T18:00:03.000Z',
          checkSummary: {
            status: 'failed',
            tasks: [{ name: 'unit_test', status: 'failed' }],
          },
          error: {
            code: 'FAST_EDIT_CHECKS_FAILED',
            message: 'The preview update did not pass its checks.',
          },
          workspaceVersion: 1,
        },
      }),
      isLoading: false,
      refetch: jest.fn().mockResolvedValue(undefined),
    });

    render(
      <MemoryRouter>
        <BuildWorkspace
          project="Amergis Connect - ATS"
          buildId="16dd6dcc-595d-48b8-8da8-1110751a2320"
        />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByTestId('build-workspace-fast-edit-retry'));
    fireEvent.click(screen.getByTestId('build-workspace-fast-edit-rollback'));

    await waitFor(() =>
      expect(retry).toHaveBeenCalledWith({ attemptId: 'attempt-1' })
    );
    expect(rollback).toHaveBeenCalledWith({ attemptId: 'attempt-1' });
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
      <MemoryRouter
        initialEntries={['/builds/16dd6dcc-595d-48b8-8da8-1110751a2320']}
      >
        <BuildWorkspace
          project="Amergis Connect - ATS"
          buildId="16dd6dcc-595d-48b8-8da8-1110751a2320"
        />
      </MemoryRouter>
    );

    expect(
      screen.getByTestId('build-workspace-preview-panel')
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('build-workspace-metrics')
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('build-workspace-plan-tab'));
    expect(
      screen.getByTestId('build-workspace-plan-panel')
    ).toBeInTheDocument();
    expect(screen.getByTestId('build-workspace-metrics')).toHaveTextContent(
      'Build Steps'
    );
    expect(screen.getByTestId('build-workspace-metrics')).toHaveTextContent(
      'Checks Passed'
    );
    expect(screen.getByTestId('build-workspace-metrics')).toHaveTextContent(
      'Requirements'
    );
    expect(
      screen.getByTestId('build-workspace-requirements-list')
    ).toHaveTextContent('AC-1: Renders calendar on the home page');

    fireEvent.click(screen.getByTestId('build-workspace-side-minimize'));
    expect(
      screen.queryByTestId('build-workspace-plan-panel')
    ).not.toBeInTheDocument();
  });

  it('surfaces logo mutation errors in BuildLogoReviewCard with friendly retry guidance when the API is restarting', async () => {
    mockDecideLogo.mockReturnValue({
      mutateAsync: jest
        .fn()
        .mockRejectedValue(new Error('Failed to fetch: 503 Service Unavailable')),
      isPending: false,
    });
    mockUseBuild.mockReturnValue({
      data: baseDetail({
        build: { ...baseDetail().build, status: 'preview_ready' },
        logoReview: {
          batchId: 'batch-1',
          status: 'ready',
          prompt: 'review a logo first',
          failureMessage: null,
          approvedCandidateId: null,
          candidates: [{ id: 'logo-1', status: 'pending' }],
        },
      }),
      isLoading: false,
      refetch: jest.fn(),
    });

    render(
      <MemoryRouter
        initialEntries={['/builds/16dd6dcc-595d-48b8-8da8-1110751a2320']}
      >
        <BuildWorkspace
          project="Amergis Connect - ATS"
          buildId="16dd6dcc-595d-48b8-8da8-1110751a2320"
        />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByTestId('build-logo-approve-logo-1'));

    const logoAlert = await screen.findByTestId('build-logo-error');
    expect(logoAlert).toHaveTextContent(
      /The API server may be restarting or temporarily unreachable/i
    );
    expect(screen.getByTestId('build-workspace-error-banner')).toHaveTextContent(
      /The API server may be restarting or temporarily unreachable/i
    );
  });

  it('renders browser check status, desktop/mobile viewport details, and screenshot links inside BuildRevisionSections', () => {
    render(
      <BuildRevisionSections
        revisions={[
          {
            number: 2,
            createdAt: '2',
            classification: 'small',
            deploymentStatus: 'succeeded',
            previewUrl: 'http://127.0.0.1:4100/',
            feedback: 'Center the dashboard layout and update the title.',
            browserVerification: {
              status: 'passed',
              desktopViewport: { width: 1280, height: 800, centered: true },
              mobileViewport: { width: 375, height: 667, centered: true },
              screenshotUrl: '/api/builds/b1/evidence/check-1/screenshot.png',
            },
          },
        ]}
        events={[]}
        currentRevisionNumber={2}
        currentHeadline="The preview is ready."
        showSpinner={false}
      />
    );

    expect(
      screen.getByTestId('build-workspace-revision-2-browser-status')
    ).toHaveTextContent('Browser check: passed');
    expect(
      screen.getByTestId('build-workspace-revision-2-viewport-desktop')
    ).toHaveTextContent('Desktop 1280×800 (centered)');
    expect(
      screen.getByTestId('build-workspace-revision-2-viewport-mobile')
    ).toHaveTextContent('Mobile 375×667');
    expect(
      screen.getByTestId('build-workspace-revision-2-screenshot-link')
    ).toHaveAttribute(
      'href',
      '/api/builds/b1/evidence/check-1/screenshot.png'
    );
  });
});
