import { render, screen } from '@testing-library/react';
import { DesignModuleScopingUnavailable } from '../DesignModuleScopingUnavailable';

describe('DesignModuleScopingUnavailable', () => {
  it('renders the unavailable status message', () => {
    render(<DesignModuleScopingUnavailable />);

    expect(
      screen.getByTestId('design-module-scoping-unavailable')
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText('AI scoping unavailable')).toBeInTheDocument();
    expect(
      screen.getByText(/no connected repository for AI source scoping/i)
    ).toBeInTheDocument();
  });
});
