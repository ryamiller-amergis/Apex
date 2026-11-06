import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { QaLabCaseRun as QaLabCaseRunRecord, QaLabCaseRunState } from '../../../shared/types/qaLab';
import { QaLabCaseRun, suggestedOutcome } from '../QaLabCaseRun';
import { useCaseRun, useCaseRunActions } from '../../hooks/useQaLab';

jest.mock('../../hooks/useQaLab', () => ({
  caseRunUrl: (suiteId: string, localCaseId: string) => `/api/interviews/ado-test-suites/${suiteId}/cases/${localCaseId}/run`,
  useCaseRun: jest.fn(),
  useCaseRunActions: jest.fn(),
}));

function mutation() {
  return { mutateAsync: jest.fn().mockResolvedValue(undefined), isPending: false, error: null };
}

const run = (overrides: Partial<QaLabCaseRunRecord> = {}): QaLabCaseRunRecord => ({
  id: 'run-1',
  status: 'draft',
  outcome: null,
  comment: '',
  stepResults: [],
  attachments: [],
  bugs: [],
  adoRunUrl: null,
  publishedAt: null,
  updatedAt: '2026-11-05T10:00:00.000Z',
  ...overrides,
});

const runState = (overrides: Partial<QaLabCaseRunState> = {}): QaLabCaseRunState => ({
  steps: [
    { order: 1, action: 'Open the timesheet', expected: 'Timesheet shows' },
    { order: 2, action: 'Clock in', expected: 'Clock-in is saved' },
  ],
  adoTestCase: null,
  draft: null,
  changedSteps: [],
  lastPublished: null,
  ...overrides,
});

let actions: Record<'save' | 'attach' | 'removeAttachment' | 'createBug' | 'publish', ReturnType<typeof mutation>>;

function renderRun(state: QaLabCaseRunState) {
  jest.mocked(useCaseRun).mockReturnValue({ data: state, isLoading: false, error: null } as unknown as ReturnType<typeof useCaseRun>);
  render(<QaLabCaseRun suiteId="suite-1" localCaseId="TC-1" />);
  fireEvent.click(screen.getByTestId('qa-lab-run-TC-1-open'));
}

beforeEach(() => {
  actions = {
    save: mutation(),
    attach: mutation(),
    removeAttachment: mutation(),
    createBug: mutation(),
    publish: mutation(),
  };
  jest.mocked(useCaseRunActions).mockReturnValue(actions as unknown as ReturnType<typeof useCaseRunActions>);
});

describe('QaLabCaseRun', () => {
  it('suggests Failed when a step fails and Passed only when every step passes', () => {
    const steps = (outcomes: Array<'passed' | 'failed' | null>) =>
      new Map(outcomes.map((outcome, index) => [index, { order: index, outcome, comment: '' }]));
    expect(suggestedOutcome([0, 1], steps(['passed', 'failed']))).toBe('failed');
    expect(suggestedOutcome([0, 1], steps(['passed', null]))).toBeNull();
    expect(suggestedOutcome([0, 1], steps(['passed', 'passed']))).toBe('passed');
  });

  it('runs a case before it is published and says the results go with it on publish', () => {
    renderRun(runState());

    expect(screen.getByTestId('qa-lab-run-TC-1-unpublished').textContent).toMatch(/when you publish/);
    expect(screen.getByTestId('qa-lab-run-TC-1-step-1-pass')).toBeInTheDocument();
    expect(screen.getByTestId('qa-lab-run-TC-1-case-attach')).toBeInTheDocument();
    expect(screen.queryByTestId('qa-lab-run-TC-1-publish')).toBeNull();
  });

  it('asks before creating the Bug, after the failure has a comment', async () => {
    renderRun(runState());

    fireEvent.click(screen.getByTestId('qa-lab-run-TC-1-step-2-fail'));
    expect(screen.getByTestId('qa-lab-run-TC-1-case-fail').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('qa-lab-run-TC-1-create-bug')).toBeNull();

    fireEvent.change(screen.getByTestId('qa-lab-run-TC-1-step-2-comment'), { target: { value: 'Spinner never stops' } });
    fireEvent.click(screen.getByTestId('qa-lab-run-TC-1-create-bug'));
    expect(screen.getByTestId('qa-lab-run-TC-1-bug-confirm').textContent).toMatch(/linked to the Test Case when you publish/);
    expect(actions.createBug.mutateAsync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('qa-lab-run-TC-1-bug-submit'));
    await waitFor(() => expect(actions.createBug.mutateAsync).toHaveBeenCalled());
    expect(actions.save.mutateAsync).toHaveBeenCalledWith({
      outcome: 'failed',
      comment: '',
      stepResults: [{ order: 2, outcome: 'failed', comment: 'Spinner never stops' }],
    });
  });

  it('publishes on its own once the case is in Azure DevOps', async () => {
    renderRun(runState({ adoTestCase: { id: 600, url: 'https://ado.example/600' } }));

    expect(screen.getByTestId('qa-lab-run-TC-1-case-link')).toHaveAttribute('href', 'https://ado.example/600');
    fireEvent.click(screen.getByTestId('qa-lab-run-TC-1-step-1-pass'));
    fireEvent.click(screen.getByTestId('qa-lab-run-TC-1-step-2-pass'));
    expect(screen.getByTestId('qa-lab-run-TC-1-case-pass').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('qa-lab-run-TC-1-publish'));

    await waitFor(() => expect(actions.publish.mutateAsync).toHaveBeenCalled());
    expect(actions.save.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'passed' }));
  });

  it('links files to Apex, notes changed steps, and lists Bugs and the last run', () => {
    renderRun(runState({
      changedSteps: [2],
      draft: run({
        outcome: 'failed',
        comment: 'Broken',
        attachments: [{ id: 'file-1', fileName: 'screen.png', size: 3, stepOrder: 1 }],
        bugs: [{ id: 777, url: 'https://ado.example/777', title: 'Failed: Clock in', linkedToTestCase: false }],
      }),
      lastPublished: run({ status: 'published', outcome: 'passed', adoRunUrl: 'https://ado.example/run/900', publishedAt: '2026-11-04T10:00:00.000Z' }),
    }));

    expect(screen.getByTestId('qa-lab-run-TC-1-step-1-file-file-1'))
      .toHaveAttribute('href', '/api/interviews/ado-test-suites/suite-1/cases/TC-1/run/attachments/file-1');
    expect(screen.getByTestId('qa-lab-run-TC-1-changed').textContent).toMatch(/Step 2 changed/);
    expect(screen.getByTestId('qa-lab-run-TC-1-bug-777')).toHaveAttribute('href', 'https://ado.example/777');
    expect(screen.getByTestId('qa-lab-run-TC-1-last-link')).toHaveAttribute('href', 'https://ado.example/run/900');
  });
});
