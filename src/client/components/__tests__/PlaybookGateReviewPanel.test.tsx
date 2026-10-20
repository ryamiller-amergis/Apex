import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PlaybookGateReviewPanel } from '../PlaybookGateReviewPanel';
import type { PlaybookRunDetail } from '../../../shared/types/playbook';

const mutate = jest.fn();
const usePlaybookGate = jest.fn();

jest.mock('../../hooks/usePlaybookRuns', () => ({
  PlaybookRunApiError: class PlaybookRunApiError extends Error {},
  usePlaybookGate: (...args: unknown[]) => usePlaybookGate(...args),
  usePlaybookGateDecision: () => ({ mutate, isPending: false }),
}));

const run: PlaybookRunDetail = {
  runId: 'run-1',
  project: 'Apex',
  definitionId: 'def-1',
  definitionName: 'Validation',
  definitionVersionId: 'version-1',
  versionNumber: 1,
  status: 'suspended',
  initiatorUserId: 'owner',
  startedAt: '2026-09-22T12:00:00.000Z',
  completedAt: null,
  currentStepId: 'gate',
  suspension: {
    stepId: 'gate',
    reason: 'approval_gate',
    deadline: '2026-09-23T12:00:00.000Z',
  },
  steps: [
    {
      id: 'step-run-1',
      runId: 'run-1',
      stepId: 'gate',
      stepType: 'approval-gate',
      status: 'suspended',
      agentRunId: null,
      resumeToken: null,
      outputInline: null,
      outputBlobRef: null,
      gatePoolKey: 'design_doc',
      expiresAt: '2026-09-23T12:00:00.000Z',
      startedAt: '2026-09-22T12:00:00.000Z',
      completedAt: null,
      createdAt: '2026-09-22T12:00:00.000Z',
      updatedAt: '2026-09-22T12:00:00.000Z',
    },
  ],
};

const unpooledRun: PlaybookRunDetail = {
  ...run,
  steps: [
    {
      ...run.steps[0],
      gatePoolKey: null,
      inputInline: {
        subject: 'Approve the run before the agent sends work outside Apex',
      },
    },
  ],
};

describe('PlaybookGateReviewPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    usePlaybookGate.mockReturnValue({
      isPending: false,
      isError: false,
      data: {
        runId: 'run-1',
        stepRunId: 'step-run-1',
        subject: 'Review release',
        deadline: '2026-09-23T12:00:00.000Z',
        approvalMode: 'all_required',
        eligibleApproverCount: 2,
        currentUserDecision: null,
        hasInputFields: true,
        canDecide: true,
        fields: [
          {
            path: 'targetUrl',
            label: 'Target Url',
            value: 'https://example.test',
          },
        ],
      },
    });
  });

  it('renders labeled fields and accessible decision controls', () => {
    render(<PlaybookGateReviewPanel project="Apex" run={run} />);
    expect(screen.getByText('Target Url')).toBeInTheDocument();
    expect(screen.getByText('https://example.test')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('playbook-gate-approve'));
    expect(mutate).toHaveBeenCalledWith({ decision: 'approved' });
  });

  it('renders an empty labeled input section', () => {
    usePlaybookGate.mockReturnValue({
      isPending: false,
      isError: false,
      data: {
        subject: 'Empty step',
        approvalMode: 'any_one',
        hasInputFields: false,
        canDecide: true,
        fields: [],
      },
    });
    render(<PlaybookGateReviewPanel project="Apex" run={run} />);
    expect(screen.getByText('Resolved inputs')).toBeInTheDocument();
    expect(
      screen.getByTestId('playbook-gate-empty-inputs')
    ).toBeInTheDocument();
  });

  it('lets the initiator decide a gate with no approver pool without calling the pooled endpoint', () => {
    render(<PlaybookGateReviewPanel project="Apex" run={unpooledRun} />);
    expect(usePlaybookGate).toHaveBeenCalledWith('Apex', null, null);
    expect(screen.getByTestId('playbook-gate-mode')).toHaveTextContent(
      'Decided by whoever started this run'
    );
    fireEvent.click(screen.getByTestId('playbook-gate-approve'));
    expect(mutate).toHaveBeenCalledWith({ decision: 'approved' });
  });

  it('labels the board gate Ratify and keeps the note with the decision', async () => {
    const boardSynopsis = {
      schemaVersion: 3,
      status: 'Board approved — awaiting leadership',
      decisionRequests: [
        'D-PORTAL: Choose whether clients review submissions in a portal.',
        'D-CLEARANCE: Choose who may approve a credential waiver.',
      ],
      recommendation: 'Start with account-manager-led submissions.',
      businessOutcomes: ['Reduce duplicate entry.'],
      executiveSynopsis: 'Use one shared job and submission record.',
      phase1: ['Shared job and submission record.'],
      day1Cutover: 'Move open work only.',
      separationImpact: 'No shared runtime dependency.',
      options: [],
      leadershipActions: [],
      deliberation: [],
      decisions: [
        {
          id: 'D-PORTAL',
          area: 'Client review',
          decision: 'Use account-manager-led submission review in Phase 1.',
          status: 'Board approved — awaiting leadership',
          evidence: [],
          confidence: 0.7,
        },
      ],
      dissent: [],
      risks: [],
      assumptions: [],
      advantages: [],
      deferred: [],
      unresolved: [],
    };
    const boardRun: PlaybookRunDetail = {
      ...unpooledRun,
      suspension: { ...unpooledRun.suspension!, stepId: 'ratify' },
      steps: [
        {
          ...unpooledRun.steps[0],
          id: 'chair-step',
          stepId: 'chair',
          stepType: 'cursor-agent',
          status: 'completed',
          inputInline: null,
          outputInline: { scorecard: JSON.stringify(boardSynopsis) },
        },
        {
          ...unpooledRun.steps[0],
          stepId: 'ratify',
          inputInline: { subject: 'Ratify the ATS board synopsis' },
        },
      ],
    };
    render(<PlaybookGateReviewPanel project="Apex" run={boardRun} />);
    expect(screen.getByTestId('ats-board-decision-review')).toBeInTheDocument();
    expect(screen.getByTestId('ats-board-review-progress')).toHaveTextContent(
      '1 of 2'
    );
    expect(screen.getByTestId('ats-board-review-question')).toHaveTextContent(
      'clients review submissions'
    );
    expect(screen.getByTestId('ats-board-review-synopsis')).toHaveTextContent(
      'account-manager-led submissions'
    );
    expect(screen.getByTestId('ats-board-review-finding')).toHaveTextContent(
      'account-manager-led submission review'
    );
    expect(screen.getByTestId('playbook-gate-approve')).toBeDisabled();

    fireEvent.click(screen.getByTestId('ats-board-review-accept'));
    await waitFor(() =>
      expect(screen.getByTestId('ats-board-review-next')).not.toBeDisabled()
    );
    fireEvent.click(screen.getByTestId('ats-board-review-next'));
    expect(screen.getByTestId('ats-board-review-progress')).toHaveTextContent(
      '2 of 2'
    );
    fireEvent.click(screen.getByTestId('ats-board-review-defer'));
    fireEvent.change(screen.getByTestId('ats-board-review-response'), {
      target: { value: 'Compliance Director will decide by November 1.' },
    });
    fireEvent.click(screen.getByTestId('ats-board-review-save'));

    expect(screen.getByTestId('playbook-gate-approve')).toHaveTextContent(
      'Ratify'
    );
    await waitFor(() =>
      expect(screen.getByTestId('playbook-gate-approve')).not.toBeDisabled()
    );
    fireEvent.change(screen.getByTestId('playbook-gate-comment'), {
      target: { value: 'Phase 1 only.' },
    });
    fireEvent.click(screen.getByTestId('playbook-gate-approve'));
    expect(mutate).toHaveBeenCalledWith({
      decision: 'approved',
      comment: 'Phase 1 only.',
      answers: [
        {
          decisionId: 'D-PORTAL',
          resolution: 'accept_recommendation',
          response: 'Use account-manager-led submission review in Phase 1.',
        },
        {
          decisionId: 'D-CLEARANCE',
          resolution: 'defer',
          response: 'Compliance Director will decide by November 1.',
        },
      ],
    });
  });

  it('shows the board lean and the choices when the question uses a different reference', () => {
    const boardSynopsis = {
      schemaVersion: 3,
      status: 'Board approved — awaiting leadership',
      decisionRequests: [
        'D-T1b: Decide default-on versus optional RBAC approval for Client-ready → Submitted (recruiting manager or account manager).',
      ],
      recommendation:
        'Prove the recruiter workflow before freezing pipeline rules.',
      businessOutcomes: ['One shared submission record.'],
      executiveSynopsis: 'Leadership still needs to choose the approval rule.',
      phase1: ['Recruiter desk for one job.'],
      day1Cutover: 'Synthetic data only.',
      separationImpact: 'No dependency on the old system.',
      options: [
        {
          id: 'O-B',
          title: 'Persisted job status',
          description: 'Store a separate job pipeline.',
          tradeoffs: ['Two statuses can drift apart.'],
          recommended: false,
        },
      ],
      leadershipActions: [],
      deliberation: [
        {
          topic: 'T1 — Submission approval',
          participants: ['client', 'recruiting'],
          outcome:
            'Client favors default-on manager approval until approvers are named.',
          status: 'leadership_required',
        },
      ],
      decisions: [
        {
          id: 'D-T1-APPROVAL',
          area: 'Submission gating',
          decision:
            'Manager approval is unsettled; client favors default-on until approvers are named.',
          status: 'Open — insufficient evidence',
          evidence: [],
          confidence: 0.5,
        },
      ],
      dissent: [],
      risks: [],
      assumptions: [],
      advantages: [],
      deferred: [],
      unresolved: [],
    };
    const boardRun: PlaybookRunDetail = {
      ...unpooledRun,
      suspension: { ...unpooledRun.suspension!, stepId: 'ratify' },
      steps: [
        {
          ...unpooledRun.steps[0],
          id: 'chair-step',
          stepId: 'chair',
          stepType: 'cursor-agent',
          status: 'completed',
          inputInline: null,
          outputInline: { scorecard: JSON.stringify(boardSynopsis) },
        },
        {
          ...unpooledRun.steps[0],
          stepId: 'ratify',
          inputInline: { subject: 'Ratify the ATS board synopsis' },
        },
      ],
    };

    render(<PlaybookGateReviewPanel project="Apex" run={boardRun} />);

    expect(screen.getByTestId('ats-board-review-synopsis')).toHaveTextContent(
      'Prove the recruiter workflow'
    );
    expect(screen.getByTestId('ats-board-review-finding')).toHaveTextContent(
      'favors default-on'
    );
    expect(screen.getByTestId('ats-board-review-finding')).toHaveTextContent(
      'manager approval'
    );
    const options = screen.getAllByTestId('ats-board-review-option');
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('Default-on'),
      expect.stringContaining('Optional RBAC approval'),
    ]);
    expect(options[0]).toHaveTextContent('Board lean');
    expect(
      screen.queryByTestId('ats-board-review-accept')
    ).not.toBeInTheDocument();

    fireEvent.click(options[0]);
    fireEvent.click(screen.getByTestId('playbook-gate-approve'));
    expect(mutate).toHaveBeenCalledWith({
      decision: 'approved',
      answers: [
        {
          decisionId: 'D-T1B',
          resolution: 'direct',
          response: expect.stringContaining('Default-on'),
        },
      ],
    });
  });

  it('offers one-action Approve AI plan, Send back, and optional prefilled Override on V4 runs', () => {
    const v4Synopsis = {
      schemaVersion: 4,
      status: 'Board approved — awaiting leadership',
      decisionRequests: [
        'D-PII: Confirm whether Phase 1 remains synthetic-only or admits real candidate PII.',
      ],
      recommendation:
        'Ship the single-screen recruiter submittal workflow on synthetic data.',
      businessOutcomes: ['Cut submittal assembly to under 3 minutes.'],
      executiveSynopsis: 'Use one shared job and submission record.',
      phase1: ['Shared job and submission record.'],
      day1Cutover: 'Synthetic data only.',
      separationImpact: 'No shared runtime dependency.',
      options: [],
      leadershipActions: [],
      deliberation: [],
      decisions: [],
      dissent: [],
      risks: [],
      assumptions: [],
      advantages: [],
      deferred: [],
      unresolved: [],
      leadershipBrief: {
        headline:
          'Phase 1 ships a single-screen recruiter submittal desk on synthetic data.',
        aiDecisions: ['Use a 5-stage submission pipeline.'],
        expectedOutcomes: ['Cut submittal assembly to under 3 minutes.'],
        materialExceptions: [
          {
            id: 'D-PII',
            category: 'real_pii',
            title: 'Real candidate PII boundary',
            question:
              'Confirm whether Phase 1 remains synthetic-only or admits real candidate PII.',
            recommendedResolution:
              'Keep Phase 1 synthetic-only until privacy sign-off.',
          },
        ],
      },
    };
    const v4Run: PlaybookRunDetail = {
      ...unpooledRun,
      suspension: { ...unpooledRun.suspension!, stepId: 'ratify' },
      steps: [
        {
          ...unpooledRun.steps[0],
          id: 'chair-step',
          stepId: 'chair',
          stepType: 'cursor-agent',
          status: 'completed',
          inputInline: null,
          outputInline: { scorecard: JSON.stringify(v4Synopsis) },
        },
        {
          ...unpooledRun.steps[0],
          stepId: 'ratify',
          inputInline: { subject: 'Ratify the ATS board synopsis' },
        },
      ],
    };

    render(<PlaybookGateReviewPanel project="Apex" run={v4Run} />);
    expect(
      screen.queryByTestId('ats-board-decision-review')
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('playbook-gate-approve')).toHaveTextContent(
      'Approve AI plan'
    );
    expect(screen.getByTestId('playbook-gate-approve')).not.toBeDisabled();
    expect(screen.getByTestId('playbook-gate-reject')).toHaveTextContent(
      'Send back'
    );

    // One-click approval submits prefilled AI recommendations immediately
    fireEvent.click(screen.getByTestId('playbook-gate-approve'));
    expect(mutate).toHaveBeenCalledWith({
      decision: 'approved',
      answers: [
        {
          decisionId: 'D-PII',
          resolution: 'accept_recommendation',
          response: 'Keep Phase 1 synthetic-only until privacy sign-off.',
        },
      ],
    });

    // Optional Override editor is prefilled and records custom direction
    mutate.mockClear();
    fireEvent.click(screen.getByTestId('ats-board-v4-override-toggle'));
    expect(
      screen.getByTestId('ats-board-v4-override-editor')
    ).toBeInTheDocument();
    const responseField = screen.getByTestId(
      'ats-board-v4-override-response-D-PII'
    );
    expect(responseField).toHaveValue(
      'Keep Phase 1 synthetic-only until privacy sign-off.'
    );
    fireEvent.change(responseField, {
      target: {
        value: 'Allow anonymized candidate IDs after Security review.',
      },
    });
    fireEvent.click(screen.getByTestId('playbook-gate-approve'));
    expect(mutate).toHaveBeenCalledWith({
      decision: 'approved',
      answers: [
        {
          decisionId: 'D-PII',
          resolution: 'direct',
          response: 'Allow anonymized candidate IDs after Security review.',
        },
      ],
    });
  });
});
