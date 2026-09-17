import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PhaseOwnerChip } from '../PhaseOwnerChip';

const users = [
  { oid: 'user-ba', displayName: 'Business Analyst', email: 'ba@example.com' },
  { oid: 'user-dev', displayName: 'Developer One', email: 'dev@example.com' },
];

describe('PhaseOwnerChip', () => {
  it('PBI-001 AC-0 / VT-10 Given a configured phase owner, Then its accessible chip shows the phase and owner', () => {
    render(
      <PhaseOwnerChip
        phase="requirements"
        ownerId="user-ba"
        ownerName="Business Analyst"
        status="draft"
        canChange={false}
        users={users}
        onSave={jest.fn()}
      />,
    );

    expect(screen.getByTestId('interview-owner-chip-requirements')).toHaveTextContent(
      'Requirements: Business Analyst',
    );
    expect(screen.queryByRole('button', { name: /change requirements owner/i })).not.toBeInTheDocument();
  });

  it('PBI-002 AC-0 Given an author can manage a draft phase, When reassigned, Then the selected owner is saved', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(
      <PhaseOwnerChip
        phase="requirements"
        ownerId="user-ba"
        ownerName="Business Analyst"
        status="draft"
        canChange
        users={users}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByTestId('phase-owner-change-btn-requirements'));
    const select = screen.getByTestId('phase-owner-reassign-select-requirements');
    expect(select).toHaveAccessibleName('Requirements owner');
    fireEvent.change(select, { target: { value: 'user-dev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Requirements owner' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('user-dev'));
  });

  it('PBI-002 AC-1 Given an approved phase, Then it is locked and cannot be changed', () => {
    render(
      <PhaseOwnerChip
        phase="requirements"
        ownerId="user-ba"
        ownerName="Business Analyst"
        status="approved"
        canChange
        users={users}
        onSave={jest.fn()}
      />,
    );

    expect(screen.getByTestId('interview-owner-chip-requirements')).toHaveTextContent(/approved/i);
    expect(screen.getByLabelText('Requirements phase approved and locked')).toBeInTheDocument();
    expect(screen.queryByTestId('phase-owner-change-btn-requirements')).not.toBeInTheDocument();
  });

  it('PBI-002 AC-1 Given stale approval, When save returns 409, Then exact server text is shown inline', async () => {
    const message = 'This phase has already been approved and its owner cannot be changed.';
    render(
      <PhaseOwnerChip
        phase="technical"
        ownerId="user-dev"
        ownerName="Developer One"
        status="draft"
        canChange
        users={users}
        onSave={jest.fn().mockRejectedValue(new Error(message))}
      />,
    );

    fireEvent.click(screen.getByTestId('phase-owner-change-btn-technical'));
    fireEvent.change(screen.getByTestId('phase-owner-reassign-select-technical'), {
      target: { value: 'user-ba' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Technical owner' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('PBI-002 AC-2 Given a Technical-only draft, When reassigned, Then the selected owner is saved', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(
      <PhaseOwnerChip
        phase="technical"
        ownerId="user-dev"
        ownerName="Developer One"
        status="draft"
        canChange
        users={users}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByTestId('phase-owner-change-btn-technical'));
    fireEvent.change(screen.getByTestId('phase-owner-reassign-select-technical'), {
      target: { value: 'user-ba' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Technical owner' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('user-ba'));
  });

  it('PBI-002 AC-3 Given a noncreator without admin access, Then the reassignment button is hidden', () => {
    render(
      <PhaseOwnerChip
        phase="technical"
        ownerId="user-dev"
        ownerName="Developer One"
        status="draft"
        canChange={false}
        users={users}
        onSave={jest.fn()}
      />,
    );

    expect(screen.getByTestId('interview-owner-chip-technical')).toBeInTheDocument();
    expect(screen.queryByTestId('phase-owner-change-btn-technical')).not.toBeInTheDocument();
  });
});
