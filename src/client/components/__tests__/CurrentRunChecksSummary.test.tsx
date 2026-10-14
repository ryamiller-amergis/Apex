import { render, screen } from '@testing-library/react';
import { CurrentRunChecksSummary } from '../CurrentRunChecksSummary';

describe('CurrentRunChecksSummary', () => {
  it('PBI-006 AC-0: renders nothing when the run has a PR and no failing checks', () => {
    render(
      <CurrentRunChecksSummary
        prUrl="https://dev.azure.com/org/proj/_git/repo/pullrequest/7"
        finishedWithoutPr={false}
        failingChecks={[]}
      />,
    );

    expect(screen.queryByTestId('current-run-checks-summary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('current-run-checks-failing')).not.toBeInTheDocument();
    expect(screen.queryByText(/passed/i)).not.toBeInTheDocument();
  });

  it('PBI-006 AC-1: lists every failing suite in visible text when a PR exists', () => {
    render(
      <CurrentRunChecksSummary
        prUrl="https://dev.azure.com/org/proj/_git/repo/pullrequest/7"
        finishedWithoutPr={false}
        failingChecks={['unit', 'e2e', 'wcag']}
      />,
    );

    const summary = screen.getByTestId('current-run-checks-summary');
    expect(summary).toBeInTheDocument();
    expect(screen.getByTestId('current-run-checks-failing')).toBeInTheDocument();
    expect(screen.getByText('Unit checks failed')).toBeInTheDocument();
    expect(screen.getByText('E2E checks failed')).toBeInTheDocument();
    expect(screen.getByText('WCAG checks failed')).toBeInTheDocument();
    expect(screen.queryByTestId('current-run-checks-no-pr')).not.toBeInTheDocument();
    expect(screen.queryByText(/passed/i)).not.toBeInTheDocument();
  });

  it('PBI-006 AC-1: names only the suites that failed', () => {
    render(
      <CurrentRunChecksSummary
        prUrl="https://dev.azure.com/org/proj/_git/repo/pullrequest/7"
        finishedWithoutPr={false}
        failingChecks={['wcag']}
      />,
    );

    expect(screen.getByText('WCAG checks failed')).toBeInTheDocument();
    expect(screen.queryByText('Unit checks failed')).not.toBeInTheDocument();
    expect(screen.queryByText('E2E checks failed')).not.toBeInTheDocument();
  });

  it('PBI-006 AC-2 / TBI-005 DoD-2: renders the exact no-PR message and no passed-check claim', () => {
    render(
      <CurrentRunChecksSummary
        prUrl={null}
        finishedWithoutPr
        failingChecks={[]}
      />,
    );

    const noPr = screen.getByTestId('current-run-checks-no-pr');
    expect(noPr).toHaveTextContent('Run finished, no PR yet');
    expect(screen.getAllByText('Run finished, no PR yet')).toHaveLength(1);
    expect(screen.queryByText(/passed/i)).not.toBeInTheDocument();
  });

  it('PBI-006 AC-2: suppresses failing checks when the run finished without a PR', () => {
    render(
      <CurrentRunChecksSummary
        prUrl={null}
        finishedWithoutPr
        failingChecks={['unit', 'e2e']}
      />,
    );

    expect(screen.getByTestId('current-run-checks-no-pr')).toBeInTheDocument();
    expect(screen.queryByTestId('current-run-checks-failing')).not.toBeInTheDocument();
    expect(screen.queryByText('Unit checks failed')).not.toBeInTheDocument();
  });

  it('renders nothing for a run that reported no checks and has no PR outcome yet', () => {
    render(
      <CurrentRunChecksSummary
        prUrl={null}
        finishedWithoutPr={false}
        failingChecks={[]}
      />,
    );

    expect(screen.queryByTestId('current-run-checks-summary')).not.toBeInTheDocument();
  });

  it('PBI-006 NFR: exposes failures in an accessible named region and list', () => {
    render(
      <CurrentRunChecksSummary
        prUrl="https://dev.azure.com/org/proj/_git/repo/pullrequest/7"
        finishedWithoutPr={false}
        failingChecks={['unit', 'e2e']}
      />,
    );

    const region = screen.getByRole('region', { name: 'Failed run checks' });
    expect(region).toBe(screen.getByTestId('current-run-checks-summary'));
    const list = screen.getByRole('list', { name: 'Failed run checks' });
    expect(list).toBe(screen.getByTestId('current-run-checks-failing'));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    for (const item of screen.getAllByRole('listitem')) {
      expect(item.textContent?.trim()).not.toHaveLength(0);
    }
  });

  it('PBI-006 NFR: exposes the no-PR outcome in an accessible named region', () => {
    render(
      <CurrentRunChecksSummary
        prUrl={null}
        finishedWithoutPr
        failingChecks={[]}
      />,
    );

    const region = screen.getByRole('region', { name: 'Run outcome' });
    expect(region).toBe(screen.getByTestId('current-run-checks-summary'));
  });
});
