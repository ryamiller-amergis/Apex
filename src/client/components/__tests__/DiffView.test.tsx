/**
 * Unit tests for DiffView component.
 *
 * Coverage:
 *  1. Renders added lines with "+" prefix
 *  2. Renders removed lines with "−" prefix
 *  3. Renders context lines with " " prefix
 *  4. changesOnly=true with actual changes filters context lines
 *  5. Shows "No changes" message when texts are identical
 */

import { render, screen } from '@testing-library/react';
import { DiffView } from '../DiffView';

describe('DiffView', () => {
  it('renders added lines with a "+" prefix', () => {
    render(<DiffView oldText="line1" newText="line1&#10;line2" />);
    const plusPrefixes = screen.getAllByText('+');
    expect(plusPrefixes.length).toBeGreaterThan(0);
  });

  it('renders removed lines with a "−" prefix', () => {
    render(<DiffView oldText="line1&#10;line2" newText="line1" />);
    const minusPrefixes = screen.getAllByText('−');
    expect(minusPrefixes.length).toBeGreaterThan(0);
  });

  it('renders context lines', () => {
    // Both texts share a common line, which should appear as context
    render(<DiffView oldText="ctx&#10;old" newText="ctx&#10;new" />);
    // The shared 'ctx' line should be present in the output
    expect(screen.getByText('ctx')).toBeInTheDocument();
  });

  it('shows "No changes in this section" when texts are identical', () => {
    render(<DiffView oldText="same text" newText="same text" />);
    expect(screen.getByText(/no changes in this section/i)).toBeInTheDocument();
  });

  it('shows "No changes in this section" with changesOnly when texts are identical', () => {
    render(<DiffView oldText="same" newText="same" changesOnly />);
    expect(screen.getByText(/no changes in this section/i)).toBeInTheDocument();
  });

  it('with changesOnly, only added/removed lines are rendered (no context rows)', () => {
    // Use enough lines so context would normally appear
    const base = 'ctx1\nctx2\nctx3\nctx4\nctx5\nold line\nctx6\nctx7\nctx8';
    const updated = 'ctx1\nctx2\nctx3\nctx4\nctx5\nnew line\nctx6\nctx7\nctx8';
    render(<DiffView oldText={base} newText={updated} changesOnly />);
    // Should have + and − prefixes
    expect(screen.getAllByText('+')).toBeDefined();
    expect(screen.getAllByText('−')).toBeDefined();
    // Context lines like ctx1 should NOT appear when changesOnly
    expect(screen.queryByText('ctx1')).not.toBeInTheDocument();
  });
});
