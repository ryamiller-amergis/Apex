/**
 * FEAT-006 S7 — BuildRiskDecisions labels, empty state and the high-rating rule.
 */
import { render, screen } from '@testing-library/react';
import { BuildRiskDecisions } from '../BuildRiskDecisions';
import type { BuildRiskDecision } from '../../../shared/types/build';

function renderDecisions(decisions: BuildRiskDecision[]) {
  return render(<BuildRiskDecisions decisions={decisions} isLoading={false} isError={false} onRetry={jest.fn()} />);
}

describe('BuildRiskDecisions', () => {
  it('VT-32 shows ID, category, "Rating: Medium", the decision and its rationale (PBI-013 a)', () => {
    renderDecisions([
      { id: 'RD-1', category: 'access', rating: 'medium', decision: 'Add a leave:approve permission', rationale: 'Only managers approve leave' },
    ]);

    const item = screen.getByTestId('build-risk-decision-RD-1');
    expect(item).toHaveTextContent('RD-1');
    expect(item).toHaveTextContent('Access');
    expect(screen.getByTestId('build-risk-decision-rating-RD-1')).toHaveTextContent('Rating: Medium');
    expect(item).toHaveTextContent('Add a leave:approve permission');
    expect(item).toHaveTextContent('Only managers approve leave');
    expect(screen.getByRole('list', { name: 'Risk decisions' })).toBeInTheDocument();
  });

  it('VT-34 states that no material decisions were made (PBI-013 c)', () => {
    renderDecisions([]);
    expect(screen.getByTestId('build-risk-decisions-empty')).toHaveTextContent(
      'No material decisions were made for this build.',
    );
  });

  it('VT-35 labels a high rating in text and shows the reversible option (PBI-013 d)', () => {
    renderDecisions([
      {
        id: 'RD-2',
        category: 'destructive',
        rating: 'high',
        decision: 'Make no destructive data operation. Keep the data and mark it inactive.',
        rationale: 'Removing old leave records loses history. Agent proposed: drop the table',
        reversible: true,
      },
    ]);

    expect(screen.getByTestId('build-risk-decision-rating-RD-2')).toHaveTextContent('Rating: High');
    const decision = screen.getByText('Make no destructive data operation. Keep the data and mark it inactive.');
    expect(decision.textContent).not.toMatch(/\b(drop|delete|truncate)\b/i);
  });

  it('shows the loading text', () => {
    render(<BuildRiskDecisions decisions={undefined} isLoading isError={false} onRetry={jest.fn()} />);
    expect(screen.getByText('Loading risk decisions…')).toBeInTheDocument();
  });
});
