import { render, screen } from '@testing-library/react';
import { ValidationOverrideAudit } from '../ValidationOverrideAudit';

describe('ValidationOverrideAudit', () => {
  it('renders nothing when override history is empty', () => {
    const { container } = render(
      <ValidationOverrideAudit override={null} legacySummary="legacy" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders newest history entries first with display-name fallback', () => {
    render(
      <ValidationOverrideAudit
        title="Override audit history"
        legacySummary="legacy"
        override={{
          reason: 'Second override',
          userId: 'user-2',
          userDisplayName: 'Ada',
          at: '2026-07-02T12:00:00.000Z',
          history: [
            {
              reason: 'First override',
              userId: 'user-1',
              at: '2026-07-01T12:00:00.000Z',
              summary: 'Overrode readiness state: coverage gaps',
            },
            {
              reason: 'Second override',
              userId: 'user-2',
              userDisplayName: 'Ada',
              at: '2026-07-02T12:00:00.000Z',
              summary: 'Overrode readiness state: validation failed',
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole('region', { name: 'Override audit history' })).toBeInTheDocument();
    const entries = screen.getAllByText(/Reason:/);
    expect(entries[0]).toHaveTextContent('Reason: Second override');
    expect(entries[1]).toHaveTextContent('Reason: First override');
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('user-1')).toBeInTheDocument();
  });
});
