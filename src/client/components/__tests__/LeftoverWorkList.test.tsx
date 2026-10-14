import { render, screen, within } from '@testing-library/react';
import { LeftoverWorkList } from '../LeftoverWorkList';
import type { LeftoverWorkSummary } from '../../../shared/types/devWorkbench';

const SESSION_ID = 'session-42';

const mixedSummary: LeftoverWorkSummary = {
  failingChecks: ['e2e', 'unit'],
  missingPr: true,
  incompleteAcceptanceCriteria: ['Checkout completes without error'],
};

describe('LeftoverWorkList', () => {
  it('renders failing checks, missing PR, and incomplete criteria as text items (PBI-008 AC-0/1, VT-07)', () => {
    render(<LeftoverWorkList sessionId={SESSION_ID} summary={mixedSummary} />);

    const list = screen.getByRole('list', { name: 'Remaining work' });
    expect(list).toHaveAttribute('data-testid', `my-work-leftover-work-${SESSION_ID}`);

    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);

    expect(items[0]).toHaveTextContent('Failing check: e2e');
    expect(items[0]).toHaveAttribute(
      'data-testid',
      `my-work-leftover-work-item-${SESSION_ID}-0`,
    );

    expect(items[1]).toHaveTextContent('Failing check: unit');
    expect(items[1]).toHaveAttribute(
      'data-testid',
      `my-work-leftover-work-item-${SESSION_ID}-1`,
    );

    expect(items[2]).toHaveTextContent('No pull request was opened — no PR yet');
    expect(items[2]).toHaveAttribute(
      'data-testid',
      `my-work-leftover-work-item-${SESSION_ID}-2`,
    );

    expect(items[3]).toHaveTextContent(
      'Incomplete acceptance criterion: Checkout completes without error',
    );
    expect(items[3]).toHaveAttribute(
      'data-testid',
      `my-work-leftover-work-item-${SESSION_ID}-3`,
    );
  });

  it('keeps item indices stable when only one leftover type is present (PBI-008 AC-0)', () => {
    render(
      <LeftoverWorkList
        sessionId={SESSION_ID}
        summary={{
          failingChecks: ['e2e'],
          missingPr: false,
          incompleteAcceptanceCriteria: [],
        }}
      />,
    );

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Failing check: e2e');
    expect(items[0]).toHaveAttribute(
      'data-testid',
      `my-work-leftover-work-item-${SESSION_ID}-0`,
    );
  });

  it('records no PR yet as leftover work (PBI-008 AC-1)', () => {
    render(
      <LeftoverWorkList
        sessionId={SESSION_ID}
        summary={{
          failingChecks: [],
          missingPr: true,
          incompleteAcceptanceCriteria: [],
        }}
      />,
    );

    expect(screen.getByRole('listitem')).toHaveTextContent(
      'No pull request was opened — no PR yet',
    );
  });

  it('renders nothing when leftover work is absent (PBI-008 AC-2, VT-07)', () => {
    const { container: nullContainer } = render(
      <LeftoverWorkList sessionId={SESSION_ID} summary={null} />,
    );
    expect(nullContainer).toBeEmptyDOMElement();
    expect(screen.queryByRole('list', { name: 'Remaining work' })).not.toBeInTheDocument();

    const { container: undefinedContainer } = render(
      <LeftoverWorkList sessionId={SESSION_ID} summary={undefined} />,
    );
    expect(undefinedContainer).toBeEmptyDOMElement();
  });

  it('renders nothing when leftover work is fully clean (PBI-008 AC-2, VT-07)', () => {
    const { container } = render(
      <LeftoverWorkList
        sessionId={SESSION_ID}
        summary={{
          failingChecks: [],
          missingPr: false,
          incompleteAcceptanceCriteria: [],
        }}
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId(`my-work-leftover-work-${SESSION_ID}`)).not.toBeInTheDocument();
  });
});
