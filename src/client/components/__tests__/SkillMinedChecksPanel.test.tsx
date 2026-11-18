import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SkillMinedChecksPanel } from '../SkillMinedChecksPanel';
import { useFeatureFlag } from '../../hooks/useFeatureFlags';
import { useDecideMinedCheck, useMinedChecks } from '../../hooks/useSkillExperiments';

jest.mock('../../hooks/useFeatureFlags', () => ({ useFeatureFlag: jest.fn() }));
jest.mock('../../hooks/useSkillExperiments', () => ({ useMinedChecks: jest.fn(), useDecideMinedCheck: jest.fn() }));

const mutate = jest.fn();

function arrange(enabled = true) {
  jest.mocked(useFeatureFlag).mockReturnValue(enabled);
  jest.mocked(useMinedChecks).mockReturnValue({
    data: [
      { stageKey: 'prd_human_review', heading: 'Rollout plan', support: 4, share: 0.8, corrections: 5, status: 'proposed' },
      { stageKey: 'prd_human_review', heading: 'Risks', support: 3, share: null, corrections: 5, status: 'accepted' },
    ],
    error: null,
  } as never);
  jest.mocked(useDecideMinedCheck).mockReturnValue({ mutate, isPending: false, error: null } as never);
}

describe('SkillMinedChecksPanel', () => {
  beforeEach(() => mutate.mockClear());

  it('renders nothing when skill-learning is off', () => {
    arrange(false);
    const { container } = render(<SkillMinedChecksPanel project="Apex" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists proposals with their support and accepts one', () => {
    arrange();
    render(<SkillMinedChecksPanel project="Apex" />);
    expect(screen.getByTestId('skill-mined-check-prd_human_review-Rollout plan')).toHaveTextContent('4 of 5 (80%)');
    expect(screen.getByTestId('skill-mined-check-prd_human_review-Risks')).toHaveTextContent('In the suite');
    fireEvent.click(screen.getByTestId('skill-mined-check-accept-prd_human_review-Rollout plan'));
    expect(mutate).toHaveBeenCalledWith({ stageKey: 'prd_human_review', heading: 'Rollout plan', support: 4, decision: 'accepted' });
    expect(screen.getByTestId('skill-mined-check-dismiss-prd_human_review-Risks')).toHaveTextContent('Remove');
  });
});
