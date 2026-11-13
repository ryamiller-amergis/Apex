const mockReturning = jest.fn();
const mockValues = jest.fn();
const mockSet = jest.fn();
jest.mock('../db/drizzle', () => ({
  db: {
    insert: () => ({
      values: (...args: unknown[]) => {
        mockValues(...args);
        return { onConflictDoNothing: () => ({ returning: () => mockReturning() }) };
      },
    }),
    update: () => ({
      set: (...args: unknown[]) => {
        mockSet(...args);
        return { where: async () => undefined };
      },
    }),
  },
}));

const mockResolve = jest.fn();
jest.mock('../services/artifactBindingResolver', () => ({
  resolveCurrentArtifactBinding: (...args: unknown[]) => mockResolve(...args),
}));

const mockWriteSnapshot = jest.fn();
jest.mock('../services/workflowEvaluationArtifactStore', () => ({
  writeRegressionSnapshot: (...args: unknown[]) => mockWriteSnapshot(...args),
}));

const mockGetDefinition = jest.fn();
jest.mock('../services/workflowEvaluationRepository', () => ({
  getDefinitionById: (...args: unknown[]) => mockGetDefinition(...args),
}));

const mockRegister = jest.fn();
jest.mock('../services/workflowEvaluationService', () => ({
  registerEventStoredListener: (...args: unknown[]) => mockRegister(...args),
}));

import {
  SkillRegressionCaseRequestError,
  captureSnapshot,
  lowScoreCriteria,
  onEvaluationEventStored,
  parseRegressionCaseFilters,
  parseRegressionCaseUpdate,
  regressionReason,
  registerSkillRegressionCaseListener,
} from '../services/skillRegressionCaseService';
import { WorkflowEvaluationError } from '../services/workflowEvaluationError';
import type { WorkflowEvaluationEvent } from '../../shared/types/workflowEvaluation';

const HASH = 'a'.repeat(64);
const CASE_ID = '33333333-3333-4333-8333-333333333333';
const EVENT_ID = '44444444-4444-4444-8444-444444444444';
const PRD_ID = '11111111-1111-4111-8111-111111111111';

function scores(value: number, overrides: Record<string, number> = {}): Record<string, number> {
  return {
    intent_alignment: value,
    requirements_coverage: value,
    scope_alignment: value,
    acceptance_criteria: value,
    readiness: value,
    ...overrides,
  };
}

function target() {
  return {
    id: CASE_ID,
    project: 'proj-a',
    eventId: EVENT_ID,
    subjectType: 'prd' as const,
    subjectId: PRD_ID,
    phaseIndex: null,
    artifactHash: HASH,
  };
}

function event(overrides: Partial<WorkflowEvaluationEvent> = {}): WorkflowEvaluationEvent {
  return {
    id: EVENT_ID,
    projectId: 'proj-a',
    processKey: 'orchestrated_workflow',
    stageKey: 'prd_human_review',
    definitionId: 'def-1',
    definitionVersion: 1,
    subjectType: 'prd',
    subjectId: PRD_ID,
    phaseIndex: null,
    reviewerUserId: 'user-1',
    reviewerName: 'Ada',
    reviewerRoleKey: 'prd_owner',
    reviewerRoleLabel: 'PRD owner',
    lineage: {
      skillPath: '.cursor/skills/to-prd/SKILL.md',
      skillVersion: 'sha-1',
      model: 'claude',
      interviewId: null,
      prdId: PRD_ID,
    },
    artifactContentHash: HASH,
    criteria: scores(4, { readiness: 2 }) as WorkflowEvaluationEvent['criteria'],
    outcome: 'regenerate',
    reasonCodes: [],
    comment: 'Readiness is weak.',
    hasCorrectedArtifact: false,
    createdAt: '2026-10-22T00:00:00.000Z',
    ...overrides,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  mockReturning.mockResolvedValue([target()]);
  mockGetDefinition.mockResolvedValue({ id: 'def-1', rubric: { lowScoreThreshold: 2 } });
  mockResolve.mockResolvedValue({
    artifactHash: HASH,
    artifact: { subjectType: 'prd', markdown: '# PRD', backlog: null },
  });
  mockWriteSnapshot.mockResolvedValue({ container: 'artifacts', key: 'k' });
});

describe('regressionReason', () => {
  it.each([
    ['accept_after_edits', true, scores(4), 'corrected_text'],
    ['regenerate', false, scores(4, { readiness: 2 }), 'low_score'],
    ['accept_after_edits', true, scores(1), 'both'],
    ['accept_after_edits', false, scores(4), null],
    ['regenerate', true, scores(3), null],
    ['accept_unchanged', false, scores(5), null],
  ] as const)('%s with corrected=%s -> %s', (outcome, hasCorrectedArtifact, criteria, expected) => {
    expect(regressionReason({ outcome, hasCorrectedArtifact, criteria, lowScoreThreshold: 2 })).toBe(expected);
  });
});

describe('lowScoreCriteria', () => {
  it('returns sorted keys at or below the threshold', () => {
    expect(lowScoreCriteria(scores(4, { readiness: 2, intent_alignment: 1 }), 2))
      .toEqual(['intent_alignment', 'readiness']);
  });
});

describe('parseRegressionCaseFilters', () => {
  it('accepts status and skill path, ignores empty values', () => {
    expect(parseRegressionCaseFilters({ status: 'retired', skillPath: 'a/SKILL.md' }))
      .toEqual({ status: 'retired', skillPath: 'a/SKILL.md' });
    expect(parseRegressionCaseFilters({ status: '', skillPath: '' })).toEqual({});
  });

  it.each([{ status: 'deleted' }, { status: ['active'] }, { skillPath: ['a'] }, { skillPath: 'x'.repeat(501) }])(
    'rejects %j',
    (query) => {
      expect(() => parseRegressionCaseFilters(query)).toThrow(SkillRegressionCaseRequestError);
    },
  );
});

describe('parseRegressionCaseUpdate', () => {
  it('restores without a reason', () => {
    expect(parseRegressionCaseUpdate({ status: 'active', reason: 'ignored' })).toEqual({ status: 'active' });
  });

  it('trims the retire reason', () => {
    expect(parseRegressionCaseUpdate({ status: 'retired', reason: '  wrong doc  ' }))
      .toEqual({ status: 'retired', reason: 'wrong doc' });
  });

  it.each([
    null,
    [],
    { status: 'deleted' },
    { status: 'retired' },
    { status: 'retired', reason: '   ' },
    { status: 'retired', reason: 'x'.repeat(501) },
  ])('rejects %j', (body) => {
    expect(() => parseRegressionCaseUpdate(body)).toThrow(SkillRegressionCaseRequestError);
  });
});

describe('captureSnapshot', () => {
  it('stores the parts the hash covers when the document still matches', async () => {
    await expect(captureSnapshot(target())).resolves.toBe('stored');
    expect(mockResolve).toHaveBeenCalledWith({
      project: 'proj-a',
      subjectType: 'prd',
      subjectId: PRD_ID,
      phaseIndex: null,
    });
    expect(mockWriteSnapshot).toHaveBeenCalledWith('proj-a', expect.objectContaining({
      version: 1,
      eventId: EVENT_ID,
      artifactHash: HASH,
      artifact: { subjectType: 'prd', markdown: '# PRD', backlog: null },
    }));
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      snapshotStatus: 'stored',
      originalBlobRef: { container: 'artifacts', key: 'k' },
    }));
  });

  it('marks artifact_changed without writing when the hash moved', async () => {
    mockResolve.mockResolvedValueOnce({ artifactHash: 'b'.repeat(64), artifact: {} });
    await expect(captureSnapshot(target())).resolves.toBe('artifact_changed');
    expect(mockWriteSnapshot).not.toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      snapshotStatus: 'artifact_changed',
      originalBlobRef: null,
    }));
  });

  it('marks artifact_changed when the subject is gone or not ready', async () => {
    mockResolve.mockRejectedValueOnce(new WorkflowEvaluationError('SUBJECT_NOT_FOUND', 'gone'));
    await expect(captureSnapshot(target())).resolves.toBe('artifact_changed');
  });

  it('marks failed when the lookup or the write throws for another reason', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockResolve.mockRejectedValueOnce(new Error('db down'));
    await expect(captureSnapshot(target())).resolves.toBe('failed');
    mockWriteSnapshot.mockRejectedValueOnce(new Error('blob down'));
    await expect(captureSnapshot(target())).resolves.toBe('failed');
    expect(mockSet).toHaveBeenLastCalledWith(expect.objectContaining({ snapshotStatus: 'failed' }));
  });
});

describe('onEvaluationEventStored', () => {
  it('inserts a case with the review lineage and copies the document afterwards', async () => {
    await onEvaluationEventStored(event());
    expect(mockValues).toHaveBeenCalledWith({
      project: 'proj-a',
      eventId: EVENT_ID,
      subjectType: 'prd',
      subjectId: PRD_ID,
      phaseIndex: null,
      skillPath: '.cursor/skills/to-prd/SKILL.md',
      skillVersion: 'sha-1',
      artifactHash: HASH,
      reason: 'low_score',
    });
    await flush();
    expect(mockWriteSnapshot).toHaveBeenCalledTimes(1);
  });

  it('skips reviews that do not qualify', async () => {
    await onEvaluationEventStored(event({
      criteria: scores(4) as WorkflowEvaluationEvent['criteria'],
      outcome: 'accept_unchanged',
    }));
    expect(mockValues).not.toHaveBeenCalled();
  });

  it('does not copy again when the case already exists', async () => {
    mockReturning.mockResolvedValueOnce([]);
    await onEvaluationEventStored(event());
    await flush();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('does nothing when the definition is missing', async () => {
    mockGetDefinition.mockResolvedValueOnce(null);
    await onEvaluationEventStored(event());
    expect(mockValues).not.toHaveBeenCalled();
  });

  it('registers itself as an event listener', () => {
    registerSkillRegressionCaseListener();
    expect(mockRegister).toHaveBeenCalledWith(onEvaluationEventStored);
  });
});
