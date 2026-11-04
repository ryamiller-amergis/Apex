import { fireEvent, render, screen } from '@testing-library/react';
import type { QaLabCaseComment, QaLabCaseRegeneration, QaLabTestCase } from '../../../shared/types/qaLab';
import { QaLabCaseComments } from '../QaLabCaseComments';
import { diffCaseSteps } from '../QaLabCaseDiff';
import { useAddCaseComment, useRegenerateCase, useRestoreCase } from '../../hooks/useQaLab';

jest.mock('../../hooks/useQaLab', () => ({
  useAddCaseComment: jest.fn(),
  useRegenerateCase: jest.fn(),
  useRestoreCase: jest.fn(),
}));

const regenerate = jest.fn();
const restore = jest.fn();

function mutation(mutate: jest.Mock = jest.fn()) {
  return { mutate, isPending: false, error: null };
}

const comment = (overrides: Partial<QaLabCaseComment>): QaLabCaseComment => ({
  id: 'c1',
  localCaseId: 'TC-2',
  body: 'Login as Hiring Manager',
  status: 'open',
  authorName: 'Priya',
  createdAt: '2026-11-03T10:00:00.000Z',
  ...overrides,
});

const run = (overrides: Partial<QaLabCaseRegeneration>): QaLabCaseRegeneration => ({
  id: 'regen-1',
  localCaseId: 'TC-2',
  status: 'ready',
  threadId: 'thread-1',
  error: null,
  canRestore: true,
  source: 'comments',
  previousCase: null,
  createdAt: '2026-11-03T10:00:00.000Z',
  updatedAt: '2026-11-03T10:01:00.000Z',
  ...overrides,
});

const testCase = (overrides: Partial<QaLabTestCase>): QaLabTestCase => ({
  id: 'TC-2',
  title: 'Validate Reject Timesheet',
  persona: 'Location Timesheet Approver',
  preconditions: [],
  testData: {},
  steps: [
    { order: 1, action: 'Access Env.', expected: 'QA Environment is available.' },
    { order: 2, action: 'Login as Location Timesheet Approver', expected: 'Dashboard opens.' },
    { order: 3, action: 'Click Reject', expected: 'Timesheet is rejected.' },
  ],
  businessRules: [],
  pbiId: 'PBI-1',
  ...overrides,
});

describe('QaLabCaseComments', () => {
  beforeEach(() => {
    jest.mocked(useAddCaseComment).mockReturnValue(mutation() as unknown as ReturnType<typeof useAddCaseComment>);
    jest.mocked(useRegenerateCase).mockReturnValue(mutation(regenerate) as unknown as ReturnType<typeof useRegenerateCase>);
    jest.mocked(useRestoreCase).mockReturnValue(mutation(restore) as unknown as ReturnType<typeof useRestoreCase>);
    regenerate.mockClear();
    restore.mockClear();
  });

  it('needs an open comment before it can regenerate', () => {
    render(<QaLabCaseComments suiteId="s1" localCaseId="TC-2" currentCase={testCase({})} comments={[]} regeneration={null} isPublished={false} />);

    expect((screen.getByTestId('qa-lab-case-regenerate-TC-2') as HTMLButtonElement).disabled).toBe(true);
  });

  it('regenerates the one case from its open comments and hides addressed ones', () => {
    render(
      <QaLabCaseComments
        suiteId="s1"
        localCaseId="TC-2" currentCase={testCase({})}
        comments={[comment({}), comment({ id: 'c0', body: 'Old note', status: 'addressed' })]}
        regeneration={null}
        isPublished={false}
      />,
    );

    expect(screen.getByText('Login as Hiring Manager')).toBeTruthy();
    expect(screen.queryByText('Old note')).toBeNull();
    fireEvent.click(screen.getByTestId('qa-lab-case-regenerate-TC-2'));
    expect(regenerate).toHaveBeenCalledWith({ suiteId: 's1', localCaseId: 'TC-2' });
  });

  it('offers restore after a rewrite and blocks edits while one is running', () => {
    const { rerender } = render(
      <QaLabCaseComments suiteId="s1" localCaseId="TC-2" currentCase={testCase({})} comments={[comment({})]} regeneration={run({})} isPublished={false} />,
    );
    fireEvent.click(screen.getByTestId('qa-lab-case-restore-TC-2'));
    expect(restore).toHaveBeenCalledWith({ suiteId: 's1', regenerationId: 'regen-1' });

    rerender(
      <QaLabCaseComments
        suiteId="s1"
        localCaseId="TC-2" currentCase={testCase({})}
        comments={[comment({})]}
        regeneration={run({ status: 'generating', canRestore: false })}
        isPublished={false}
      />,
    );
    expect(screen.getByTestId('qa-lab-case-regeneration-TC-2').getAttribute('data-state')).toBe('generating');
    expect((screen.getByTestId('qa-lab-case-regenerate-TC-2') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('qa-lab-case-restore-TC-2')).toBeNull();
  });

  it('shows what the rewrite changed against the case before it', () => {
    const before = testCase({
      title: 'Reject timesheet',
      steps: [
        { order: 1, action: 'Access Env.', expected: 'QA Environment is available.' },
        { order: 2, action: 'Login as Worker', expected: 'Dashboard opens.' },
        { order: 3, action: 'Click Reject', expected: 'Timesheet is rejected.' },
        { order: 4, action: 'Logout', expected: 'Login page shows.' },
      ],
    });
    render(
      <QaLabCaseComments
        suiteId="s1"
        localCaseId="TC-2" currentCase={testCase({})}
        comments={[]}
        regeneration={run({ previousCase: before })}
        isPublished={false}
      />,
    );

    const diff = screen.getByTestId('qa-lab-case-diff-TC-2');
    expect(diff.textContent).toContain('Reject timesheet');
    expect(diff.textContent).toContain('Validate Reject Timesheet');
    const kinds = [...diff.querySelectorAll('li')].map((item) => item.getAttribute('data-change'));
    expect(kinds).toEqual(['same', 'changed', 'same', 'removed']);

    fireEvent.click(screen.getByTestId('qa-lab-case-diff-toggle-TC-2'));
    expect(screen.queryByTestId('qa-lab-case-diff-TC-2')).toBeNull();
  });

  it('marks an inserted step as one addition, not as every later step changing', () => {
    const step = (action: string) => ({ order: 0, action, expected: '' });
    const kinds = diffCaseSteps([step('A'), step('C')], [step('A'), step('B'), step('C')]).map((change) => change.kind);
    expect(kinds).toEqual(['same', 'added', 'same']);
  });

  it('points published cases to Azure DevOps instead of offering edits', () => {
    render(<QaLabCaseComments suiteId="s1" localCaseId="TC-2" currentCase={testCase({})} comments={[]} regeneration={null} isPublished />);

    expect(screen.getByText('Published to Azure DevOps. Change this case there.')).toBeTruthy();
    expect(screen.queryByTestId('qa-lab-case-regenerate-TC-2')).toBeNull();
  });
});
