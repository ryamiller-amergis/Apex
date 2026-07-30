/**
 * Tests for ChangeReviewWizard — step navigation, decisions, regenerate, Finish.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChangeReviewWizard } from '../ChangeReviewWizard';
import type { ChangeUnit } from '../../utils/changeReview';

jest.mock('../DiffView', () => ({
  DiffView: ({ oldText, newText }: { oldText: string; newText: string }) => (
    <div data-testid="diff-view" data-old={oldText} data-new={newText} />
  ),
}));

jest.mock('../ChangeReviewWizard.module.css', () => new Proxy({}, { get: (_t, k) => String(k) }));

function makeUnit(partial: Partial<ChangeUnit> & { id: string }): ChangeUnit {
  return {
    title: partial.title ?? partial.id,
    kind: partial.kind ?? 'markdown-hunk',
    oldText: partial.oldText ?? 'old',
    newText: partial.newText ?? 'new',
    meta: partial.meta ?? {
      hunk: {
        id: partial.id.replace('content:', ''),
        oldStart: 0,
        oldCount: 1,
        newStart: 0,
        newCount: 1,
        oldText: 'old',
        newText: 'new',
      },
    },
    decision: partial.decision ?? 'pending',
    ...partial,
  };
}

describe('ChangeReviewWizard', () => {
  const units: ChangeUnit[] = [
    makeUnit({ id: 'content:h1', title: 'Change 1', oldText: 'a', newText: 'A' }),
    makeUnit({ id: 'content:h2', title: 'Change 2', oldText: 'b', newText: 'B' }),
  ];

  it('shows progress for the first change', () => {
    render(
      <ChangeReviewWizard
        units={units}
        onDecision={jest.fn()}
        onRequestRegenerate={jest.fn()}
        onFinish={jest.fn()}
      />,
    );
    expect(screen.getByText(/Change 1 of 2/i)).toBeInTheDocument();
    expect(screen.getByText('Change 1')).toBeInTheDocument();
  });

  it('calls onDecision with approved and advances', () => {
    const onDecision = jest.fn();
    render(
      <ChangeReviewWizard
        units={units}
        onDecision={onDecision}
        onRequestRegenerate={jest.fn()}
        onFinish={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Approve$/i }));
    expect(onDecision).toHaveBeenCalledWith('content:h1', 'approved');
    expect(screen.getByText(/Change 2 of 2/i)).toBeInTheDocument();
  });

  it('calls onDecision with rejected', () => {
    const onDecision = jest.fn();
    render(
      <ChangeReviewWizard
        units={units}
        onDecision={onDecision}
        onRequestRegenerate={jest.fn()}
        onFinish={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Reject$/i }));
    expect(onDecision).toHaveBeenCalledWith('content:h1', 'rejected');
  });

  it('submits regenerate feedback via onRequestRegenerate', async () => {
    const onRequestRegenerate = jest.fn().mockResolvedValue(undefined);
    render(
      <ChangeReviewWizard
        units={units}
        onDecision={jest.fn()}
        onRequestRegenerate={onRequestRegenerate}
        onFinish={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Ask AI to change/i }));
    fireEvent.change(screen.getByLabelText(/Tell the AI what you want instead/i), {
      target: { value: 'Use a different label' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Regenerate this change/i }));
    await waitFor(() => {
      expect(onRequestRegenerate).toHaveBeenCalledWith('content:h1', 'Use a different label');
    });
  });

  it('reaches summary and calls onFinish', async () => {
    const onFinish = jest.fn().mockResolvedValue(undefined);
    const decided = units.map((u) => ({ ...u, decision: 'approved' as const }));
    render(
      <ChangeReviewWizard
        units={decided}
        onDecision={jest.fn()}
        onRequestRegenerate={jest.fn()}
        onFinish={onFinish}
      />,
    );
    // Skip both steps to summary
    fireEvent.click(screen.getByRole('button', { name: /Skip \/ Next/i }));
    fireEvent.click(screen.getByRole('button', { name: /Summary/i }));
    expect(screen.getByText(/Review summary/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Finish$/i }));
    await waitFor(() => {
      expect(onFinish).toHaveBeenCalled();
    });
  });
});
