import {
  affordableCases,
  applyCandidateDrafted,
  cancelSkillExperiment,
  CANDIDATE_DRAFT_ESTIMATE_USD,
  CASE_ESTIMATE_USD,
  normalizeSkillPath,
  ownsReplayThread,
  SkillExperimentError,
  startSkillExperiment,
} from '../services/skillExperimentService';
import { buildApprovalPlaybookGraph } from '../services/skillApprovalPlaybook';
import { db } from '../db/drizzle';
import { isFeatureEnabled } from '../services/featureFlagService';

function chain(result: unknown) {
  const node: Record<string, unknown> = {};
  for (const key of ['from', 'where', 'set', 'orderBy', 'values', 'onConflictDoUpdate']) node[key] = () => node;
  node.limit = async () => result;
  node.returning = async () => result;
  node.then = (resolve: (value: unknown) => unknown) => resolve(result);
  return node;
}

jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
    update: jest.fn(),
    execute: jest.fn(),
    query: { skillExperiments: { findFirst: jest.fn() } },
  },
}));
jest.mock('../services/featureFlagService', () => ({ isFeatureEnabled: jest.fn(), isFeatureOperational: jest.fn() }));
jest.mock('../services/notificationService', () => ({ createNotification: jest.fn() }));
jest.mock('../services/prdService', () => ({ getPrdEvaluationInputs: jest.fn() }));
jest.mock('../services/interviewService', () => ({ getInterviewEvaluationInputs: jest.fn() }));
jest.mock('../services/designDocService', () => ({ getDesignDocEvaluationInputs: jest.fn() }));
jest.mock('../services/playbookRunService', () => ({ startRun: jest.fn() }));
jest.mock('../services/playbookDefinitionService', () => ({ createDefinition: jest.fn(), publishDraft: jest.fn() }));
jest.mock('../services/skillPromotionService', () => ({ openSkillChangePullRequest: jest.fn() }));
jest.mock('../services/aiRunV2/v2AdmissionService', () => ({ createV2AdmissionService: jest.fn() }));

describe('skillExperimentService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('counts the cases a budget pays for, after a draft when drafting', () => {
    expect(affordableCases(CASE_ESTIMATE_USD * 10, false)).toBe(10);
    expect(affordableCases(CASE_ESTIMATE_USD * 10, true)).toBe(9);
    expect(affordableCases(CANDIDATE_DRAFT_ESTIMATE_USD, true)).toBe(0);
    expect(affordableCases(-5, false)).toBe(0);
  });

  it('normalizes Skill paths', () => {
    expect(normalizeSkillPath('  /.cursor/Skills/To-PRD/SKILL.md ')).toBe('.cursor/skills/to-prd/skill.md');
  });

  it('owns only replay thread ids', () => {
    expect(ownsReplayThread('skill-replay:00000000-0000-0000-0000-000000000001:generate')).toBe(true);
    expect(ownsReplayThread('wfeval:event-1:promptfoo')).toBe(false);
  });

  it('builds a notify step followed by an approval gate', () => {
    const graph = buildApprovalPlaybookGraph('prd');
    expect(graph.nodes.map((n) => [n.id, n.stepType])).toEqual([['results', 'notify'], ['approve', 'approval-gate']]);
  });

  it('refuses to start when the flag is off', async () => {
    jest.mocked(isFeatureEnabled).mockResolvedValue(false);
    await expect(startSkillExperiment('Apex', 'u1', { subjectType: 'prd', skillPath: 'a/SKILL.md' }))
      .rejects.toMatchObject({ code: 'flag_off' });
  });

  it('refuses to start until a budget is set', async () => {
    jest.mocked(isFeatureEnabled).mockResolvedValue(true);
    jest.mocked(db.select).mockReturnValueOnce(chain([]) as never).mockReturnValue(chain([{ total: '0' }]) as never);
    jest.mocked(db.execute).mockResolvedValue({ rows: [{ total: '0' }] } as never);
    const attempt = startSkillExperiment('Apex', 'u1', { subjectType: 'prd', skillPath: 'a/SKILL.md' });
    await expect(attempt).rejects.toBeInstanceOf(SkillExperimentError);
    await expect(attempt).rejects.toMatchObject({ code: 'budget_off' });
  });

  it('cancels only drafting or running experiments', async () => {
    jest.mocked(db.update).mockReturnValue(chain([]) as never);
    await expect(cancelSkillExperiment('Apex', 'exp-1')).rejects.toMatchObject({ code: 'invalid_state' });
  });

  describe('when the candidate draft comes back from the worker', () => {
    const BASELINE = `# to-prd\n\n${'Write testable criteria.\n'.repeat(20)}`;
    const drafting = { id: 'exp-1', status: 'drafting', baselineContent: BASELINE, baselineSha256: 'a'.repeat(64) };

    function captureUpdates(): Array<Record<string, unknown>> {
      const sets: Array<Record<string, unknown>> = [];
      jest.mocked(db.update).mockImplementation(() => {
        const node = chain([]) as Record<string, unknown>;
        node.set = (values: Record<string, unknown>) => {
          sets.push(values);
          return node;
        };
        return node as never;
      });
      return sets;
    }

    it('stores the candidate and starts the replays', async () => {
      jest.mocked(db.query.skillExperiments.findFirst)
        .mockResolvedValueOnce(drafting as never)
        .mockResolvedValue(null as never);
      const sets = captureUpdates();
      await applyCandidateDrafted('exp-1', { skillContent: `${BASELINE}Name an owner.\n`, changeNotes: 'Owners.' });
      expect(sets[0]).toEqual(expect.objectContaining({
        status: 'running',
        candidateContent: `${BASELINE}Name an owner.\n`,
        changeNotes: 'Owners.',
        candidateSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }));
    });

    it('fails the experiment when the draft does not pass the checks', async () => {
      jest.mocked(db.query.skillExperiments.findFirst).mockResolvedValue(drafting as never);
      const sets = captureUpdates();
      await applyCandidateDrafted('exp-1', { skillContent: BASELINE, changeNotes: '' });
      expect(sets[0]).toEqual(expect.objectContaining({ status: 'failed', error: 'The draft is the same as the current Skill.' }));
      expect(sets[1]).toEqual(expect.objectContaining({ status: 'skipped' }));
    });

    it('ignores a draft for an experiment that is no longer drafting', async () => {
      jest.mocked(db.query.skillExperiments.findFirst).mockResolvedValue({ ...drafting, status: 'cancelled' } as never);
      const sets = captureUpdates();
      await applyCandidateDrafted('exp-1', { skillContent: `${BASELINE}x`, changeNotes: '' });
      expect(sets).toEqual([]);
    });
  });
});
