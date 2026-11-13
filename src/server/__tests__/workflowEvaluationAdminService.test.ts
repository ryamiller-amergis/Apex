const mockListProjectEvents = jest.fn();
const mockListJobsForEvents = jest.fn();
const mockGetEventWithJobs = jest.fn();
const mockGetDefinitionById = jest.fn();
jest.mock('../services/workflowEvaluationRepository', () => ({
  listProjectEvents: (...args: unknown[]) => mockListProjectEvents(...args),
  listJobsForEvents: (...args: unknown[]) => mockListJobsForEvents(...args),
  getEventWithJobs: (...args: unknown[]) => mockGetEventWithJobs(...args),
  getDefinitionById: (...args: unknown[]) => mockGetDefinitionById(...args),
}));

const mockDownload = jest.fn();
jest.mock('../services/aiRunV2/artifactContainer', () => ({
  resolveArtifactContainerClient: () => ({
    getBlockBlobClient: () => ({ downloadToBuffer: mockDownload }),
  }),
}));

jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn() }));

import {
  AdminEvaluationRequestError,
  decodeAdminEvaluationCursor,
  encodeAdminEvaluationCursor,
  exportAdminEvaluationEvents,
  getAdminEvaluationEventDetail,
  getAdminEvaluationJudgeAppendix,
  listAdminEvaluationEvents,
  parseAdminEvaluationFilters,
  parseAdminEvaluationLimit,
} from '../services/workflowEvaluationAdminService';
import { WORKFLOW_EVALUATION_PRD_RUBRIC } from '../../shared/types/workflowEvaluation';

const EVENT_A = '00000000-0000-4000-8000-00000000000a';
const EVENT_B = '00000000-0000-4000-8000-00000000000b';

function record(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    project: 'Apex',
    definitionId: 'def-1',
    definitionVersion: 1,
    processKey: 'orchestrated_workflow',
    subjectType: 'prd',
    subjectId: 'prd-1',
    stageKey: 'prd_human_review',
    phaseIndex: null,
    reviewerUserId: 'user-1',
    reviewerName: 'Ada',
    reviewerRoleKey: 'product_owner',
    reviewerRoleLabel: 'Product owner',
    skillPath: '.cursor/skills/to-prd/SKILL.md',
    skillVersion: 'abc',
    model: 'claude',
    interviewId: 'int-1',
    prdId: 'prd-1',
    artifactHash: 'h'.repeat(64),
    criteriaScores: {
      intent_alignment: 4,
      requirements_coverage: 2,
      scope_alignment: 5,
      acceptance_criteria: 3,
      readiness: 4,
    },
    outcome: 'regenerate',
    reasonCodes: ['missing_requirement'],
    comment: '=HYPERLINK("x")',
    correctedArtifactText: null,
    correctedArtifactBlobRef: null,
    createdAt: '2026-10-21T10:00:00.000Z',
    ...overrides,
  };
}

function job(eventId: string, evaluatorKey: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `${eventId}-${evaluatorKey}`,
    eventId,
    evaluatorKey,
    status,
    runId: 'run-1',
    specificationHash: 'spec',
    summary: null,
    resultBlobRefs: null,
    errorDetail: null,
    createdAt: '2026-10-21T10:00:01.000Z',
    updatedAt: '2026-10-21T10:05:00.000Z',
    ...overrides,
  };
}

const judgeOutput = {
  missedRequirements: [{ description: 'Audit log' }],
  inventedRequirements: [],
  recommendedImprovements: [{ text: 'Add the audit log requirement' }],
  confidence: 'medium',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockListJobsForEvents.mockResolvedValue([]);
  mockGetDefinitionById.mockResolvedValue({ id: 'def-1', version: 1, rubric: WORKFLOW_EVALUATION_PRD_RUBRIC });
});

describe('parseAdminEvaluationFilters', () => {
  it('keeps known values and drops blanks', () => {
    expect(parseAdminEvaluationFilters({
      outcome: 'reject', stage: 'prd_human_review', reason: 'too_vague', subjectType: 'prd',
      from: '2026-10-01', to: '2026-10-21', q: ' 1a2b ', eventId: '', extra: 'x',
    })).toEqual({
      outcome: 'reject', stage: 'prd_human_review', reason: 'too_vague', subjectType: 'prd',
      from: '2026-10-01', to: '2026-10-21', q: '1a2b',
    });
  });

  it.each([
    [{ outcome: 'maybe' }],
    [{ reason: 'nope' }],
    [{ subjectType: 'design' }],
    [{ from: '2026-02-30' }],
    [{ from: '2026-10-21', to: '2026-10-01' }],
    [{ eventId: 'not-a-uuid' }],
    [{ q: 'x'.repeat(101) }],
  ])('rejects %j', (query) => {
    expect(() => parseAdminEvaluationFilters(query)).toThrow(AdminEvaluationRequestError);
  });

  it('clamps limit to 1..200', () => {
    expect(parseAdminEvaluationLimit(undefined)).toBe(50);
    expect(parseAdminEvaluationLimit('200')).toBe(200);
    expect(() => parseAdminEvaluationLimit('201')).toThrow(AdminEvaluationRequestError);
    expect(() => parseAdminEvaluationLimit('0')).toThrow(AdminEvaluationRequestError);
  });

  it('round-trips the cursor and rejects junk', () => {
    const cursor = { createdAt: '2026-10-21 10:00:00.123456+00', id: EVENT_A };
    expect(decodeAdminEvaluationCursor(encodeAdminEvaluationCursor(cursor))).toEqual(cursor);
    expect(decodeAdminEvaluationCursor(undefined)).toBeUndefined();
    expect(() => decodeAdminEvaluationCursor('garbage')).toThrow(AdminEvaluationRequestError);
  });
});

describe('listAdminEvaluationEvents', () => {
  it('scopes to the project, converts dates to a UTC range, and pages by cursor', async () => {
    mockListProjectEvents.mockResolvedValue([record(EVENT_A), record(EVENT_B, { createdAt: '2026-10-20T10:00:00.000Z' })]);
    mockListJobsForEvents.mockResolvedValue([job(EVENT_A, 'promptfoo', 'ready'), job(EVENT_A, 'llm_judge', 'failed')]);

    const result = await listAdminEvaluationEvents('Apex', { from: '2026-10-01', to: '2026-10-21' }, { limit: 1 });

    expect(mockListProjectEvents).toHaveBeenCalledWith(expect.objectContaining({
      project: 'Apex',
      limit: 2,
      filters: expect.objectContaining({
        createdFrom: '2026-10-01T00:00:00.000Z',
        createdBefore: '2026-10-22T00:00:00.000Z',
      }),
    }));
    expect(mockListJobsForEvents).toHaveBeenCalledWith([EVENT_A]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: EVENT_A,
      stageLabel: 'PRD review',
      outcomeLabel: 'Regenerate',
      criteriaAverage: 3.6,
      reviewerDisplayName: 'Ada',
      jobs: [{ evaluatorKey: 'promptfoo', status: 'ready' }, { evaluatorKey: 'llm_judge', status: 'failed' }],
    });
    expect(decodeAdminEvaluationCursor(result.nextCursor)).toEqual({ createdAt: '2026-10-21T10:00:00.000Z', id: EVENT_A });
  });

  it('returns no cursor on the last page', async () => {
    mockListProjectEvents.mockResolvedValue([record(EVENT_A)]);
    const result = await listAdminEvaluationEvents('Apex', {}, { limit: 50 });
    expect(result.nextCursor).toBeNull();
  });
});

describe('getAdminEvaluationEventDetail', () => {
  it('returns null for a missing or other-project event', async () => {
    mockGetEventWithJobs.mockResolvedValue(null);
    await expect(getAdminEvaluationEventDetail('Apex', EVENT_A)).resolves.toBeNull();
    expect(mockGetEventWithJobs).toHaveBeenCalledWith('Apex', EVENT_A);
  });

  it('labels scores from the event definition and exposes judge output and Promptfoo failure', async () => {
    mockGetEventWithJobs.mockResolvedValue({
      ...record(EVENT_A),
      jobs: [
        job(EVENT_A, 'promptfoo', 'failed', { errorDetail: 'assertions_failed: 1 of 3 Promptfoo tests failed' }),
        job(EVENT_A, 'llm_judge', 'ready', {
          summary: judgeOutput,
          resultBlobRefs: { appendix: { container: 'c', key: 'k/judge-result.md' } },
        }),
      ],
    });

    const detail = await getAdminEvaluationEventDetail('Apex', EVENT_A);

    expect(detail?.criteria[1]).toEqual({
      key: 'requirements_coverage', label: 'Requirements coverage', score: 2, scaleLabel: 'Major changes needed',
    });
    expect(detail?.reasons).toEqual([{ key: 'missing_requirement', label: 'Missing requirement' }]);
    expect(detail?.judge).toEqual({ output: judgeOutput, hasAppendix: true });
    expect(detail?.promptfooFailed).toBe(true);
    expect(detail?.jobs[0]).toMatchObject({ evaluatorKey: 'promptfoo', errorDetail: expect.stringContaining('assertions_failed') });
  });

  it('hides judge output while the judge job is not ready', async () => {
    mockGetEventWithJobs.mockResolvedValue({
      ...record(EVENT_A),
      jobs: [job(EVENT_A, 'llm_judge', 'running', { summary: judgeOutput })],
    });
    const detail = await getAdminEvaluationEventDetail('Apex', EVENT_A);
    expect(detail?.judge).toEqual({ output: null, hasAppendix: false });
  });
});

describe('getAdminEvaluationJudgeAppendix', () => {
  it('reads the appendix blob of a ready judge job', async () => {
    mockGetEventWithJobs.mockResolvedValue({
      ...record(EVENT_A),
      jobs: [job(EVENT_A, 'llm_judge', 'ready', { resultBlobRefs: { appendix: { container: 'c', key: 'k' } } })],
    });
    mockDownload.mockResolvedValue(Buffer.from('# Narrative'));
    await expect(getAdminEvaluationJudgeAppendix('Apex', EVENT_A)).resolves.toEqual({ status: 'ok', markdown: '# Narrative' });
  });

  it('answers not_found when there is no appendix', async () => {
    mockGetEventWithJobs.mockResolvedValue({ ...record(EVENT_A), jobs: [job(EVENT_A, 'llm_judge', 'failed')] });
    await expect(getAdminEvaluationJudgeAppendix('Apex', EVENT_A)).resolves.toEqual({ status: 'not_found' });
    expect(mockDownload).not.toHaveBeenCalled();
  });
});

describe('exportAdminEvaluationEvents', () => {
  const now = new Date('2026-10-21T12:00:00.000Z');

  it('writes CSV with job statuses and neutralized cells', async () => {
    mockListProjectEvents.mockResolvedValue([record(EVENT_A, { skillPath: '=cmd' })]);
    mockListJobsForEvents.mockResolvedValue([job(EVENT_A, 'promptfoo', 'ready'), job(EVENT_A, 'llm_judge', 'failed')]);

    const result = await exportAdminEvaluationEvents('Apex', {}, 'csv', 'user-1', now);

    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.filename).toBe('workflow-evaluations-Apex-2026-10-21.csv');
    const [header, row] = result.body.trim().split('\r\n');
    expect(header.split(',')).toHaveLength(22);
    expect(row).toContain("'=cmd");
    expect(row.endsWith('ready,failed')).toBe(true);
    expect(result.body).not.toContain('HYPERLINK');
  });

  it('writes JSON with blob names, not refs', async () => {
    mockListProjectEvents.mockResolvedValue([record(EVENT_A)]);
    mockListJobsForEvents.mockResolvedValue([
      job(EVENT_A, 'llm_judge', 'ready', { resultBlobRefs: { output: { container: 'c', key: 'k/out.json' } } }),
    ]);

    const result = await exportAdminEvaluationEvents('Apex', { outcome: 'regenerate' }, 'json', 'user-1', now);

    if (result.status !== 'ok') throw new Error('expected ok');
    const body = JSON.parse(result.body);
    expect(body).toMatchObject({ projectId: 'Apex', filters: { outcome: 'regenerate' } });
    expect(body.events[0].jobs[0].resultBlobNames).toEqual({ output: 'k/out.json' });
  });

  it('refuses more than the row limit', async () => {
    mockListProjectEvents.mockResolvedValue(Array.from({ length: 2_001 }, (_, i) => record(`id-${i}`)));
    await expect(exportAdminEvaluationEvents('Apex', {}, 'json', 'user-1', now)).resolves.toEqual({
      status: 'too_many', limit: 2_000,
    });
  });
});
