import { render, screen, fireEvent } from '@testing-library/react';
import { BetaAnnouncementModal } from '../BetaAnnouncementModal';

describe('BetaAnnouncementModal', () => {
  it('renders the production welcome message and data migration copy', () => {
    render(<BetaAnnouncementModal isSuperAdmin={false} onDismiss={jest.fn()} />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Welcome to Apex Production')).toBeInTheDocument();
    expect(screen.getByText(/Your work from beta has been transferred to production/i)).toBeInTheDocument();
    expect(screen.getByText(/Your beta data migrated to production/i)).toBeInTheDocument();
  });

  it('shows a dismiss button for super admins', () => {
    const onDismiss = jest.fn();
    render(<BetaAnnouncementModal isSuperAdmin onDismiss={onDismiss} />);

    const dismissBtn = screen.getByRole('button', { name: /got it, let's go!/i });
    fireEvent.click(dismissBtn);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('link', { name: /go to apex production/i })).not.toBeInTheDocument();
  });

  it('shows a production redirect link for non-super-admins', () => {
    render(<BetaAnnouncementModal isSuperAdmin={false} onDismiss={jest.fn()} />);

    const link = screen.getByRole('link', { name: /go to apex production/i });
    expect(link).toHaveAttribute('href', 'https://apex.amergis.com/');
    expect(screen.queryByRole('button', { name: /got it/i })).not.toBeInTheDocument();
  });
});
