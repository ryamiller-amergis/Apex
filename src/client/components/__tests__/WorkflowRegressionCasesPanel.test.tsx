import { render, screen, fireEvent } from '@testing-library/react';
import { WorkflowRegressionCasesPanel } from '../WorkflowRegressionCasesPanel';

const mockUseCases = jest.fn();
const mockUpdate = jest.fn();
const mockBackfill = jest.fn();
jest.mock('../../hooks/useWorkflowEvaluationsAdmin', () => ({
  useSkillRegressionCases: (...args: unknown[]) => mockUseCases(...args),
  useUpdateSkillRegressionCase: () => ({
    mutate: mockUpdate,
    reset: jest.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
  useBackfillSkillRegressionCases: () => ({ mutate: mockBackfill, isPending: false }),
}));

const ACTIVE_ID = '11111111-1111-4111-8111-111111111111';
const RETIRED_ID = '22222222-2222-4222-8222-222222222222';

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: ACTIVE_ID,
    eventId: 'e1',
    subjectType: 'prd',
    subjectId: 'p1',
    phaseIndex: null,
    stageKey: 'prd_human_review',
    skillPath: '.cursor/skills/to-prd/SKILL.md',
    skillVersion: 'sha',
    reason: 'both',
    outcome: 'accept_after_edits',
    lowCriteria: ['readiness'],
    comment: 'Readiness was thin.',
    reviewerName: 'Ada',
    snapshotStatus: 'stored',
    status: 'active',
    statusReason: null,
    statusChangedByName: null,
    statusChangedAt: null,
    createdAt: '2026-10-22T10:00:00.000Z',
    ...overrides,
  };
}

function casesResult(cases = [entry()]) {
  return {
    data: { cases, skillPaths: ['.cursor/skills/to-prd/SKILL.md'], limit: 200 },
    isLoading: false,
    isError: false,
    error: null,
  };
}

function openPanel() {
  render(<WorkflowRegressionCasesPanel project="proj-a" />);
  fireEvent.click(screen.getByTestId('workflow-regression-cases-toggle'));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseCases.mockReturnValue(casesResult());
});

describe('WorkflowRegressionCasesPanel', () => {
  it('stays collapsed and does not load until opened', () => {
    render(<WorkflowRegressionCasesPanel project="proj-a" />);
    expect(mockUseCases).toHaveBeenLastCalledWith('proj-a', { status: 'active' }, false);
    expect(screen.queryByTestId('workflow-regression-cases-table')).not.toBeInTheDocument();
  });

  it('lists active cases with readable labels once opened', () => {
    openPanel();
    expect(mockUseCases).toHaveBeenLastCalledWith('proj-a', { status: 'active' }, true);
    const row = screen.getByTestId(`workflow-regression-case-${ACTIVE_ID}`);
    expect(row).toHaveTextContent('to-prd');
    expect(row).toHaveTextContent('Low score + corrected text');
    expect(row).toHaveTextContent('Readiness');
    expect(row).toHaveTextContent('Copy saved');
  });

  it('passes the status and skill filters to the query', () => {
    openPanel();
    fireEvent.change(screen.getByTestId('workflow-regression-cases-status'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('workflow-regression-cases-skill'), {
      target: { value: '.cursor/skills/to-prd/SKILL.md' },
    });
    expect(mockUseCases).toHaveBeenLastCalledWith(
      'proj-a',
      { skillPath: '.cursor/skills/to-prd/SKILL.md' },
      true,
    );
  });

  it('needs a reason before retiring a case', () => {
    openPanel();
    fireEvent.click(screen.getByTestId(`workflow-regression-case-retire-${ACTIVE_ID}`));
    const confirm = screen.getByTestId(`workflow-regression-case-retire-confirm-${ACTIVE_ID}`);
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByTestId(`workflow-regression-case-retire-reason-${ACTIVE_ID}`), {
      target: { value: '  Scored the wrong document ' },
    });
    fireEvent.click(confirm);
    expect(mockUpdate).toHaveBeenCalledWith(
      { caseId: ACTIVE_ID, update: { status: 'retired', reason: 'Scored the wrong document' } },
      expect.any(Object),
    );
  });

  it('shows the retire reason and restores a retired case', () => {
    mockUseCases.mockReturnValue(casesResult([
      entry({ id: RETIRED_ID, status: 'retired', statusReason: 'Duplicate', statusChangedByName: 'Grace' }),
    ]));
    openPanel();
    expect(screen.getByTestId(`workflow-regression-case-${RETIRED_ID}`)).toHaveTextContent('Retired by Grace: Duplicate');
    fireEvent.click(screen.getByTestId(`workflow-regression-case-restore-${RETIRED_ID}`));
    expect(mockUpdate).toHaveBeenCalledWith({ caseId: RETIRED_ID, update: { status: 'active' } });
  });

  it('runs the backfill and reports the counts', () => {
    mockBackfill.mockImplementation((_vars: unknown, options: { onSuccess: (r: unknown) => void }) => {
      options.onSuccess({ created: 3, stored: 2, artifactChanged: 1, failed: 0, remaining: 0 });
    });
    openPanel();
    fireEvent.click(screen.getByTestId('workflow-regression-cases-backfill'));
    expect(screen.getByTestId('workflow-regression-cases-backfill-status')).toHaveTextContent(
      '3 new cases, 2 copies saved, 1 changed before a copy could be saved.',
    );
  });

  it('says so when nothing matches', () => {
    mockUseCases.mockReturnValue(casesResult([]));
    openPanel();
    expect(screen.getByText('No cases match these filters.')).toBeInTheDocument();
  });
});
