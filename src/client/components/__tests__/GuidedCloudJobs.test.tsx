import { fireEvent, render, screen } from '@testing-library/react';
import { GuidedCloudJobs } from '../GuidedCloudJobs';
import { CLOUD_AGENT_GUIDED_LAUNCH_FLAG, MY_WORK_CLOUD_AGENT_FLAG } from '../../../shared/types/featureFlags';

const jobs = [
  {
    id: 'site-issue',
    title: "There's an issue on the site",
    description: 'Site',
    skillName: 'bug-fix',
    skillPath: '.cursor/skills/bug-fix/SKILL.md',
    opensBug: true,
  },
  {
    id: 'prod-investigation',
    title: 'Investigate production',
    description: 'Production',
    skillName: 'prod-investigation',
    skillPath: '.cursor/skills/prod-investigation/SKILL.md',
    opensBug: false,
  },
];

let flags: Record<string, boolean> = {
  [CLOUD_AGENT_GUIDED_LAUNCH_FLAG]: true,
  [MY_WORK_CLOUD_AGENT_FLAG]: true,
};

jest.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => ({ flags }),
}));

jest.mock('../../hooks/useDevWorkbench', () => ({
  useGuidedCloudJobs: () => ({
    data: {
      jobs,
      skills: [],
      models: [],
      recommendedModel: 'composer-2.5',
      runs: [],
    },
    isLoading: false,
    error: null,
    refetch: jest.fn(),
  }),
  useStartGuidedCloudAgentRun: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useCancelGuidedCloudAgentRun: () => ({ mutateAsync: jest.fn() }),
}));

jest.mock('../CloudAgentLaunchDialog', () => ({
  CloudAgentLaunchDialog: ({ title, defaultTask, taskLabel }: { title: string; defaultTask: string; taskLabel: string }) => (
    <div data-testid="launch-dialog">
      <h2>{title}</h2>
      <p>{taskLabel}</p>
      <pre>{defaultTask}</pre>
    </div>
  ),
}));

describe('GuidedCloudJobs', () => {
  beforeEach(() => {
    flags = {
      [CLOUD_AGENT_GUIDED_LAUNCH_FLAG]: true,
      [MY_WORK_CLOUD_AGENT_FLAG]: true,
    };
  });

  it('offers a production investigation on the page', () => {
    render(<GuidedCloudJobs project="MaxView" />);
    expect(screen.getByRole('heading', { name: 'Prod Support' })).toBeInTheDocument();
    expect(screen.queryByTestId('home-guided-jobs')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('prod-support-prod'));
    expect(screen.getByRole('heading', { name: 'Investigate production' })).toBeInTheDocument();
    expect(screen.getByText('What happened in production?')).toBeInTheDocument();
    expect(screen.getByText(/Who is affected:/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Investigate a timecard' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New report' })).not.toBeInTheDocument();
  });

  it('says the page is off when the flags are off', () => {
    flags = {
      [CLOUD_AGENT_GUIDED_LAUNCH_FLAG]: false,
      [MY_WORK_CLOUD_AGENT_FLAG]: false,
    };
    render(<GuidedCloudJobs project="MaxView" />);
    expect(screen.getByText(/not turned on for this project/)).toBeInTheDocument();
    expect(screen.queryByTestId('prod-support-prod')).not.toBeInTheDocument();
  });
});
