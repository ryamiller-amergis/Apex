const createPullRequest = jest.fn();
const findPullRequestUrlBySourceBranch = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    transaction: async (fn: (tx: { execute: () => Promise<void> }) => Promise<unknown>) => fn({
      execute: async () => undefined,
    }),
  },
}));

jest.mock('../services/azureDevOps', () => ({
  AzureDevOpsService: jest.fn().mockImplementation(() => ({
    createPullRequest,
    findPullRequestUrlBySourceBranch,
  })),
}));

import { AzureDevOpsService } from '../services/azureDevOps';
import {
  buildCloudAgentPullRequestText,
  CloudAgentPullRequestDeferred,
  openCloudAgentPullRequest,
} from '../services/cloudAgentPullRequest';

describe('buildCloudAgentPullRequestText', () => {
  it('includes the work item, branch, starter, and implementation summary', () => {
    const text = buildCloudAgentPullRequestText({
      workItemId: 42,
      workItemTitle: 'Implement login',
      authorName: 'Jane Developer',
      authorEmail: 'jane@example.com',
      sourceBranch: 'feature/apex-42-abc',
      summary: 'Added the login form.',
    });

    expect(text.title).toBe('AB#42: Implement login');
    expect(text.description).toContain('Work item: AB#42 — Implement login');
    expect(text.description).toContain('Branch: feature/apex-42-abc');
    expect(text.description).toContain('Started by: Jane Developer (jane@example.com)');
    expect(text.description).toContain('Added the login form.');
  });

  it('omits the starter line when the run has no developer name', () => {
    const text = buildCloudAgentPullRequestText({
      workItemId: 7,
      sourceBranch: 'feature/apex-7-abc',
    });

    expect(text.title).toBe('AB#7');
    expect(text.description).not.toContain('Started by:');
    expect(text.description).not.toContain('## Implementation summary');
  });

  it('appends a concise quality-check section and leaves My Work text unchanged without checks', () => {
    const text = buildCloudAgentPullRequestText({
      workItemId: 77,
      workItemTitle: 'See enrolled benefits',
      sourceBranch: 'feature/apex-77-abc',
      summary: 'Added the benefits list.',
      checkResults: [
        { kind: 'lint', outcome: 'passed' },
        { kind: 'unit', outcome: 'failed' },
        { kind: 'security', outcome: 'failed' },
      ],
    });

    expect(text.description).toContain('## Quality checks');
    expect(text.description).toContain('lint: passed');
    expect(text.description).toContain('unit: failed');
    expect(text.description).toContain('security: failed');

    const plain = buildCloudAgentPullRequestText({
      workItemId: 7,
      sourceBranch: 'feature/apex-7-abc',
    });
    expect(plain.description).not.toContain('## Quality checks');
  });
});

describe('openCloudAgentPullRequest draft and service identity', () => {
  const previousEnv = process.env.NODE_ENV;

  beforeEach(() => {
    createPullRequest.mockReset();
    findPullRequestUrlBySourceBranch.mockReset();
    findPullRequestUrlBySourceBranch.mockResolvedValue(null);
    createPullRequest.mockResolvedValue('https://dev.azure.com/amergis/Apex%20-%20Apps/_git/benefits-tracker/pullrequest/9');
    (AzureDevOpsService as unknown as jest.Mock).mockClear();
  });

  afterEach(() => {
    process.env.NODE_ENV = previousEnv;
  });

  it('opens a draft pull request with a required reviewer for a service-account product build', async () => {
    process.env.NODE_ENV = 'production';

    await openCloudAgentPullRequest({
      project: 'Apex - Apps',
      repo: 'benefits-tracker',
      sourceBranch: 'feature/apex-77-abc',
      targetBranch: 'main',
      workItemId: 77,
      workItemTitle: 'See enrolled benefits',
      adoUserToken: null,
      allowServiceAccount: true,
      draftPullRequest: true,
      requiredReviewerId: 'ryan-oid',
      checkResults: [{ kind: 'lint', outcome: 'failed' }],
    } as never);

    expect(createPullRequest).toHaveBeenCalledWith(expect.objectContaining({
      project: 'Apex - Apps',
      repo: 'benefits-tracker',
      isDraft: true,
      reviewers: [{ id: 'ryan-oid', isRequired: true }],
      description: expect.stringContaining('lint: failed'),
    }));
  });

  it('still waits for the developer token in production when the snapshot does not allow the service account', async () => {
    process.env.NODE_ENV = 'production';

    await expect(openCloudAgentPullRequest({
      project: 'MaxView',
      repo: 'MaxView',
      sourceBranch: 'feature/apex-42-abc',
      targetBranch: 'development',
      workItemId: 42,
      adoUserToken: null,
    })).rejects.toBeInstanceOf(CloudAgentPullRequestDeferred);
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it('keeps a developer pull request active when draft is not requested', async () => {
    process.env.NODE_ENV = 'test';

    await openCloudAgentPullRequest({
      project: 'MaxView',
      repo: 'MaxView',
      sourceBranch: 'feature/apex-42-abc',
      targetBranch: 'development',
      workItemId: 42,
      adoUserToken: 'developer-token',
    });

    const payload = createPullRequest.mock.calls[0][0] as { isDraft?: boolean; reviewers?: unknown };
    expect(payload.isDraft).toBeUndefined();
    expect(payload.reviewers).toBeUndefined();
  });
});
