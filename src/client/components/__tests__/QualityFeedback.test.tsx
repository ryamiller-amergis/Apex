/**
 * Quality feedback form and prompt controller (dd-20cb9868, dd-860b3568).
 */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WORKFLOW_EVALUATION_PRD_RUBRIC } from '../../../shared/types/workflowEvaluation';
import { QualityFeedbackForm } from '../QualityFeedbackForm';
import { QualityFeedbackPromptController } from '../QualityFeedbackPromptController';
import { qualityFeedbackPromptKeys } from '../../hooks/useQualityFeedbackPromptState';

const definitionsBody = {
  definitions: [{
    id: 'def-1',
    version: 1,
    processKey: 'orchestrated_workflow',
    stageKey: 'prd_human_review',
    subjectType: 'prd',
    criteria: WORKFLOW_EVALUATION_PRD_RUBRIC.criteria,
    scale: WORKFLOW_EVALUATION_PRD_RUBRIC.scale,
    reasonCodes: WORKFLOW_EVALUATION_PRD_RUBRIC.reasonCodes,
    outcomes: WORKFLOW_EVALUATION_PRD_RUBRIC.outcomes,
    reviewerRoles: WORKFLOW_EVALUATION_PRD_RUBRIC.allowedReviewerRoles,
    minLowScoreCommentLength: 20,
    correctedArtifactRequiredOutcomes: ['accept_after_edits'],
  }],
  reviewer: {
    derivedRoleKey: 'product_owner',
    options: [{ key: 'product_owner', label: 'Product owner' }],
    requiresSelection: false,
  },
};

type Responder = (url: string, init?: RequestInit) => { status: number; body: unknown };

function mockFetch(responder: Responder) {
  const fn = jest.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = responder(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const formProps = {
  project: 'Apex',
  subjectType: 'prd' as const,
  subjectId: 'prd-1',
  stageKey: 'prd_human_review',
  canSubmit: true,
  correctedArtifact: { label: 'Corrected PRD', snapshotMarkdown: '# PRD', snapshotLabel: 'today' },
  successMessage: 'Feedback saved. It does not change this PRD or its approval.',
  testIdPrefix: 'prd-quality-feedback',
};

async function scoreAll(user: ReturnType<typeof userEvent.setup>, score: number) {
  for (const criterion of WORKFLOW_EVALUATION_PRD_RUBRIC.criteria) {
    await user.click(screen.getByTestId(`prd-quality-feedback-score-${criterion.key}-${score}`));
  }
}

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('QualityFeedbackForm', () => {
  it('posts the scores without project, hash or lineage and shows the saved message', async () => {
    const fetchMock = mockFetch((_url, init) =>
      init?.method === 'POST'
        ? { status: 201, body: { id: 'evt-1' } }
        : { status: 200, body: definitionsBody });
    const user = userEvent.setup();
    renderWithClient(<QualityFeedbackForm {...formProps} />);

    await screen.findByTestId('prd-quality-feedback-form');
    expect(screen.getByTestId('prd-quality-feedback-role')).toHaveTextContent('Product owner');
    await scoreAll(user, 4);
    await user.click(screen.getByTestId('prd-quality-feedback-outcome-accept_unchanged'));
    await user.click(screen.getByTestId('prd-quality-feedback-submit'));

    expect(await screen.findByTestId('prd-quality-feedback-success')).toHaveTextContent('does not change this PRD');
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe('/api/projects/Apex/workflow-evaluations/events');
    const body = JSON.parse(String(post?.[1]?.body));
    expect(body).toEqual({
      subjectType: 'prd',
      subjectId: 'prd-1',
      stageKey: 'prd_human_review',
      criteria: { intent_alignment: 4, requirements_coverage: 4, scope_alignment: 4, acceptance_criteria: 4, readiness: 4 },
      outcome: 'accept_unchanged',
      reasonCodes: [],
    });
  });

  it('asks for reasons and a comment after a low score, without a network call', async () => {
    const fetchMock = mockFetch(() => ({ status: 200, body: definitionsBody }));
    const user = userEvent.setup();
    renderWithClient(<QualityFeedbackForm {...formProps} />);

    await screen.findByTestId('prd-quality-feedback-form');
    expect(screen.queryByTestId('prd-quality-feedback-reason-too_vague')).not.toBeInTheDocument();
    await scoreAll(user, 2);
    expect(screen.getByTestId('prd-quality-feedback-reason-too_vague')).toBeInTheDocument();

    await user.click(screen.getByTestId('prd-quality-feedback-outcome-regenerate'));
    await user.click(screen.getByTestId('prd-quality-feedback-submit'));
    expect(await screen.findByTestId('prd-quality-feedback-error-reasonCodes')).toBeInTheDocument();
    expect(screen.getByTestId('prd-quality-feedback-error-comment')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('shows the snapshot notice for accept after edits and puts a server error on its field', async () => {
    mockFetch((_url, init) =>
      init?.method === 'POST'
        ? { status: 422, body: { error: 'Accept after edits needs the corrected PRD.', code: 'CORRECTED_ARTIFACT_REQUIRED' } }
        : { status: 200, body: definitionsBody });
    const user = userEvent.setup();
    renderWithClient(<QualityFeedbackForm {...formProps} />);

    await screen.findByTestId('prd-quality-feedback-form');
    await scoreAll(user, 4);
    await user.click(screen.getByTestId('prd-quality-feedback-outcome-accept_after_edits'));
    expect(screen.getByTestId('prd-quality-feedback-snapshot-notice')).toHaveTextContent('last updated today');
    await user.click(screen.getByTestId('prd-quality-feedback-submit'));

    expect(await screen.findByTestId('prd-quality-feedback-error-correctedText')).toHaveTextContent('needs the corrected PRD');
    expect(screen.queryByTestId('prd-quality-feedback-success')).not.toBeInTheDocument();
  });

  it('shows a retryable error when definitions fail', async () => {
    mockFetch(() => ({ status: 500, body: { error: 'boom' } }));
    renderWithClient(<QualityFeedbackForm {...formProps} />);
    expect(await screen.findByTestId('prd-quality-feedback-definitions-error')).toBeInTheDocument();
    expect(screen.getByTestId('prd-quality-feedback-definitions-retry')).toBeInTheDocument();
  });
});

describe('QualityFeedbackPromptController', () => {
  const props = {
    enabled: true,
    project: 'Apex',
    userId: 'user-1',
    subjectType: 'prd' as const,
    subjectId: 'prd-1',
    stageKey: 'prd_human_review',
    subjectLabel: 'PRD',
    canSubmit: true,
    promptReady: true,
    onOpenPanel: jest.fn(),
    testIdPrefix: 'prd-quality-feedback',
  };
  const keys = qualityFeedbackPromptKeys({
    userId: 'user-1', project: 'Apex', subjectType: 'prd', subjectId: 'prd-1', stageKey: 'prd_human_review',
  });

  function respondWithEvents(events: unknown[]) {
    return mockFetch((url) =>
      url.includes('/definitions')
        ? { status: 200, body: definitionsBody }
        : { status: 200, body: { events, truncated: false, currentArtifactHash: 'h' } });
  }

  it('opens the modal once, remembers it, and shows the banner after Skip', async () => {
    respondWithEvents([]);
    const user = userEvent.setup();
    renderWithClient(<QualityFeedbackPromptController {...props} />);

    expect(await screen.findByTestId('prd-quality-feedback-modal')).toHaveTextContent('How well did the AI write this PRD?');
    expect(window.localStorage.getItem(keys.modalSeen)).toBe('1');
    await user.click(screen.getByTestId('prd-quality-feedback-modal-skip'));

    expect(screen.queryByTestId('prd-quality-feedback-modal')).not.toBeInTheDocument();
    expect(screen.getByTestId('prd-quality-feedback-banner')).toBeInTheDocument();
    await user.click(screen.getByTestId('prd-quality-feedback-banner-dismiss'));
    expect(screen.queryByTestId('prd-quality-feedback-banner')).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(keys.bannerDismissed)).toBe('1');
  });

  it('Give feedback closes the modal and opens the panel', async () => {
    respondWithEvents([]);
    const onOpenPanel = jest.fn();
    const user = userEvent.setup();
    renderWithClient(<QualityFeedbackPromptController {...props} onOpenPanel={onOpenPanel} />);

    await user.click(await screen.findByTestId('prd-quality-feedback-modal-give-feedback'));
    expect(onOpenPanel).toHaveBeenCalled();
    expect(screen.queryByTestId('prd-quality-feedback-modal')).not.toBeInTheDocument();
  });

  it('withholds the modal while another overlay is open, without consuming it', async () => {
    respondWithEvents([]);
    const { rerender } = renderWithClient(<QualityFeedbackPromptController {...props} suppressModal />);

    expect(await screen.findByTestId('prd-quality-feedback-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('prd-quality-feedback-modal')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(keys.modalSeen)).toBeNull();

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(<QueryClientProvider client={client}><QualityFeedbackPromptController {...props} /></QueryClientProvider>);
    expect(await screen.findByTestId('prd-quality-feedback-modal')).toBeInTheDocument();
  });

  it('shows nothing once this user has given feedback', async () => {
    respondWithEvents([{ id: 'evt-1', stageKey: 'prd_human_review', reviewerUserId: 'user-1' }]);
    renderWithClient(<QualityFeedbackPromptController {...props} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('prd-quality-feedback-modal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('prd-quality-feedback-banner')).not.toBeInTheDocument();
  });

  it('still prompts when only someone else has given feedback', async () => {
    respondWithEvents([{ id: 'evt-1', stageKey: 'prd_human_review', reviewerUserId: 'someone-else' }]);
    renderWithClient(<QualityFeedbackPromptController {...props} />);
    expect(await screen.findByTestId('prd-quality-feedback-modal')).toBeInTheDocument();
  });
});
