import { fireEvent, render, screen } from '@testing-library/react';
import { QaLabPublishReview } from '../QaLabPublishReview';
import { useAdoTestPlanOptions } from '../../hooks/useQaLab';

jest.mock('../../hooks/useQaLab', () => ({
  useAdoTestPlanOptions: jest.fn(),
}));

const plans = [
  {
    id: 15,
    name: '15 Create, Save, Submit Timesheet',
    suites: [
      { id: 150, path: '' },
      { id: 151, path: 'Geofence Clock In and Out' },
      { id: 152, path: 'Geofence Clock In and Out > Inside Geofence Distance' },
    ],
  },
];

beforeEach(() => {
  jest.mocked(useAdoTestPlanOptions).mockReturnValue({
    data: { plans },
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof useAdoTestPlanOptions>);
});

describe('QaLabPublishReview', () => {
  it('preselects proposals that match real suites and sends them on publish', () => {
    const onPublish = jest.fn();
    render(
      <QaLabPublishReview
        suiteId="suite-1"
        cases={[{
          id: 'TC-1',
          title: 'Clock in inside the geofence',
          proposedTestPlan: '15 create, save, submit timesheet',
          proposedTestSuite: 'Geofence Clock In and Out>Inside Geofence Distance',
        }]}
        requireSuite
        isPublishing={false}
        onCancel={jest.fn()}
        onPublish={onPublish}
      />,
    );

    fireEvent.click(screen.getByTestId('qa-lab-publish-review-confirm'));

    expect(onPublish).toHaveBeenCalledWith({ 'TC-1': { planId: 15, suiteId: 152 } });
  });

  it('blocks publish until every case has a suite when the skill requires one', () => {
    render(
      <QaLabPublishReview
        suiteId="suite-1"
        cases={[{ id: 'TC-2', title: 'Unknown placement', proposedTestPlan: 'Missing plan' }]}
        requireSuite
        isPublishing={false}
        onCancel={jest.fn()}
        onPublish={jest.fn()}
      />,
    );

    const confirm = screen.getByTestId('qa-lab-publish-review-confirm');
    expect(confirm).toBeDisabled();
    expect(screen.getByText(/not found/)).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('qa-lab-publish-review-TC-2-plan'), { target: { value: '15' } });
    fireEvent.change(screen.getByTestId('qa-lab-publish-review-TC-2-suite'), { target: { value: '151' } });

    expect(confirm).not.toBeDisabled();
  });

  it('lets cases publish without a suite when the skill does not require one', () => {
    const onPublish = jest.fn();
    render(
      <QaLabPublishReview
        suiteId="suite-1"
        cases={[{ id: 'TC-3', title: 'No proposal' }]}
        requireSuite={false}
        isPublishing={false}
        onCancel={jest.fn()}
        onPublish={onPublish}
      />,
    );

    fireEvent.click(screen.getByTestId('qa-lab-publish-review-confirm'));

    expect(onPublish).toHaveBeenCalledWith({});
  });
});
