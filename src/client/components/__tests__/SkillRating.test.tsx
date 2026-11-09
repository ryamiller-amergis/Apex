import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SkillRating } from '../SkillRating';
import { useWorkflowEvaluationAccess } from '../../hooks/useWorkflowEvaluationAccess';
import { usePutSkillRating, useSkillRatings } from '../../hooks/useSkillRatings';

jest.mock('../../hooks/useWorkflowEvaluationAccess', () => ({ useWorkflowEvaluationAccess: jest.fn() }));
jest.mock('../../hooks/useSkillRatings', () => ({ useSkillRatings: jest.fn(), usePutSkillRating: jest.fn() }));

const mutateAsync = jest.fn().mockResolvedValue({ entry: null });

function arrange(canSubmit: boolean) {
  jest.mocked(useWorkflowEvaluationAccess).mockReturnValue({ canSubmit } as never);
  jest.mocked(useSkillRatings).mockReturnValue(new Map());
  jest.mocked(usePutSkillRating).mockReturnValue({ mutateAsync, isPending: false, isError: false, error: null } as never);
}

describe('SkillRating', () => {
  it('renders nothing without Skill Learning access', () => {
    arrange(false);
    const { container } = render(<SkillRating project="Apex" surface="playbook" subjectType="playbook_run" subjectId="r1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('saves a good rating with its subject and thread', () => {
    arrange(true);
    render(<SkillRating project="Apex" surface="qa_lab" subjectType="assistant_reply" subjectId="m1" threadId="t1" />);
    fireEvent.click(screen.getByTestId('chat-message-rating-good-qa_lab-m1'));
    expect(mutateAsync).toHaveBeenCalledWith({
      subjectType: 'assistant_reply', subjectId: 'm1', threadId: 't1', rating: 'good', comment: null,
    });
  });
});
