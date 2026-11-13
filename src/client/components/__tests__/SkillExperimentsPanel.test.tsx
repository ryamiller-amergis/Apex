import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SkillExperimentsPanel, scoreChange } from '../SkillExperimentsPanel';
import { useFeatureFlag } from '../../hooks/useFeatureFlags';
import * as hooks from '../../hooks/useSkillExperiments';
import type { SkillExperimentSummary } from '../../../shared/types/skillExperiment';

jest.mock('../../hooks/useFeatureFlags', () => ({ useFeatureFlag: jest.fn() }));
jest.mock('../../hooks/useSkillExperiments', () => ({
  useSkillExperiments: jest.fn(),
  useSkillExperiment: jest.fn(),
  useSkillLearningSettings: jest.fn(),
  useReplayableSkills: jest.fn(),
  useSetSkillLearningBudget: jest.fn(),
  useStartSkillExperiment: jest.fn(),
  useSkillExperimentAction: jest.fn(),
  useCandidateFrontier: jest.fn(),
}));

const mocked = hooks as jest.Mocked<typeof hooks>;
const mutation = () => ({ mutate: jest.fn(), isPending: false, error: null }) as never;

const SPLIT = { pairs: 12, baselineMean: 3.1, candidateMean: 3.5, meanDiff: 0.4, diffInterval: { low: 0.1, high: 0.7 }, wins: 8, losses: 2, ties: 2 };

const EXPERIMENT: SkillExperimentSummary = {
  id: 'exp-1',
  project: 'Apex',
  subjectType: 'prd',
  skillPath: '.cursor/skills/to-prd/SKILL.md',
  baselineSha256: 'a'.repeat(64),
  candidateSha256: 'b'.repeat(64),
  error: null,
  candidateSource: 'reflective',
  changeNotes: 'Tighter acceptance criteria',
  status: 'approved',
  cases: 15,
  runsScored: 30,
  runsFailed: 0,
  estimatedCostUsd: 27,
  spentUsd: 26.5,
  result: {
    dev: SPLIT,
    holdout: { ...SPLIT, pairs: 3 },
    criteria: [],
    baselineFailureRate: 0,
    candidateFailureRate: 0,
    verdict: 'promote',
    reasons: ['Dev cases improved'],
  },
  pullRequestUrl: null,
  createdBy: 'user-1',
  createdAt: '2026-11-09T10:00:00Z',
  updatedAt: '2026-11-09T11:00:00Z',
};

function arrange(enabled = true) {
  jest.mocked(useFeatureFlag).mockReturnValue(enabled);
  mocked.useSkillExperiments.mockReturnValue({ data: [EXPERIMENT], error: null } as never);
  mocked.useSkillExperiment.mockReturnValue({ data: undefined, isLoading: true, error: null } as never);
  mocked.useSkillLearningSettings.mockReturnValue({
    data: { project: 'Apex', monthlyBudgetUsd: 100, spentThisMonthUsd: 26.5, updatedBy: null, updatedAt: null },
  } as never);
  mocked.useReplayableSkills.mockReturnValue({
    data: [{ subjectType: 'prd', skillPath: '.cursor/skills/to-prd/SKILL.md', runs: 40, lastRunAt: '2026-11-08' }],
  } as never);
  mocked.useCandidateFrontier.mockReturnValue({
    data: [{
      experimentId: 'exp-0', candidateSha256: 'c'.repeat(64), candidateSource: 'manual', candidateContent: '# better',
      changeNotes: 'Shorter steps', verdict: 'keep_current', devMeanDiff: 0.1, criteria: [], candidateFailureRate: 0,
      createdAt: '2026-11-01',
    }],
  } as never);
  mocked.useSetSkillLearningBudget.mockReturnValue(mutation());
  mocked.useStartSkillExperiment.mockReturnValue(mutation());
  const action = mutation();
  mocked.useSkillExperimentAction.mockReturnValue(action);
  return { action: action as unknown as { mutate: jest.Mock } };
}

describe('SkillExperimentsPanel', () => {
  it('renders nothing when skill-learning is off', () => {
    arrange(false);
    const { container } = render(<SkillExperimentsPanel project="Apex" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows budget use, the result columns and a retry for an approved experiment without a pull request', () => {
    const { action } = arrange();
    render(<SkillExperimentsPanel project="Apex" />);

    expect(screen.getByTestId('skill-experiments-budget-spent')).toHaveTextContent('$26.50 of $100.00 used this month');
    const row = screen.getByTestId('skill-experiment-row-exp-1');
    expect(row).toHaveTextContent('to-prd');
    expect(row).toHaveTextContent('Approved');
    expect(row).toHaveTextContent('+0.40 (+0.10 to +0.70)');

    fireEvent.click(screen.getByTestId('skill-experiment-retry-exp-1'));
    expect(action.mutate).toHaveBeenCalledWith({ id: 'exp-1', action: 'retry-promotion' });
  });

  it('fills the form from a best candidate so far', () => {
    arrange();
    render(<SkillExperimentsPanel project="Apex" />);
    fireEvent.click(screen.getByTestId('skill-experiments-frontier-use'));
    expect(screen.getByTestId('skill-experiments-candidate')).toHaveValue('# better');
    expect(screen.getByTestId('skill-experiments-notes')).toHaveValue('Shorter steps');
  });

  it('formats a score change without a range', () => {
    expect(scoreChange({ ...SPLIT, meanDiff: -0.25, diffInterval: null })).toBe('-0.25');
    expect(scoreChange({ ...SPLIT, meanDiff: null })).toBe('—');
  });
});
