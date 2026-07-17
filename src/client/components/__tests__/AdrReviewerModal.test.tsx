import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AdrReviewerModal } from '../AdrReviewerModal';

jest.mock('../../hooks/useAdrs', () => ({
  useAdrReviewerCandidates: () => ({
    data: [
      { id: 'dev-1', displayName: 'Dev One', email: 'one@example.com' },
      { id: 'dev-2', displayName: 'Dev Two', email: 'two@example.com' },
    ],
    isLoading: false,
    error: null,
  }),
}));

describe('AdrReviewerModal', () => {
  it('selects all Developer reviewers and confirms their IDs', () => {
    const onConfirm = jest.fn();
    render(
      <AdrReviewerModal
        project="Apex"
        ownerName="ADR Owner"
        onConfirm={onConfirm}
        onCancel={jest.fn()}
      />,
    );

    expect(screen.getByText('ADR Owner')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & Start ADR' }));

    expect(onConfirm).toHaveBeenCalledWith(['dev-1', 'dev-2']);
  });

  it('preselects current reviewers and allows removing all reviewers in edit mode', () => {
    const onConfirm = jest.fn();
    render(
      <AdrReviewerModal
        project="Apex"
        ownerName="ADR Owner"
        initialReviewerIds={['dev-1']}
        mode="edit"
        onConfirm={onConfirm}
        onCancel={jest.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Manage ADR Reviewers' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dev One' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Dev One' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Reviewers' }));

    expect(onConfirm).toHaveBeenCalledWith([]);
  });

  it('drops an existing reviewer who is no longer an eligible Developer candidate', async () => {
    const onConfirm = jest.fn();
    render(
      <AdrReviewerModal
        project="Apex"
        ownerName="ADR Owner"
        initialReviewerIds={['owner-id']}
        mode="edit"
        onConfirm={onConfirm}
        onCancel={jest.fn()}
      />,
    );

    await waitFor(() => expect(screen.queryByText('1 reviewer selected')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Save Reviewers' }));

    expect(onConfirm).toHaveBeenCalledWith([]);
  });
});
