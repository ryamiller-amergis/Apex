import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AtsBoardSynopsisPanel } from '../AtsBoardSynopsisPanel';
import type {
  PlaybookRunDetail,
  PlaybookStepRun,
} from '../../../shared/types/playbook';

const synopsis = {
  status: 'Board approved — awaiting leadership',
  executiveSynopsis: 'Phase 1 covers one filled assignment.',
  phase1: ['A recruiter submits one candidate.'],
  day1Cutover: 'Open jobs and active placements only.',
  separationImpact: 'The new workflow runs without the old system.',
  decisions: [
    {
      id: 'D1',
      area: 'Recruiting',
      decision: 'Submit one candidate from an internal search.',
      status: 'Open — insufficient evidence',
      evidence: ['A public vendor page describes internal search. One source.'],
      confidence: 0.4,
    },
  ],
  dissent: ['Market wanted a second source.'],
  risks: [],
  assumptions: [],
  advantages: [],
  deferred: [],
  unresolved: [],
};

const synopsisV2 = {
  ...synopsis,
  schemaVersion: 2,
  decisionRequests: ['Choose the compliance gate order.'],
  recommendation: 'Approve the thin workflow.',
  businessOutcomes: ['Reduce duplicate entry.'],
  options: [
    {
      id: 'O1',
      title: 'Compliance before client',
      description: 'Release only cleared packets.',
      tradeoffs: ['Slower first submission.'],
      recommended: false,
    },
  ],
  leadershipActions: ['Name the policy owner.'],
  deliberation: [
    {
      topic: 'Gate order',
      participants: ['compliance', 'recruiting'],
      outcome: 'Leadership must choose.',
      status: 'leadership_required',
    },
  ],
};

function step(overrides: Partial<PlaybookStepRun>): PlaybookStepRun {
  return {
    id: 'step-1',
    runId: 'run-1',
    stepId: 'chair',
    stepType: 'cursor-agent',
    status: 'completed',
    agentRunId: null,
    resumeToken: null,
    outputInline: null,
    outputBlobRef: null,
    expiresAt: null,
    startedAt: '2026-10-17T12:00:00.000Z',
    completedAt: null,
    createdAt: '2026-10-17T12:00:00.000Z',
    updatedAt: '2026-10-17T12:00:00.000Z',
    ...overrides,
  };
}

function run(steps: PlaybookStepRun[]): PlaybookRunDetail {
  return {
    runId: 'run-1',
    project: 'Apex',
    definitionId: 'def-1',
    definitionName: 'ATS agent board',
    definitionVersionId: 'version-1',
    versionNumber: 1,
    status: 'suspended',
    initiatorUserId: 'owner',
    startedAt: '2026-10-17T12:00:00.000Z',
    completedAt: null,
    currentStepId: 'ratify',
    suspension: null,
    steps,
  };
}

describe('AtsBoardSynopsisPanel', () => {
  it('shows the waiting state before the chair finishes', () => {
    render(
      <AtsBoardSynopsisPanel
        run={run([step({ status: 'running', outputInline: null })])}
      />
    );
    expect(screen.getByTestId('ats-board-synopsis-waiting')).toHaveTextContent(
      'has not finished'
    );
  });

  it('shows dissent and withholds the transcript until leadership ratifies', () => {
    render(
      <AtsBoardSynopsisPanel
        run={run([
          step({ outputInline: { scorecard: JSON.stringify(synopsis) } }),
        ])}
      />
    );
    expect(screen.getByTestId('ats-board-synopsis-status')).toHaveTextContent(
      'Board recommendation — awaiting leadership ratification'
    );
    expect(screen.getByTestId('ats-board-dissent')).toHaveTextContent(
      'second source'
    );
    expect(screen.getByTestId('ats-board-decision')).toHaveTextContent(
      'One source'
    );
    expect(
      screen.getByTestId('ats-board-not-a-requirement')
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('ats-board-transcript')
    ).not.toBeInTheDocument();
  });

  it('copies the requirements transcript only after ratification', () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <AtsBoardSynopsisPanel
        run={run([
          step({
            outputInline: {
              reportMd: '```json\n' + JSON.stringify(synopsis) + '\n```',
            },
          }),
          step({
            id: 'step-2',
            stepId: 'ratify',
            stepType: 'approval-gate',
            status: 'completed',
            outputInline: {
              decision: 'approved',
              decidedBy: 'owner',
              comment: 'Phase 1 only.',
              answers: [
                {
                  decisionId: 'D1',
                  resolution: 'direct',
                  response: 'Use the account-manager review for Phase 1.',
                },
              ],
            },
          }),
        ])}
      />
    );
    expect(screen.getByTestId('ats-board-synopsis-status')).toHaveTextContent(
      'Leadership ratified'
    );
    expect(screen.getByTestId('ats-board-leadership-note')).toHaveTextContent(
      'Phase 1 only.'
    );
    expect(
      screen.getByTestId('ats-board-leadership-resolutions')
    ).toHaveTextContent('Use the account-manager review for Phase 1.');
    expect(
      screen.getByTestId('ats-board-ratification-summary')
    ).toHaveTextContent('Phase 1 covers one filled assignment.');
    expect(
      screen.getByTestId('ats-board-ratification-summary')
    ).toHaveTextContent('A recruiter submits one candidate.');
    const exportRecord = screen.getByTestId('ats-board-export-record');
    expect(exportRecord.tagName).toBe('DETAILS');
    expect(exportRecord).not.toHaveAttribute('open');
    fireEvent.click(screen.getByTestId('ats-board-copy-transcript'));
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('## Phase 1 Requirements')
    );
    expect(screen.getByTestId('ats-board-transcript')).toHaveTextContent(
      'Phase 1 only.'
    );
  });

  it('shows the version 2 decision package and deliberation summary', () => {
    render(
      <AtsBoardSynopsisPanel
        run={run([
          step({ outputInline: { scorecard: JSON.stringify(synopsisV2) } }),
        ])}
      />
    );
    expect(screen.getByTestId('ats-board-decision-requests')).toHaveTextContent(
      'gate order'
    );
    expect(screen.getByTestId('ats-board-recommendation')).toHaveTextContent(
      'thin workflow'
    );
    expect(screen.getByTestId('ats-board-options')).toHaveTextContent(
      'Slower first submission'
    );
    expect(
      screen.getByTestId('ats-board-deliberation-summary')
    ).toHaveTextContent('Leadership must choose');
    expect(
      screen.getByTestId('ats-board-leadership-actions')
    ).toHaveTextContent('policy owner');
  });

  it('keeps research and development detail collapsed behind a supporting-detail section', () => {
    render(
      <AtsBoardSynopsisPanel
        run={run([
          step({
            outputInline: {
              scorecard: JSON.stringify({
                ...synopsisV2,
                schemaVersion: 3,
                risks: ['A detailed implementation risk.'],
                assumptions: ['A detailed operating assumption.'],
                evidenceRegister: [
                  {
                    id: 'E1',
                    claim: 'A detailed research claim.',
                    source: 'Public source',
                    corroboration: 'one source',
                  },
                ],
              }),
            },
          }),
        ])}
      />
    );

    const supportingDetail = screen.getByTestId('ats-board-supporting-detail');
    expect(supportingDetail.tagName).toBe('DETAILS');
    expect(supportingDetail).not.toHaveAttribute('open');
    expect(supportingDetail).toHaveTextContent(
      'Supporting research and delivery detail'
    );
    expect(supportingDetail).toHaveTextContent('A detailed research claim');
    expect(screen.getByTestId('ats-board-recommendation')).toHaveTextContent(
      'thin workflow'
    );
  });

  it('humanizes coded decision requests, pairs follow-up actions, and preserves internal reference IDs', () => {
    const codedSynopsis = {
      ...synopsisV2,
      decisionRequests: [
        'D-PORTAL: Decide whether Phase 1 ships a branded client portal or account-manager-mediated submittals.',
      ],
      leadershipActions: ['Rule on D-PORTAL before UX and cutover scope lock.'],
      deliberation: [
        {
          topic: 'T1 — Phase 1 client self-service portal',
          participants: ['client', 'product', 'operations'],
          outcome: 'Escalated to leadership.',
          status: 'leadership_required',
        },
      ],
    };

    render(
      <AtsBoardSynopsisPanel
        run={run([
          step({ outputInline: { scorecard: JSON.stringify(codedSynopsis) } }),
        ])}
      />
    );

    const decisionRequests = screen.getByTestId('ats-board-decision-requests');
    expect(decisionRequests).toHaveTextContent(
      'Client Portal & Submittal Review'
    );
    expect(decisionRequests).toHaveTextContent(
      'What needs to be accomplished:'
    );
    expect(decisionRequests).toHaveTextContent(
      'before UX and cutover scope lock'
    );
    expect(decisionRequests).not.toHaveTextContent('D-PORTAL');
    expect(
      decisionRequests.querySelector('[data-ref-id="D-PORTAL"]')
    ).not.toBeNull();

    const deliberation = screen.getByTestId('ats-board-deliberation-summary');
    expect(deliberation).toHaveTextContent(
      'Phase 1 client self-service portal'
    );
    expect(deliberation).toHaveTextContent('Needs leadership decision');
    expect(
      deliberation.querySelector(
        '[data-ref-id="T1"][data-status="leadership_required"]'
      )
    ).not.toBeNull();
  });

  it('shows only the structured board discussion audit', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        charter: 'Objective: Replace the ATS.',
        turns: [
          {
            sequence: 2,
            phase: 'response',
            topicId: 'T1',
            specialist: 'compliance',
            status: 'completed',
            result: {
              position: 'Require clearance before start.',
              evidence: ['Credential policy'],
              challenges: ['Client visibility is not start clearance.'],
              revisions: [],
            },
            completedAt: '2026-10-18T12:00:00.000Z',
          },
        ],
      }),
    } as Response);
    Object.defineProperty(global, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <AtsBoardSynopsisPanel
          run={run([
            step({ outputInline: { scorecard: JSON.stringify(synopsisV2) } }),
            step({
              id: 'step-2',
              stepId: 'deliberation',
              stepType: 'board-deliberation',
              outputInline: {},
            }),
          ])}
        />
      </QueryClientProvider>
    );
    fireEvent.click(screen.getByText('Board discussion audit'));
    expect(
      await screen.findByText('Require clearance before start.')
    ).toBeInTheDocument();
    expect(screen.getByTestId('ats-board-audit')).toHaveTextContent(
      'Credential policy'
    );
    expect(screen.getByTestId('ats-board-audit')).toHaveTextContent(
      'Replace the ATS'
    );
    expect(screen.getByTestId('ats-board-audit')).not.toHaveTextContent(
      'prompt'
    );
  });

  it('renders the focused V4 leadership brief above the fold and keeps supporting detail collapsed', () => {
    const synopsisV4 = {
      ...synopsisV2,
      schemaVersion: 4,
      decisionRequests: [
        'D-PII: Confirm whether Phase 1 remains synthetic-only or admits real candidate PII.',
      ],
      leadershipBrief: {
        headline:
          'Phase 1 ships a single-screen recruiter submittal desk on synthetic data.',
        aiDecisions: [
          'Use a 5-stage submission pipeline.',
          'Derive job status from active submission stages.',
        ],
        expectedOutcomes: ['Submittal packet assembly in under 3 minutes.'],
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

    render(
      <AtsBoardSynopsisPanel
        run={run([
          step({ outputInline: { scorecard: JSON.stringify(synopsisV4) } }),
        ])}
      />
    );

    expect(screen.getByTestId('ats-board-v4-brief')).toBeInTheDocument();
    expect(screen.getByTestId('ats-board-v4-headline')).toHaveTextContent(
      'single-screen recruiter submittal desk'
    );
    expect(screen.getByTestId('ats-board-v4-ai-decisions')).toHaveTextContent(
      '5-stage submission pipeline'
    );
    expect(screen.getByTestId('ats-board-v4-outcomes')).toHaveTextContent(
      'under 3 minutes'
    );
    expect(screen.getByTestId('ats-board-v4-exception')).toHaveTextContent(
      'Real candidate PII'
    );
    expect(screen.getByTestId('ats-board-v4-exception')).toHaveTextContent(
      'Keep Phase 1 synthetic-only'
    );
    expect(
      screen.queryByTestId('ats-board-decision-requests')
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId('ats-board-supporting-detail')
    ).not.toHaveAttribute('open');
  });
});
