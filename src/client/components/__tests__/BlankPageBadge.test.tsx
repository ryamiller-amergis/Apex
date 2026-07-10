import { render, screen, fireEvent } from '@testing-library/react';
import { BlankPageBadge } from '../BlankPageBadge';

describe('BlankPageBadge', () => {
  it('renders badge when isBlank is true (VT-07)', () => {
    render(<BlankPageBadge isBlank={true} pageIndex={2} />);

    const badge = screen.getByTestId('blank-page-badge-2');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('Likely blank');
  });

  it('does not render badge when isBlank is false (VT-08)', () => {
    render(<BlankPageBadge isBlank={false} pageIndex={2} />);

    expect(screen.queryByTestId('blank-page-badge-2')).not.toBeInTheDocument();
  });

  it('shows tooltip on hover with correct text (VT-09)', async () => {
    render(<BlankPageBadge isBlank={true} pageIndex={3} />);

    const badge = screen.getByTestId('blank-page-badge-3');
    fireEvent.mouseEnter(badge);

    const tooltip = screen.getByTestId('blank-page-tooltip-3');
    expect(tooltip).toBeInTheDocument();
    expect(tooltip).toHaveTextContent(
      'This page appears to be blank. You may want to delete it before export.',
    );
  });

  it('hides tooltip on mouse leave', () => {
    render(<BlankPageBadge isBlank={true} pageIndex={0} />);

    const badge = screen.getByTestId('blank-page-badge-0');
    fireEvent.mouseEnter(badge);
    expect(screen.getByTestId('blank-page-tooltip-0')).toBeInTheDocument();

    fireEvent.mouseLeave(badge);
    expect(screen.queryByTestId('blank-page-tooltip-0')).not.toBeInTheDocument();
  });

  it('shows tooltip on focus for keyboard accessibility (VT-12)', () => {
    render(<BlankPageBadge isBlank={true} pageIndex={5} />);

    const badge = screen.getByTestId('blank-page-badge-5');
    fireEvent.focus(badge);

    const tooltip = screen.getByTestId('blank-page-tooltip-5');
    expect(tooltip).toBeInTheDocument();
    expect(tooltip).toHaveTextContent(
      'This page appears to be blank. You may want to delete it before export.',
    );
  });

  it('hides tooltip on blur', () => {
    render(<BlankPageBadge isBlank={true} pageIndex={1} />);

    const badge = screen.getByTestId('blank-page-badge-1');
    fireEvent.focus(badge);
    expect(screen.getByTestId('blank-page-tooltip-1')).toBeInTheDocument();

    fireEvent.blur(badge);
    expect(screen.queryByTestId('blank-page-tooltip-1')).not.toBeInTheDocument();
  });

  it('has correct aria-label for accessibility (VT-12)', () => {
    render(<BlankPageBadge isBlank={true} pageIndex={4} />);

    const badge = screen.getByTestId('blank-page-badge-4');
    expect(badge).toHaveAttribute('aria-label', 'Likely blank page');
  });

  it('has aria-describedby linking to tooltip when visible', () => {
    render(<BlankPageBadge isBlank={true} pageIndex={6} />);

    const badge = screen.getByTestId('blank-page-badge-6');
    fireEvent.mouseEnter(badge);

    expect(badge).toHaveAttribute('aria-describedby', 'blank-page-tooltip-6');
  });
});
