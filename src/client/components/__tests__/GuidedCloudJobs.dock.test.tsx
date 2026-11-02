import { render, screen } from '@testing-library/react';
import { GuidedCloudJobs, HOME_GUIDED_JOBS_SLOT_ID, notifyHomeGuidedJobsSlot } from '../GuidedCloudJobs';

jest.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => ({
    flags: {
      'cloud-agent-guided-launch': true,
      'my-work-cloud-agent': true,
    },
  }),
}));

jest.mock('../../hooks/useDevWorkbench', () => ({
  useGuidedCloudJobs: () => ({
    data: { jobs: [], runs: [] },
    isLoading: false,
    error: null,
    refetch: jest.fn(),
  }),
  useStartGuidedCloudAgentRun: () => ({ mutateAsync: jest.fn() }),
  useCancelGuidedCloudAgentRun: () => ({ mutateAsync: jest.fn() }),
}));

describe('GuidedCloudJobs header dock', () => {
  it('places Report an issue in the home header slot beside History', () => {
    render(
      <>
        <div id={HOME_GUIDED_JOBS_SLOT_ID} />
        <GuidedCloudJobs project="Apex" />
      </>,
    );

    const button = screen.getByTestId('home-guided-jobs');
    expect(button).toHaveTextContent('Report an issue');
    expect(button.parentElement).toHaveAttribute('id', HOME_GUIDED_JOBS_SLOT_ID);
  });

  it('keeps Report an issue in the tab strip when the header slot is gone', () => {
    const { rerender } = render(
      <>
        <div id={HOME_GUIDED_JOBS_SLOT_ID} />
        <GuidedCloudJobs project="Apex" />
      </>,
    );

    rerender(<GuidedCloudJobs project="Apex" />);
    notifyHomeGuidedJobsSlot();

    const button = screen.getByTestId('home-guided-jobs');
    expect(button.parentElement).not.toHaveAttribute('id', HOME_GUIDED_JOBS_SLOT_ID);
  });
});
