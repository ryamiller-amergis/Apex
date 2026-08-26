import { render, screen } from '@testing-library/react';
import { RunGroundingStatus } from '../RunGroundingStatus';

describe('Run grounding status UI', () => {
  it('hides SHA, drift notices, and re-ground controls', () => {
    const { container } = render(
      <RunGroundingStatus surface="prd" domainRunId="prd-1" project="Apex" />
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('run-grounding-status')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-grounding-sha')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('run-grounding-reground-button')
    ).not.toBeInTheDocument();
  });
});
