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
      'Board approved — awaiting leadership'
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
});
