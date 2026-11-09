import {
  CHECK_MINING_OUTPUT_SCHEMA,
  SkillSemanticCheckError,
  acceptableProposals,
  parseCheckMiningContext,
  semanticTest,
  startCheckMining,
} from '../services/skillSemanticChecks';
import { isFeatureEnabled } from '../services/featureFlagService';
import { loadStageCorrections } from '../services/skillCorrections';
import { isJudgeOutputSchema } from '../../shared/types/aiRunV2EvaluationSpec';

jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/featureFlagService', () => ({ isFeatureEnabled: jest.fn() }));
jest.mock('../services/skillLearningRuns', () => ({ admitSkillLearningRun: jest.fn() }));
jest.mock('../services/skillCorrections', () => ({
  ...jest.requireActual('../services/skillCorrections'),
  loadStageCorrections: jest.fn(),
}));

const EVENTS = ['e1', 'e2', 'e3', 'e4'];

function check(statement: string, ids: string[]) {
  return { statement, rationale: 'Reviewers kept fixing this.', supportingEventIds: ids };
}

describe('skillSemanticChecks', () => {
  beforeEach(() => jest.clearAllMocks());

  it('keeps a suggestion only when at least three distinct sent corrections back it', () => {
    const result = {
      checks: [
        check('Every requirement states a measurable target.', ['e1', 'e2', 'e3']),
        check('Every risk names an owner and a date.', ['e1', 'e1', 'e2', 'made-up']),
      ],
    };
    expect(acceptableProposals(result, EVENTS, [])).toEqual([
      expect.objectContaining({ statement: 'Every requirement states a measurable target.', support: 3 }),
    ]);
  });

  it('drops repeats of existing checks, whatever the case or spacing', () => {
    const result = { checks: [check('Every  requirement states a MEASURABLE target.', EVENTS)] };
    expect(acceptableProposals(result, EVENTS, ['every requirement states a measurable target.'])).toEqual([]);
  });

  it('drops statements that are too short and results that are not a check list', () => {
    expect(acceptableProposals({ checks: [check('Short', EVENTS)] }, EVENTS, [])).toEqual([]);
    expect(acceptableProposals({ nope: true }, EVENTS, [])).toEqual([]);
    expect(acceptableProposals(null, EVENTS, [])).toEqual([]);
  });

  it('turns an accepted statement into an llm-rubric test on the artifact', () => {
    expect(semanticTest('Risks name an owner.')).toEqual({
      description: 'Meets: "Risks name an owner." (learned from reviewer corrections)',
      target: 'artifact',
      assert: [{ type: 'llm-rubric', value: 'Risks name an owner.' }],
    });
  });

  it('reads the run context and rejects malformed ones', () => {
    expect(parseCheckMiningContext({ miningRunId: 'm1', eventIds: ['e1', 3] })).toEqual({ miningRunId: 'm1', eventIds: ['e1'] });
    expect(parseCheckMiningContext({ eventIds: [] })).toBeNull();
    expect(parseCheckMiningContext(null)).toBeNull();
  });

  it('uses a closed output schema the worker accepts', () => {
    expect(isJudgeOutputSchema(CHECK_MINING_OUTPUT_SCHEMA)).toBe(true);
  });

  describe('startCheckMining', () => {
    const deps = (remaining: number | null) => ({ remainingBudget: jest.fn().mockResolvedValue(remaining) });

    it('rejects a stage that has no corrections to read', async () => {
      await expect(startCheckMining('Apex', 'u1', 'adr_human_review', deps(10))).rejects.toMatchObject({ code: 'invalid_stage' });
    });

    it('needs the flag and a budget with room for the run', async () => {
      jest.mocked(isFeatureEnabled).mockResolvedValue(false);
      await expect(startCheckMining('Apex', 'u1', 'prd_human_review', deps(10))).rejects.toMatchObject({ code: 'flag_off' });
      jest.mocked(isFeatureEnabled).mockResolvedValue(true);
      await expect(startCheckMining('Apex', 'u1', 'prd_human_review', deps(null))).rejects.toMatchObject({ code: 'budget_off' });
      await expect(startCheckMining('Apex', 'u1', 'prd_human_review', deps(0.1))).rejects.toMatchObject({ code: 'budget_exceeded' });
    });

    it('needs at least three corrections that changed something', async () => {
      jest.mocked(isFeatureEnabled).mockResolvedValue(true);
      jest.mocked(loadStageCorrections).mockResolvedValue([
        { eventId: 'e1', original: 'same', corrected: 'same' },
        { eventId: 'e2', original: 'a', corrected: 'b' },
        { eventId: 'e3', original: null, corrected: '## Risks' },
      ]);
      const error = await startCheckMining('Apex', 'u1', 'prd_human_review', deps(10)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SkillSemanticCheckError);
      expect(error).toMatchObject({ code: 'not_enough_corrections' });
    });
  });
});
