/**
 * Tests for the BacklogViewer summary bar — Test Cases count (issue #4).
 *
 * The summary bar shows Epic / Feature / TBI / PBI counts; it must also show a
 * "Test Cases" item computed from the generated test-case suites.
 */

import { render, screen } from '@testing-library/react';
import { BacklogViewer } from '../BacklogViewer';

const sampleBacklog = {
  epics: [
    {
      title: 'Epic Alpha',
      priority: 'Must Have',
      features: [
        {
          title: 'Feature One',
          priority: 'Should Have',
          items: [
            { type: 'PBI' as const, id: 'PBI-001', title: 'Item A', priority: 'Must Have' },
          ],
        },
      ],
    },
  ],
};

const testCasesJson = {
  suites: [
    {
      pbiId: 'PBI-001',
      testCases: [
        { id: 'PBI-001-TC-1', title: 'Login succeeds' },
        { id: 'PBI-001-TC-2', title: 'Login fails' },
        { id: 'PBI-001-TC-3', title: 'Lockout after retries' },
      ],
    },
  ],
};

describe('BacklogViewer summary bar — Test Cases count', () => {
  it('renders a "Test Cases" summary item with the total generated case count', () => {
    render(<BacklogViewer data={sampleBacklog} testCasesJson={testCasesJson} />);

    expect(screen.getByText('Test Cases')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows zero when there are no generated test cases', () => {
    render(<BacklogViewer data={sampleBacklog} />);

    const label = screen.getByText('Test Cases');
    const item = label.parentElement as HTMLElement;
    expect(item).toHaveTextContent('0');
  });
});
