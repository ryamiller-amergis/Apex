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

const NO_NEW_PLACEMENTS = { newPlacements: [], newPlacementSelections: {} };

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
          placementReason: 'Clock in inside the geofence radius',
        }]}
        requireSuite
        isPublishing={false}
        onCancel={jest.fn()}
        onPublish={onPublish}
      />,
    );

    expect(screen.getByText('Clock in inside the geofence radius')).toBeTruthy();
    fireEvent.click(screen.getByTestId('qa-lab-publish-review-confirm'));

    expect(onPublish).toHaveBeenCalledWith({ 'TC-1': { planId: 15, suiteId: 152 } }, [], NO_NEW_PLACEMENTS);
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

  it('keeps the Set all choice and leaves matched proposals in place when only a plan is set', () => {
    const onPublish = jest.fn();
    render(
      <QaLabPublishReview
        suiteId="suite-1"
        cases={[
          { id: 'TC-4', title: 'Matched', proposedTestPlan: '15 Create, Save, Submit Timesheet', proposedTestSuite: 'Geofence Clock In and Out' },
          { id: 'TC-5', title: 'No proposal' },
        ]}
        requireSuite
        isPublishing={false}
        onCancel={jest.fn()}
        onPublish={onPublish}
      />,
    );

    const bulkPlan = screen.getByTestId('qa-lab-publish-review-all-plan') as HTMLSelectElement;
    fireEvent.change(bulkPlan, { target: { value: '15' } });
    expect(bulkPlan.value).toBe('15');
    expect((screen.getByTestId('qa-lab-publish-review-TC-4-suite') as HTMLSelectElement).value).toBe('151');
    expect(screen.queryByText(/not found/)).toBeNull();

    const bulkSuite = screen.getByTestId('qa-lab-publish-review-all-suite') as HTMLSelectElement;
    expect(bulkSuite).not.toBeDisabled();
    fireEvent.change(bulkSuite, { target: { value: '152' } });
    expect(bulkSuite.value).toBe('152');

    fireEvent.click(screen.getByTestId('qa-lab-publish-review-confirm'));
    expect(onPublish).toHaveBeenCalledWith({
      'TC-4': { planId: 15, suiteId: 152 },
      'TC-5': { planId: 15, suiteId: 152 },
    }, [], NO_NEW_PLACEMENTS);
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

    expect(onPublish).toHaveBeenCalledWith({}, [], NO_NEW_PLACEMENTS);
  });

  it('creates a proposed plan only after QA approves it, with the edited name', () => {
    const onPublish = jest.fn();
    render(
      <QaLabPublishReview
        suiteId="suite-1"
        cases={[{ id: 'TC-7', title: 'Delete a user', proposedTestPlan: 'Delete User - Functional Testing' }]}
        newPlacements={[{
          key: 'delete user - functional testing|',
          testPlan: 'Delete User - Functional Testing',
          createPlan: true,
          suiteType: 'requirement',
          reason: 'No plan covers Delete User',
        }]}
        requireSuite
        isPublishing={false}
        onCancel={jest.fn()}
        onPublish={onPublish}
      />,
    );

    const confirm = screen.getByTestId('qa-lab-publish-review-confirm');
    expect(screen.getByText('No plan covers Delete User')).toBeTruthy();
    expect(screen.getByText(/new; approve it above/)).toBeTruthy();
    expect(confirm).toBeDisabled();

    fireEvent.click(screen.getByTestId('qa-lab-publish-review-create-0'));
    fireEvent.change(screen.getByTestId('qa-lab-publish-review-create-0-plan'), {
      target: { value: 'Delete Users - Functional Testing' },
    });
    fireEvent.click(confirm);

    expect(onPublish).toHaveBeenCalledWith({}, [], {
      newPlacements: [{
        key: 'delete user - functional testing|',
        testPlan: 'Delete Users - Functional Testing',
        createPlan: true,
        suiteType: 'requirement',
      }],
      newPlacementSelections: { 'TC-7': 'delete user - functional testing|' },
    });
  });

  it('marks a chosen requirement suite so publish does not add the case to it', () => {
    jest.mocked(useAdoTestPlanOptions).mockReturnValue({
      data: { plans: [{ id: 20, name: 'Delete User - Functional Testing', suites: [{ id: 200, path: '' }, { id: 201, path: '40249 : Add Delete User Button', requirementId: 40249 }] }] },
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useAdoTestPlanOptions>);
    const onPublish = jest.fn();
    render(
      <QaLabPublishReview
        suiteId="suite-1"
        cases={[{
          id: 'TC-8',
          title: 'Delete a user',
          proposedTestPlan: 'Delete User - Functional Testing',
          proposedTestSuite: '40249 : Add Delete User Button',
        }]}
        requireSuite
        isPublishing={false}
        onCancel={jest.fn()}
        onPublish={onPublish}
      />,
    );

    fireEvent.click(screen.getByTestId('qa-lab-publish-review-confirm'));

    expect(onPublish).toHaveBeenCalledWith(
      { 'TC-8': { planId: 20, suiteId: 201, requirement: true } },
      [],
      { newPlacements: [], newPlacementSelections: {} },
    );
  });

  it('leaves existing-case updates unchecked until QA chooses them', () => {
    const onPublish = jest.fn();
    render(
      <QaLabPublishReview
        suiteId="suite-1"
        cases={[]}
        updates={[{ id: 'TC-6', title: 'Mute a channel', adoTestCaseId: 700, reason: 'A new step was added' }]}
        requireSuite
        isPublishing={false}
        onCancel={jest.fn()}
        onPublish={onPublish}
      />,
    );

    const confirm = screen.getByTestId('qa-lab-publish-review-confirm');
    expect(screen.getByText('Update existing #700')).toBeTruthy();
    expect(confirm).toBeDisabled();

    fireEvent.click(screen.getByTestId('qa-lab-publish-review-update-TC-6'));
    fireEvent.click(confirm);

    expect(onPublish).toHaveBeenCalledWith({}, ['TC-6'], NO_NEW_PLACEMENTS);
  });
});
