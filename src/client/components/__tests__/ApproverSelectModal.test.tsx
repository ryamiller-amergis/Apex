import { render, screen, fireEvent } from '@testing-library/react';
import { ApproverSelectModal } from '../ApproverSelectModal';

jest.mock('../../hooks/useInterviews', () => ({
  ...jest.requireActual('../../hooks/useInterviews'),
  useAvailableApproverPool: jest.fn(),
}));

import { useAvailableApproverPool } from '../../hooks/useInterviews';

const mockPool = {
  individuals: [
    { userId: 'u1', displayName: 'Alice', email: 'alice@test.com', documentType: 'prd' as const },
    { userId: 'u2', displayName: 'Bob', email: 'bob@test.com', documentType: 'prd' as const },
    { userId: 'u3', displayName: 'Charlie', email: 'charlie@test.com', documentType: 'prd' as const },
  ],
  groups: [],
};

function setupDefaultMocks(overrides?: {
  prd?: { data?: typeof mockPool; isLoading?: boolean };
  dd?: { data?: typeof mockPool; isLoading?: boolean };
}) {
  (useAvailableApproverPool as jest.Mock).mockImplementation(
    (_project: string, docType: 'prd' | 'design_doc') => {
      if (docType === 'prd') {
        return {
          data: overrides?.prd?.data ?? mockPool,
          isLoading: overrides?.prd?.isLoading ?? false,
        };
      }
      return {
        data: overrides?.dd?.data ?? mockPool,
        isLoading: overrides?.dd?.isLoading ?? false,
      };
    },
  );
}

const baseProps = {
  project: 'test-project',
  onConfirm: jest.fn(),
  onCancel: jest.fn(),
};

// ── Rendering ───────────────────────────────────────────────────────────────────

describe('ApproverSelectModal — rendering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  it('renders PRD and Design Doc sections when documentType is prd', () => {
    render(<ApproverSelectModal {...baseProps} documentType="prd" />);

    expect(screen.getByText('PRD Reviewers')).toBeInTheDocument();
    expect(screen.getByText('Design Doc Reviewers')).toBeInTheDocument();
  });

  it('renders only Design Doc section when documentType is design_doc', () => {
    render(<ApproverSelectModal {...baseProps} documentType="design_doc" />);

    expect(screen.getByText('Design Doc Reviewers')).toBeInTheDocument();
    expect(screen.queryByText('PRD Reviewers')).not.toBeInTheDocument();
  });

  it('shows loading state while approvers are loading', () => {
    setupDefaultMocks({ prd: { isLoading: true }, dd: { isLoading: true } });

    render(<ApproverSelectModal {...baseProps} documentType="prd" />);

    const loadingTexts = screen.getAllByText(/loading approvers/i);
    expect(loadingTexts.length).toBeGreaterThanOrEqual(1);
  });

  it('shows empty message when no approvers configured', () => {
    const emptyPool = { individuals: [], groups: [] };
    setupDefaultMocks({ prd: { data: emptyPool }, dd: { data: emptyPool } });

    render(<ApproverSelectModal {...baseProps} documentType="prd" />);

    const emptyTexts = screen.getAllByText(/no approvers configured/i);
    expect(emptyTexts.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Selection behavior ──────────────────────────────────────────────────────────

describe('ApproverSelectModal — selection behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  it('toggles approver selection on chip click', () => {
    render(<ApproverSelectModal {...baseProps} documentType="design_doc" />);

    const chip = screen.getByRole('button', { name: 'Alice' });
    fireEvent.click(chip);

    expect(chip.className).toMatch(/selected/i);

    fireEvent.click(chip);
    expect(chip.className).not.toMatch(/selected/i);
  });

  it('disables confirm button until at least one approver selected per section', () => {
    render(<ApproverSelectModal {...baseProps} documentType="prd" />);

    const confirmBtn = screen.getByRole('button', { name: /submit for review/i });
    expect(confirmBtn).toBeDisabled();
  });

  it('enables confirm button when requirements met', () => {
    render(<ApproverSelectModal {...baseProps} documentType="prd" />);

    const sections = screen.getAllByText('Individuals');
    const prdSection = sections[0].closest('div')!.parentElement!;
    const prdChip = Array.from(prdSection.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Alice'),
    )!;
    fireEvent.click(prdChip);

    const ddSection = sections[1].closest('div')!.parentElement!;
    const ddChip = Array.from(ddSection.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Bob'),
    )!;
    fireEvent.click(ddChip);

    const confirmBtn = screen.getByRole('button', { name: /submit for review/i });
    expect(confirmBtn).toBeEnabled();
  });
});

// ── Callbacks ───────────────────────────────────────────────────────────────────

describe('ApproverSelectModal — callbacks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  it('calls onConfirm with prdApproverIds and designDocApproverIds for PRD type', () => {
    const onConfirm = jest.fn();
    render(
      <ApproverSelectModal {...baseProps} documentType="prd" onConfirm={onConfirm} />,
    );

    const sections = screen.getAllByText('Individuals');
    const prdSection = sections[0].closest('div')!.parentElement!;
    const prdChip = Array.from(prdSection.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Alice'),
    )!;
    fireEvent.click(prdChip);

    const ddSection = sections[1].closest('div')!.parentElement!;
    const ddChip = Array.from(ddSection.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Bob'),
    )!;
    fireEvent.click(ddChip);

    fireEvent.click(screen.getByRole('button', { name: /submit for review/i }));

    expect(onConfirm).toHaveBeenCalledWith({
      prdApproverIds: ['u1'],
      designDocApproverIds: ['u2'],
    });
  });

  it('calls onConfirm with approverIds for design_doc type', () => {
    const onConfirm = jest.fn();
    render(
      <ApproverSelectModal {...baseProps} documentType="design_doc" onConfirm={onConfirm} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Alice' }));

    fireEvent.click(screen.getByRole('button', { name: /submit for review/i }));

    expect(onConfirm).toHaveBeenCalledWith({ approverIds: ['u1'] });
  });

  it('calls onCancel when cancel button clicked', () => {
    const onCancel = jest.fn();
    render(
      <ApproverSelectModal {...baseProps} documentType="design_doc" onCancel={onCancel} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel on Escape key press', () => {
    const onCancel = jest.fn();
    render(
      <ApproverSelectModal {...baseProps} documentType="design_doc" onCancel={onCancel} />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when overlay clicked', () => {
    const onCancel = jest.fn();
    render(
      <ApproverSelectModal {...baseProps} documentType="design_doc" onCancel={onCancel} />,
    );

    const overlay = screen.getByRole('dialog');
    fireEvent.click(overlay);

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// ── Submitting state ────────────────────────────────────────────────────────────

describe('ApproverSelectModal — submitting state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  it('disables all chips and buttons when isSubmitting is true', () => {
    render(
      <ApproverSelectModal {...baseProps} documentType="design_doc" isSubmitting />,
    );

    const allButtons = screen.getAllByRole('button');
    allButtons.forEach((btn) => {
      expect(btn).toBeDisabled();
    });
  });

  it('shows "Submitting…" text when isSubmitting', () => {
    render(
      <ApproverSelectModal {...baseProps} documentType="design_doc" isSubmitting />,
    );

    expect(screen.getByText('Submitting…')).toBeInTheDocument();
    expect(screen.queryByText('Submit for Review')).not.toBeInTheDocument();
  });
});
