import { fireEvent, render, screen } from '@testing-library/react';
import type { PlaybookDryRunIssue } from '../../../shared/types/playbook';
import { PlaybookIssueSummary } from '../PlaybookIssueSummary';

const ISSUES: PlaybookDryRunIssue[] = [
  { nodeId: 'branch-1', kind: 'branch', message: 'Branch step "branch-1" cannot use "approval-1.decision".' },
  { nodeId: 'link', kind: 'graph', message: 'Playbook step "link" has an invalid config.' },
  { nodeId: '', kind: 'graph', message: 'This Playbook contains a loop: x → y → x.' },
  {
    nodeId: 'b',
    kind: 'graph',
    edge: { from: 'b', to: 'ghost' },
    message: 'Connection from "b" to "ghost" references a step that is not on the canvas.',
  },
];

it('renders nothing when the graph has no problems', () => {
  render(<PlaybookIssueSummary issues={[]} onSelectNode={jest.fn()} />);

  expect(screen.queryByTestId('playbook-issue-summary')).not.toBeInTheDocument();
});

it('counts the problems and lists each, including those that belong to the whole graph', () => {
  render(<PlaybookIssueSummary issues={ISSUES} onSelectNode={jest.fn()} />);

  expect(screen.getByTestId('playbook-issue-summary-toggle')).toHaveTextContent(
    '4 problems to fix before publishing',
  );
  fireEvent.click(screen.getByTestId('playbook-issue-summary-toggle'));

  const list = screen.getByTestId('playbook-issue-summary-list');
  expect(list).toHaveTextContent('"approval-1.decision"');
  expect(list).toHaveTextContent('invalid config');
  expect(list).toHaveTextContent('contains a loop');
  expect(list).toHaveTextContent('references a step that is not on the canvas');
});

it('selects the step a problem is on', () => {
  const onSelectNode = jest.fn();
  render(<PlaybookIssueSummary issues={ISSUES} onSelectNode={onSelectNode} />);
  fireEvent.click(screen.getByTestId('playbook-issue-summary-toggle'));

  fireEvent.click(screen.getByTestId('playbook-issue-summary-node-link'));

  expect(onSelectNode).toHaveBeenCalledWith('link');
});
