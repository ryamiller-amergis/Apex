import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { QaLabCaseRun as QaLabCaseRunRecord, QaLabCaseRunState } from '../../../shared/types/qaLab';
import { QaLabCaseRun, suggestedOutcome } from '../QaLabCaseRun';
import { useCaseRun, useCaseRunActions } from '../../hooks/useQaLab';

jest.mock('../../hooks/useQaLab', () => ({
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
  target: {
    adoTestCaseId: 600,
    adoTestCaseUrl: 'https://ado.example/600',
    title: 'Clock in',
    planId: 15,
    planName: '15 Timesheets',
    suiteId: 151,
    suiteName: 'Geofence',
    steps: [
      { stepId: 2, order: 1, action: 'Open the timesheet', expected: 'Timesheet shows' },
      { stepId: 3, order: 2, action: 'Clock in', expected: 'Clock-in is saved' },
    ],
  },
  draft: null,
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
      new Map(outcomes.map((outcome, index) => [index, { stepId: index, outcome, comment: '' }]));
    expect(suggestedOutcome([0, 1], steps(['passed', 'failed']))).toBe('failed');
    expect(suggestedOutcome([0, 1], steps(['passed', null]))).toBeNull();
    expect(suggestedOutcome([0, 1], steps(['passed', 'passed']))).toBe('passed');
  });

  it('shows the Azure DevOps steps and why a case cannot run yet', () => {
    renderRun(runState({ target: null, unavailableReason: 'Publish this case to a Test Plan suite before running it.' }));

    expect(screen.getByTestId('qa-lab-run-TC-1-unavailable').textContent).toMatch(/Publish this case/);
    expect(screen.queryByTestId('qa-lab-run-TC-1-publish')).toBeNull();
  });

  it('marks the case Failed when a step fails and offers a Bug once the failure has a comment', async () => {
    renderRun(runState());

    fireEvent.click(screen.getByTestId('qa-lab-run-TC-1-step-3-fail'));
    expect(screen.getByTestId('qa-lab-run-TC-1-case-fail').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('qa-lab-run-TC-1-create-bug')).toBeNull();

    fireEvent.change(screen.getByTestId('qa-lab-run-TC-1-step-3-comment'), { target: { value: 'Spinner never stops' } });
    fireEvent.click(screen.getByTestId('qa-lab-run-TC-1-create-bug'));

    await waitFor(() => expect(actions.createBug.mutateAsync).toHaveBeenCalled());
    expect(actions.save.mutateAsync).toHaveBeenCalledWith({
      outcome: 'failed',
      comment: '',
      stepResults: [{ stepId: 3, outcome: 'failed', comment: 'Spinner never stops' }],
    });
  });

  it('saves, then publishes the results', async () => {
    renderRun(runState());

    fireEvent.click(screen.getByTestId('qa-lab-run-TC-1-step-2-pass'));
    fireEvent.click(screen.getByTestId('qa-lab-run-TC-1-step-3-pass'));
    expect(screen.getByTestId('qa-lab-run-TC-1-case-pass').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('qa-lab-run-TC-1-publish'));

    await waitFor(() => expect(actions.publish.mutateAsync).toHaveBeenCalled());
    expect(actions.save.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'passed' }));
  });

  it('keeps publish disabled until the case has an outcome', () => {
    renderRun(runState({ draft: run() }));

    expect(screen.getByTestId('qa-lab-run-TC-1-publish')).toBeDisabled();
  });

  it('lists Bugs and the last published run', () => {
    renderRun(runState({
      draft: run({ outcome: 'failed', comment: 'Broken', bugs: [{ id: 777, url: 'https://ado.example/777', title: 'Failed: Clock in' }] }),
      lastPublished: run({ status: 'published', outcome: 'passed', adoRunUrl: 'https://ado.example/run/900', publishedAt: '2026-11-04T10:00:00.000Z' }),
    }));

    expect(screen.getByTestId('qa-lab-run-TC-1-bug-777')).toHaveAttribute('href', 'https://ado.example/777');
    expect(screen.getByTestId('qa-lab-run-TC-1-last-link')).toHaveAttribute('href', 'https://ado.example/run/900');
  });
});
