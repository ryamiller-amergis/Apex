import {
  ARTIFACT_JUDGE_SKILL_PATH,
  ARTIFACT_RUBRICS,
  applyArtifactJudged,
  artifactJudgeOutputSchema,
  buildArtifactJudgeInput,
  parseArtifactJudgement,
  sweepArtifactJudge,
} from '../services/skillArtifactJudge';
import { db } from '../db/drizzle';
import { isFeatureEnabled, isFeatureOperational } from '../services/featureFlagService';
import { recordSkillSignal } from '../services/skillSignalService';
import { admitSkillLearningRun, SkillLearningRunConflict } from '../services/skillLearningRuns';

jest.mock('../db/drizzle', () => ({ db: { execute: jest.fn() } }));
jest.mock('../services/featureFlagService', () => ({ isFeatureEnabled: jest.fn(), isFeatureOperational: jest.fn() }));
jest.mock('../services/skillSignalService', () => ({ recordSkillSignal: jest.fn() }));
jest.mock('../services/skillLearningRuns', () => {
  class SkillLearningRunConflict extends Error {}
  return {
    admitSkillLearningRun: jest.fn(),
    SkillLearningRunConflict,
    skillLearningThreadId: (task: string, key: string) => `skill-learning:${task}:${key}`,
  };
});

const ADR_RESULT = {
  scores: { context_clarity: 4, options_considered: 2, decision_rationale: 3, consequences: 3 },
  confidence: 'high',
  summary: 'Only one option is discussed.',
};

describe('skillArtifactJudge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(recordSkillSignal).mockResolvedValue(true);
    jest.mocked(admitSkillLearningRun).mockResolvedValue('run-1');
  });

  it('sends the rubric and clipped content to the worker', () => {
    const input = buildArtifactJudgeInput('qa_case_set', 'x'.repeat(40_000));
    expect(input.criteria).toEqual(ARTIFACT_RUBRICS.qa_case_set.criteria);
    expect(input.truncated).toBe(true);
    expect((input.artifact as string).length).toBe(30_000);
  });

  it('requires every criterion as a 1–5 integer in the result schema', () => {
    const schema = artifactJudgeOutputSchema('adr') as { additionalProperties: boolean; properties: { scores: { required: string[] } } };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.scores.required).toEqual(Object.keys(ARTIFACT_RUBRICS.adr.criteria));
  });

  it('parses a full result and averages the scores', () => {
    expect(parseArtifactJudgement('adr', ADR_RESULT)).toEqual({ ...ADR_RESULT, overall: 3 });
  });

  it('rejects a result with a missing or out-of-range score', () => {
    expect(parseArtifactJudgement('adr', { scores: { context_clarity: 4 } })).toBeNull();
    expect(parseArtifactJudgement('adr', { ...ADR_RESULT, scores: { ...ADR_RESULT.scores, consequences: 9 } })).toBeNull();
    expect(parseArtifactJudgement('adr', null)).toBeNull();
  });

  it('records a judged signal with the scores and cost in metadata', async () => {
    await applyArtifactJudged('Apex', { kind: 'adr', subjectId: 'adr-1', threadId: 't-1' }, ADR_RESULT);
    expect(recordSkillSignal).toHaveBeenCalledWith(expect.objectContaining({
      surface: 'adr',
      subjectType: 'adr',
      subjectId: 'adr-1',
      kind: 'judged',
      threadId: 't-1',
      idempotencyKey: 'judged:adr:adr-1',
      metadata: expect.objectContaining({ source: 'sampled_judge', overall: 3, costUsd: expect.any(Number) }),
    }));
  });

  it('skips projects whose budget cannot cover a sweep', async () => {
    jest.mocked(isFeatureOperational).mockResolvedValue(true);
    jest.mocked(isFeatureEnabled).mockResolvedValue(true);
    jest.mocked(db.execute).mockResolvedValueOnce({ rows: [{ project: 'Apex' }] } as never);
    await expect(sweepArtifactJudge({ remainingBudget: async () => 0.5 })).resolves.toBe(0);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(admitSkillLearningRun).not.toHaveBeenCalled();
  });

  it('starts a worker run for each sampled artifact and skips ones already in flight', async () => {
    jest.mocked(isFeatureOperational).mockResolvedValue(true);
    jest.mocked(isFeatureEnabled).mockResolvedValue(true);
    jest.mocked(admitSkillLearningRun)
      .mockResolvedValueOnce('run-1')
      .mockRejectedValueOnce(new SkillLearningRunConflict('run-0'));
    jest.mocked(db.execute)
      .mockResolvedValueOnce({ rows: [{ project: 'Apex' }] } as never)
      .mockResolvedValueOnce({
        rows: [
          { id: 'adr-1', project: 'Apex', content: '# ADR', thread_id: null },
          { id: 'adr-2', project: 'Apex', content: '# ADR', thread_id: null },
        ],
      } as never)
      .mockResolvedValue({ rows: [] } as never);
    await expect(sweepArtifactJudge({ remainingBudget: async () => 100 })).resolves.toBe(1);
    expect(admitSkillLearningRun).toHaveBeenCalledWith(expect.objectContaining({
      project: 'Apex',
      task: 'artifact_judge',
      subjectKey: 'adr:adr-1',
      skillPath: ARTIFACT_JUDGE_SKILL_PATH,
      context: { kind: 'adr', subjectId: 'adr-1', threadId: null },
    }));
  });
});
