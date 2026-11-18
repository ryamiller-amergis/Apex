import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SkillSemanticChecksPanel } from '../SkillSemanticChecksPanel';
import { useFeatureFlag } from '../../hooks/useFeatureFlags';
import { useDecideSemanticCheck, useSemanticChecks, useSuggestSemanticChecks } from '../../hooks/useSkillExperiments';

jest.mock('../../hooks/useFeatureFlags', () => ({ useFeatureFlag: jest.fn() }));
jest.mock('../../hooks/useSkillExperiments', () => ({
  useSemanticChecks: jest.fn(),
  useSuggestSemanticChecks: jest.fn(),
  useDecideSemanticCheck: jest.fn(),
  useMinedChecks: jest.fn(),
  useDecideMinedCheck: jest.fn(),
}));

const suggest = jest.fn();
const decide = jest.fn();

function arrange(enabled = true) {
  jest.mocked(useFeatureFlag).mockReturnValue(enabled);
  jest.mocked(useSemanticChecks).mockReturnValue({
    data: {
      checks: [
        { id: 'c1', stageKey: 'prd_human_review', statement: 'Every requirement has a measurable target.', rationale: 'Reviewers kept adding numbers.', support: 4, status: 'proposed', createdAt: '2026-11-09T00:00:00Z' },
        { id: 'c2', stageKey: 'prd_human_review', statement: 'Risks name an owner.', rationale: null, support: 3, status: 'accepted', createdAt: '2026-11-08T00:00:00Z' },
      ],
      latestRuns: [
        { id: 'r1', stageKey: 'prd_human_review', status: 'running', corrections: 12, proposals: null, error: null, createdAt: '2026-11-09T00:00:00Z' },
        { id: 'r2', stageKey: 'test_cases_human_review', status: 'failed', corrections: 5, proposals: null, error: 'The suggestion run failed: timeout', createdAt: '2026-11-09T00:00:00Z' },
      ],
      maxAcceptedPerStage: 5,
      stageKeys: ['prd_human_review', 'design_doc_human_review', 'test_cases_human_review'],
      estimatedCostUsd: 0.3,
    },
    error: null,
  } as never);
  jest.mocked(useSuggestSemanticChecks).mockReturnValue({ mutate: suggest, isPending: false, error: null } as never);
  jest.mocked(useDecideSemanticCheck).mockReturnValue({ mutate: decide, isPending: false, error: null } as never);
}

describe('SkillSemanticChecksPanel', () => {
  beforeEach(() => {
    suggest.mockClear();
    decide.mockClear();
  });

  it('renders nothing when skill-learning is off', () => {
    arrange(false);
    const { container } = render(<SkillSemanticChecksPanel project="Apex" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows each stage with its last suggestion run and blocks a second run while one is going', () => {
    arrange();
    render(<SkillSemanticChecksPanel project="Apex" />);
    expect(screen.getByTestId('skill-semantic-stage-prd_human_review')).toHaveTextContent('Reading 12 corrections');
    expect(screen.getByTestId('skill-semantic-suggest-prd_human_review')).toBeDisabled();
    expect(screen.getByTestId('skill-semantic-stage-test_cases_human_review')).toHaveTextContent('timeout');
    expect(screen.getByTestId('skill-semantic-stage-design_doc_human_review')).toHaveTextContent('Never suggested');
    fireEvent.click(screen.getByTestId('skill-semantic-suggest-design_doc_human_review'));
    expect(suggest).toHaveBeenCalledWith('design_doc_human_review');
  });

  it('accepts a suggestion and offers to remove an accepted one', () => {
    arrange();
    render(<SkillSemanticChecksPanel project="Apex" />);
    expect(screen.getByTestId('skill-semantic-check-c1')).toHaveTextContent('Reviewers kept adding numbers.');
    fireEvent.click(screen.getByTestId('skill-semantic-check-accept-c1'));
    expect(decide).toHaveBeenCalledWith({ id: 'c1', decision: 'accepted' });
    expect(screen.getByTestId('skill-semantic-check-dismiss-c2')).toHaveTextContent('Remove');
  });
});
