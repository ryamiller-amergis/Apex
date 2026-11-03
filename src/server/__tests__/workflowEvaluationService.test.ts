/**
 * Workflow evaluation service — TBI-007 VT-12 through VT-25.
 */

jest.mock('../services/workflowEvaluationRepository', () => ({
  getActiveDefinition: jest.fn(),
  listActiveDefinitions: jest.fn(),
  insertEvent: jest.fn(),
  listEventsForSubject: jest.fn(),
  getEventWithJobs: jest.fn(),
  getReviewerDisplayName: jest.fn(),
}));

jest.mock('../services/workflowEvaluationArtifactStore', () => ({
  writeCorrectedArtifact: jest.fn(),
  deleteCorrectedArtifact: jest.fn(),
}));

jest.mock('../services/artifactBindingResolver', () => ({
  resolveCurrentArtifactBinding: jest.fn(),
}));

jest.mock('../services/groupService', () => ({
  getUserGroupNamesForProject: jest.fn(),
}));

jest.mock('../services/telemetry', () => ({
  trackEvent: jest.fn(),
  telemetryClient: { trackMetric: jest.fn() },
}));

import {
  WORKFLOW_EVALUATION_INTERVIEW_PHASE_RUBRIC,
  WORKFLOW_EVALUATION_PRD_RUBRIC,
  type WorkflowEvaluationCriteriaScores,
} from '../../shared/types/workflowEvaluation';
import { WorkflowEvaluationError } from '../services/workflowEvaluationError';
import {
  getEvaluationEvent,
  listEvaluationEvents,
  registerEventStoredListener,
  resetEventStoredListeners,
  submitEvaluation,
} from '../services/workflowEvaluationService';

const repository = jest.requireMock('../services/workflowEvaluationRepository') as Record<string, jest.Mock>;
const store = jest.requireMock('../services/workflowEvaluationArtifactStore') as Record<string, jest.Mock>;
const resolver = jest.requireMock('../services/artifactBindingResolver') as {
  resolveCurrentArtifactBinding: jest.Mock;
};
const groups = jest.requireMock('../services/groupService') as {
  getUserGroupNamesForProject: jest.Mock;
};
const telemetry = jest.requireMock('../services/telemetry') as {
  trackEvent: jest.Mock;
  telemetryClient: { trackMetric: jest.Mock };
};

const prdDefinition = {
  id: 'def-prd',
  processKey: 'orchestrated_workflow',
  stageKey: 'prd_human_review',
  evaluatorKey: 'human_review',
  benchmarkKey: 'baseline',
  version: 3,
  rubric: WORKFLOW_EVALUATION_PRD_RUBRIC,
  promptfooSuiteRef: 'suite',
  judgeOutputSchema: {},
  active: true,
  createdAt: '2026-10-16T00:00:00.000Z',
};

const interviewDefinition = {
  ...prdDefinition,
  id: 'def-interview',
  stageKey: 'interview_phase_3',
  rubric: WORKFLOW_EVALUATION_INTERVIEW_PHASE_RUBRIC,
};

function scores(value: number, overrides: Partial<Record<string, unknown>> = {}): WorkflowEvaluationCriteriaScores {
  return {
    intent_alignment: value,
    requirements_coverage: value,
    scope_alignment: value,
    acceptance_criteria: value,
    readiness: value,
    ...overrides,
  } as WorkflowEvaluationCriteriaScores;
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    project: 'proj-a',
    subjectType: 'prd',
    subjectId: '11111111-1111-1111-1111-111111111111',
    phaseIndex: null,
    artifactHash: 'a'.repeat(64),
    lineage: {
      skillPath: '.cursor/skills/to-prd/SKILL.md',
      skillVersion: 'grounded-sha',
      model: 'claude',
      interviewId: '22222222-2222-2222-2222-222222222222',
      prdId: '11111111-1111-1111-1111-111111111111',
    },
    prdMarkdown: '# Live PRD',
    ...overrides,
  };
}

function storedFromInsert(input: Record<string, unknown>) {
  return {
    ...input,
    correctedArtifactText: null,
    createdAt: '2026-10-16T12:00:00.000Z',
    processKey: prdDefinition.processKey,
    definitionVersion: prdDefinition.version,
    reviewerName: 'Ada',
  };
}

const subjectId = '11111111-1111-1111-1111-111111111111';

function prdRequest(overrides: Record<string, unknown> = {}) {
  return {
    subjectType: 'prd' as const,
    subjectId,
    stageKey: 'prd_human_review',
    criteria: scores(4),
    outcome: 'accept_unchanged' as const,
    reasonCodes: [] as string[],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetEventStoredListeners();
  repository.getActiveDefinition.mockResolvedValue(prdDefinition);
  repository.getReviewerDisplayName.mockResolvedValue('Ada');
  repository.insertEvent.mockImplementation(async (input: Record<string, unknown>) => storedFromInsert(input));
  resolver.resolveCurrentArtifactBinding.mockResolvedValue(binding());
  groups.getUserGroupNamesForProject.mockResolvedValue(['Product-Owner']);
  store.writeCorrectedArtifact.mockResolvedValue({
    container: 'ai-run-artifacts',
    key: 'workflow-evaluations/proj-a/event/corrected-artifact.md',
  });
  store.deleteCorrectedArtifact.mockResolvedValue(undefined);
});

describe('submitEvaluation — TBI-007', () => {
  it('VT-12 / TBI-007 (a): stores one event with server lineage, hash, role and definition version', async () => {
    const started = Date.now();
    const event = await submitEvaluation('proj-a', 'user-1', prdRequest());
    expect(Date.now() - started).toBeLessThan(2000);
    expect(repository.insertEvent).toHaveBeenCalledTimes(1);
    expect(repository.insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      project: 'proj-a',
      definitionId: 'def-prd',
      reviewerRoleKey: 'product_owner',
      reviewerRoleLabel: 'Product owner',
      skillPath: '.cursor/skills/to-prd/SKILL.md',
      skillVersion: 'grounded-sha',
      model: 'claude',
      artifactHash: 'a'.repeat(64),
      correctedArtifactBlobRef: null,
    }));
    expect(event).toMatchObject({
      projectId: 'proj-a',
      definitionVersion: 3,
      artifactContentHash: 'a'.repeat(64),
      reviewerRoleKey: 'product_owner',
      hasCorrectedArtifact: false,
      lineage: { skillVersion: 'grounded-sha' },
    });
    expect(event).not.toHaveProperty('correctedArtifactBlobRef');
  });

  it.each([
    ['score 0', scores(4, { readiness: 0 })],
    ['score 6', scores(4, { readiness: 6 })],
    ['score 3.5', scores(4, { readiness: 3.5 })],
    ['score text', scores(4, { readiness: '4' })],
    ['missing criterion', { intent_alignment: 4, requirements_coverage: 4, scope_alignment: 4, acceptance_criteria: 4 }],
    ['extra criterion', scores(4, { extra: 4 })],
  ])('VT-13 / TBI-007 (b): %s is INVALID_SCORES and stores nothing', async (_label, criteria) => {
    await expect(submitEvaluation('proj-a', 'user-1', prdRequest({ criteria }))).rejects.toMatchObject({
      code: 'INVALID_SCORES',
    });
    expect(repository.insertEvent).not.toHaveBeenCalled();
    expect(store.writeCorrectedArtifact).not.toHaveBeenCalled();
  });

  it('VT-14 / TBI-007 (b): an unknown outcome is INVALID_OUTCOME', async () => {
    await expect(submitEvaluation('proj-a', 'user-1', prdRequest({ outcome: 'approve' }))).rejects.toMatchObject({
      code: 'INVALID_OUTCOME',
    });
    expect(repository.insertEvent).not.toHaveBeenCalled();
  });

  it('VT-15 / TBI-007 (b)(c): a score of 2 needs a reason and a trimmed comment of 20 characters', async () => {
    const low = scores(3, { readiness: 2 });
    await expect(submitEvaluation('proj-a', 'user-1', prdRequest({
      criteria: low,
      reasonCodes: [],
      comment: 'long enough comment here',
    }))).rejects.toMatchObject({ code: 'REASON_REQUIRED' });

    await expect(submitEvaluation('proj-a', 'user-1', prdRequest({
      criteria: low,
      reasonCodes: ['missing_requirement'],
      comment: '1234567890123456789',
    }))).rejects.toMatchObject({ code: 'COMMENT_TOO_SHORT' });

    await expect(submitEvaluation('proj-a', 'user-1', prdRequest({
      criteria: low,
      reasonCodes: ['missing_requirement'],
      comment: '12345678901234567890',
    }))).resolves.toMatchObject({ outcome: 'accept_unchanged' });

    await expect(submitEvaluation('proj-a', 'user-1', prdRequest({
      criteria: low,
      reasonCodes: ['missing_requirement'],
      comment: '   1234567890123456789   ',
    }))).rejects.toMatchObject({ code: 'COMMENT_TOO_SHORT' });
  });

  it('VT-16 / TBI-007 (c): scores of 3 need no reasons and no comment', async () => {
    await expect(submitEvaluation('proj-a', 'user-1', prdRequest({
      criteria: scores(3),
    }))).resolves.toMatchObject({ comment: null, reasonCodes: [] });
  });

  it('VT-17 / TBI-007 (b)(c): a PRD accept-after-edits needs a corrected artifact and an interview phase does not', async () => {
    await expect(submitEvaluation('proj-a', 'user-1', prdRequest({
      outcome: 'accept_after_edits',
    }))).rejects.toMatchObject({ code: 'CORRECTED_ARTIFACT_REQUIRED' });

    repository.getActiveDefinition.mockResolvedValue(interviewDefinition);
    resolver.resolveCurrentArtifactBinding.mockResolvedValue(binding({
      subjectType: 'interview_phase',
      phaseIndex: 3,
      prdMarkdown: null,
      lineage: {
        skillPath: '.cursor/skills/grill-with-docs/SKILL.md',
        skillVersion: 'sha',
        model: 'claude',
        interviewId: subjectId,
        prdId: null,
      },
    }));
    await expect(submitEvaluation('proj-a', 'user-1', {
      subjectType: 'interview_phase',
      subjectId,
      stageKey: 'interview_phase_3',
      criteria: scores(4),
      outcome: 'accept_after_edits',
    })).resolves.toMatchObject({ hasCorrectedArtifact: false });
    expect(store.writeCorrectedArtifact).not.toHaveBeenCalled();
  });

  it('VT-18 / TBI-007 (a): current_prd stores the server markdown and pasted stores the pasted text', async () => {
    await submitEvaluation('proj-a', 'user-1', prdRequest({
      outcome: 'accept_after_edits',
      correctedArtifact: { source: 'current_prd' },
    }));
    expect(store.writeCorrectedArtifact).toHaveBeenCalledWith(
      'proj-a',
      expect.any(String),
      '# Live PRD',
    );

    store.writeCorrectedArtifact.mockClear();
    await submitEvaluation('proj-a', 'user-1', prdRequest({
      outcome: 'accept_after_edits',
      correctedArtifact: { source: 'pasted', text: '# Pasted' },
    }));
    expect(store.writeCorrectedArtifact).toHaveBeenCalledWith(
      'proj-a',
      expect.any(String),
      '# Pasted',
    );
    const inserted = repository.insertEvent.mock.calls[repository.insertEvent.mock.calls.length - 1]?.[0];
    expect(inserted.correctedArtifactBlobRef.key).toContain('workflow-evaluations/');
    expect(inserted.correctedArtifactText).toBeUndefined();
  });

  it('VT-19 / TBI-007 (b): a blob failure stores nothing, and an insert failure deletes the orphan blob', async () => {
    store.writeCorrectedArtifact.mockRejectedValueOnce(new Error('blob down'));
    await expect(submitEvaluation('proj-a', 'user-1', prdRequest({
      outcome: 'accept_after_edits',
      correctedArtifact: { source: 'pasted', text: '# Pasted' },
    }))).rejects.toMatchObject({ code: 'ARTIFACT_STORAGE_UNAVAILABLE' });
    expect(repository.insertEvent).not.toHaveBeenCalled();

    store.writeCorrectedArtifact.mockResolvedValue({
      container: 'ai-run-artifacts',
      key: 'workflow-evaluations/proj-a/event/corrected-artifact.md',
    });
    repository.insertEvent.mockRejectedValueOnce(new Error('insert failed'));
    await expect(submitEvaluation('proj-a', 'user-1', prdRequest({
      outcome: 'accept_after_edits',
      correctedArtifact: { source: 'pasted', text: '# Pasted' },
    }))).rejects.toThrow('insert failed');
    expect(store.deleteCorrectedArtifact).toHaveBeenCalledTimes(1);
  });

  it('VT-20 / TBI-007 (c)(d): reviewer role follows project groups and the definition list', async () => {
    groups.getUserGroupNamesForProject.mockResolvedValue(['BA']);
    await expect(submitEvaluation('proj-a', 'user-1', prdRequest())).resolves.toMatchObject({
      reviewerRoleKey: 'ba',
    });

    groups.getUserGroupNamesForProject.mockResolvedValue([]);
    await expect(submitEvaluation('proj-a', 'user-1', prdRequest())).rejects.toMatchObject({
      code: 'ROLE_REQUIRED',
    });
    await expect(submitEvaluation('proj-a', 'user-1', prdRequest({
      reviewerRole: 'qa',
    }))).resolves.toMatchObject({ reviewerRoleKey: 'qa' });

    groups.getUserGroupNamesForProject.mockResolvedValue(['BA', 'Manager']);
    await expect(submitEvaluation('proj-a', 'user-1', prdRequest())).rejects.toMatchObject({
      code: 'ROLE_REQUIRED',
    });
    await expect(submitEvaluation('proj-a', 'user-1', prdRequest({
      reviewerRole: 'manager',
    }))).resolves.toMatchObject({ reviewerRoleKey: 'manager' });

    groups.getUserGroupNamesForProject.mockResolvedValue(['BA']);
    await expect(submitEvaluation('proj-a', 'user-1', prdRequest({
      reviewerRole: 'manager',
    }))).rejects.toMatchObject({ code: 'ROLE_NOT_ALLOWED' });
    await expect(submitEvaluation('proj-a', 'user-1', prdRequest({
      reviewerRole: 'not-a-role',
    }))).rejects.toMatchObject({ code: 'ROLE_NOT_ALLOWED' });
    await expect(submitEvaluation('proj-a', 'user-1', prdRequest({
      reviewerRole: 'platform_admin',
    }))).rejects.toMatchObject({ code: 'ROLE_NOT_ALLOWED' });

    groups.getUserGroupNamesForProject.mockResolvedValue([]);
    await submitEvaluation('proj-a', 'user-1', prdRequest({ reviewerRole: 'other' })).catch(() => undefined);
    expect(groups.getUserGroupNamesForProject).toHaveBeenCalledWith('user-1', 'proj-a');
  });

  it('VT-21 / TBI-007 (d): a subject in another project is not found and nothing is stored', async () => {
    resolver.resolveCurrentArtifactBinding.mockRejectedValue(
      new WorkflowEvaluationError('SUBJECT_NOT_FOUND', 'Subject was not found in this project.'),
    );
    await expect(submitEvaluation('proj-a', 'user-1', prdRequest())).rejects.toMatchObject({
      code: 'SUBJECT_NOT_FOUND',
    });
    await expect(listEvaluationEvents('proj-a', {
      subjectType: 'prd',
      subjectId,
    })).rejects.toMatchObject({ code: 'SUBJECT_NOT_FOUND' });
    repository.getEventWithJobs.mockResolvedValue(null);
    await expect(getEvaluationEvent('proj-a', subjectId)).resolves.toBeNull();
    expect(repository.insertEvent).not.toHaveBeenCalled();
  });

  it('VT-22 / TBI-007 (c): history defaults to the current hash and caps at 50', async () => {
    const current = [0, 1].map((index) => storedFromInsert({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      project: 'proj-a',
      definitionId: 'def-prd',
      subjectType: 'prd',
      subjectId,
      stageKey: 'prd_human_review',
      phaseIndex: null,
      reviewerUserId: 'user-1',
      reviewerRoleKey: 'product_owner',
      reviewerRoleLabel: 'Product owner',
      skillPath: null,
      skillVersion: null,
      model: null,
      interviewId: null,
      prdId: subjectId,
      artifactHash: 'a'.repeat(64),
      criteriaScores: scores(4),
      outcome: 'accept_unchanged',
      reasonCodes: [],
      comment: null,
      correctedArtifactBlobRef: null,
      createdAt: `2026-10-16T12:00:0${index}.000Z`,
    }));
    repository.listEventsForSubject.mockImplementation(async (query: { artifactHash?: string; limit: number }) => {
      if (query.artifactHash) return current;
      return Array.from({ length: query.limit }, (_, index) => ({
        ...current[0],
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        createdAt: `2026-10-16T12:${String(index).padStart(2, '0')}:00.000Z`,
      }));
    });

    const latest = await listEvaluationEvents('proj-a', { subjectType: 'prd', subjectId });
    expect(repository.listEventsForSubject).toHaveBeenCalledWith(expect.objectContaining({
      artifactHash: 'a'.repeat(64),
      limit: 51,
    }));
    expect(latest.events.map((event) => event.id)).toEqual([
      '00000000-0000-4000-8000-000000000000',
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(latest.truncated).toBe(false);

    const older = await listEvaluationEvents('proj-a', {
      subjectType: 'prd',
      subjectId,
      includeOlderVersions: true,
      stageKey: 'prd_human_review',
    });
    expect(older.truncated).toBe(true);
    expect(older.events).toHaveLength(50);
    expect(repository.listEventsForSubject).toHaveBeenLastCalledWith(expect.objectContaining({
      stageKey: 'prd_human_review',
      artifactHash: undefined,
      limit: 51,
    }));
  });

  it('VT-23 / TBI-007 (d): a listener error does not hide the stored event', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('listener down'));
    const succeeding = jest.fn().mockResolvedValue(undefined);
    registerEventStoredListener(failing);
    registerEventStoredListener(succeeding);

    const event = await submitEvaluation('proj-a', 'user-1', prdRequest());
    expect(event.id).toEqual(expect.any(String));
    expect(failing).toHaveBeenCalledTimes(1);
    expect(succeeding).toHaveBeenCalledTimes(1);
    expect(telemetry.trackEvent).toHaveBeenCalledWith(
      'WorkflowEvaluationSubmitted',
      expect.objectContaining({ listenerFailures: '1' }),
    );
  });

  it('VT-24 / TBI-007 (b): a phase that has not started and an empty PRD store nothing', async () => {
    repository.getActiveDefinition.mockResolvedValue(interviewDefinition);
    resolver.resolveCurrentArtifactBinding.mockRejectedValue(
      new WorkflowEvaluationError('PHASE_NOT_STARTED', 'That interview phase has not started.'),
    );
    await expect(submitEvaluation('proj-a', 'user-1', {
      subjectType: 'interview_phase',
      subjectId,
      stageKey: 'interview_phase_3',
      criteria: scores(4),
      outcome: 'accept_unchanged',
    })).rejects.toMatchObject({ code: 'PHASE_NOT_STARTED' });

    repository.getActiveDefinition.mockResolvedValue(prdDefinition);
    resolver.resolveCurrentArtifactBinding.mockRejectedValue(
      new WorkflowEvaluationError('ARTIFACT_NOT_READY', 'The PRD has no content yet.'),
    );
    await expect(submitEvaluation('proj-a', 'user-1', prdRequest())).rejects.toMatchObject({
      code: 'ARTIFACT_NOT_READY',
    });
    expect(repository.insertEvent).not.toHaveBeenCalled();
  });

  it('VT-25 / TBI-007 (b): a stage that does not match the subject, or has no definition, is rejected', async () => {
    repository.getActiveDefinition.mockResolvedValueOnce(prdDefinition);
    await expect(submitEvaluation('proj-a', 'user-1', {
      subjectType: 'interview_phase',
      subjectId,
      stageKey: 'prd_human_review',
      criteria: scores(4),
      outcome: 'accept_unchanged',
    })).rejects.toMatchObject({ code: 'SUBJECT_STAGE_MISMATCH' });

    repository.getActiveDefinition.mockResolvedValueOnce(null);
    await expect(submitEvaluation('proj-a', 'user-1', prdRequest({
      stageKey: 'missing_stage',
    }))).rejects.toMatchObject({ code: 'UNKNOWN_STAGE' });
    expect(repository.insertEvent).not.toHaveBeenCalled();
  });
});
