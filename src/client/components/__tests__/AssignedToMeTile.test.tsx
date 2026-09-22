import { render, screen } from '@testing-library/react';
import { AssignedToMeTile } from '../AssignedToMeTile';

describe('AssignedToMeTile', () => {
  it('renders visible urgency, accurate capped total, and keyboard links', () => {
    render(<AssignedToMeTile onRetry={jest.fn()} result={{
      status: 'ok',
      data: {
        total: 7,
        soonestDeadline: '2026-09-22T18:00:00.000Z',
        viewAllHref: '/playbooks?filter=assigned-to-me',
        items: [{
          id: 'gate-1',
          source: 'playbook-gates',
          title: 'Release approval',
          deadline: '2026-09-22T18:00:00.000Z',
          href: '/playbooks?filter=assigned-to-me&run=run-1',
          urgencyText: 'Due in 2 hours',
        }],
      },
    }} />);

    expect(screen.getAllByText('Due in 2 hours')).toHaveLength(2);
    expect(screen.getByText(/Showing 1 of 7/)).toHaveAttribute(
      'href',
      '/playbooks?filter=assigned-to-me',
    );
    expect(screen.getByRole('link', { name: /Release approval/ })).toHaveAttribute(
      'href',
      '/playbooks?filter=assigned-to-me&run=run-1',
    );
  });

  it('renders its own empty and error states', () => {
    const { rerender } = render(<AssignedToMeTile onRetry={jest.fn()} result={{
      status: 'empty',
      data: { total: 0, items: [], soonestDeadline: null, viewAllHref: '/playbooks?filter=assigned-to-me' },
    }} />);
    expect(screen.getByTestId('assigned-to-me-empty')).toBeInTheDocument();

    rerender(<AssignedToMeTile onRetry={jest.fn()} result={{
      status: 'error',
      data: null,
      message: 'Timed out loading assigned gates.',
    }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Timed out');
  });
});
