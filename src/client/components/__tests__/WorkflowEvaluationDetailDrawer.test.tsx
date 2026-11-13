/**
 * Workflow evaluation drawer (dd-1d49b1d5 PBI-011, PBI-013).
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AdminEvaluationEventDetail } from '../../../shared/types/workflowEvaluationAdmin';
import { WorkflowEvaluationDetailDrawer } from '../WorkflowEvaluationDetailDrawer';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));

const EVENT_ID = '11111111-1111-4111-8111-111111111111';

function detail(overrides: Partial<AdminEvaluationEventDetail> = {}): AdminEvaluationEventDetail {
  return {
    id: EVENT_ID,
    createdAt: '2026-10-21T10:00:00.000Z',
    stageKey: 'prd_human_review',
    stageLabel: 'PRD review',
    subjectType: 'prd',
    subjectId: 'prd-1',
    phaseIndex: null,
    outcome: 'regenerate',
    outcomeLabel: 'Regenerate',
    criteriaAverage: 3.6,
    reviewerDisplayName: 'Ada',
    reviewerRoleLabel: 'Product owner',
    reasonCodes: ['missing_requirement'],
    criteria: [{ key: 'readiness', label: 'Readiness', score: 2, scaleLabel: 'Major changes needed' }],
    reasons: [{ key: 'missing_requirement', label: 'Missing requirement' }],
    comment: 'The audit log is missing entirely.',
    hasCorrectedArtifact: false,
    artifactHash: 'a'.repeat(64),
    lineage: { skillPath: '.cursor/skills/to-prd/SKILL.md', skillVersion: 'abc', model: 'claude', interviewId: null, prdId: 'prd-1' },
    jobs: [
      { evaluatorKey: 'promptfoo', status: 'failed', updatedAt: '2026-10-21T10:05:00.000Z', errorDetail: 'assertions_failed: 1 of 3 Promptfoo tests failed' },
      { evaluatorKey: 'llm_judge', status: 'ready', updatedAt: '2026-10-21T10:06:00.000Z', errorDetail: null },
    ],
    judge: {
      output: {
        missedRequirements: [{ description: 'Audit log' }],
        inventedRequirements: [],
        recommendedImprovements: [{ text: 'Add an audit log requirement' }],
        confidence: 'medium',
      },
      hasAppendix: true,
    },
    promptfoo: {
      suiteRef: 's', suiteSha256: 'x', artifactHash: 'a', passed: false,
      totals: { tests: 3, passed: 2, failed: 1 },
      failures: [{ test: 'has-goals', assertion: 'contains', reason: 'missing "## Goals"' }],
      durationMs: 10,
    },
    promptfooFailed: true,
    ...overrides,
  };
}

function mockFetch(event: AdminEvaluationEventDetail, retry: { status: number; body: unknown } = { status: 200, body: {} }) {
  const fn = jest.fn(async (url: string, init?: RequestInit) => {
    let status = 200;
    let body: unknown;
    if (init?.method === 'POST') ({ status, body } = retry);
    else if (url.endsWith('/judge-appendix')) body = { markdown: '# Narrative' };
    else body = { event };
    return { ok: status < 300, status, json: async () => body } as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function renderDrawer(onClose = jest.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WorkflowEvaluationDetailDrawer projectId="Apex" eventId={EVENT_ID} onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

describe('WorkflowEvaluationDetailDrawer', () => {
  it('puts judge recommendations before human scores and shows the Promptfoo failed badge', async () => {
    mockFetch(detail());
    renderDrawer();

    const recommendations = await screen.findByTestId('workflow-evaluation-recommendations');
    const scores = screen.getByTestId('workflow-evaluation-scores');
    expect(recommendations.compareDocumentPosition(scores) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(recommendations).toHaveTextContent('Add an audit log requirement');
    expect(screen.getByTestId('workflow-evaluation-promptfoo-failed-badge')).toBeInTheDocument();
    expect(await screen.findByTestId('workflow-evaluation-appendix')).toHaveTextContent('# Narrative');
    expect(screen.getByTestId('workflow-evaluation-job-promptfoo')).toHaveTextContent('2 of 3 checks passed');
    expect(screen.getByTestId('workflow-evaluation-job-promptfoo')).toHaveTextContent('assertions_failed');
  });

  it('shows human feedback first while the judge is pending, and Retry only on failed jobs', async () => {
    mockFetch(detail({
      jobs: [
        { evaluatorKey: 'promptfoo', status: 'ready', updatedAt: '2026-10-21T10:05:00.000Z', errorDetail: null },
        { evaluatorKey: 'llm_judge', status: 'pending', updatedAt: '2026-10-21T10:06:00.000Z', errorDetail: null },
      ],
      judge: { output: null, hasAppendix: false },
      promptfoo: null,
      promptfooFailed: false,
    }));
    renderDrawer();

    expect(await screen.findByText('Judge run pending')).toBeInTheDocument();
    expect(screen.queryByTestId('workflow-evaluation-recommendations')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workflow-evaluation-retry-promptfoo')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workflow-evaluation-retry-llm_judge')).not.toBeInTheDocument();
  });

  it('posts a retry and shows "no longer failed" on 409', async () => {
    const fetchMock = mockFetch(detail(), {
      status: 409,
      body: { error: 'Only a failed job can be retried.', code: 'job_not_failed' },
    });
    const user = userEvent.setup();
    renderDrawer();

    await user.click(await screen.findByTestId('workflow-evaluation-retry-promptfoo'));

    const row = screen.getByTestId('workflow-evaluation-job-promptfoo');
    expect(await within(row).findByRole('alert')).toHaveTextContent('This job is no longer failed');
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe(`/api/projects/Apex/workflow-evaluations/events/${EVENT_ID}/jobs/promptfoo/retry`);
  });

  it('focuses inside on open and closes on Escape', async () => {
    mockFetch(detail());
    const user = userEvent.setup();
    const onClose = renderDrawer();

    await screen.findByTestId('workflow-evaluation-recommendations');
    expect(screen.getByTestId('workflow-evaluation-drawer-close')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
