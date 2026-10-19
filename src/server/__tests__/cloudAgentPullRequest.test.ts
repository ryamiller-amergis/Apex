import fs from 'fs';
import path from 'path';
import { db } from '../db/drizzle';
import { AzureDevOpsService } from '../services/azureDevOps';
import {
  alignCloudAgentPullRequest,
  buildCloudAgentPullRequestText,
  CLOUD_AGENT_PULL_REQUEST_LABEL,
  openCloudAgentPullRequest,
} from '../services/cloudAgentPullRequest';

jest.mock('../db/drizzle', () => ({
  db: { transaction: jest.fn() },
}));

jest.mock('../services/azureDevOps', () => ({
  AzureDevOpsService: jest.fn(),
}));

const ado = {
  findPullRequestUrlBySourceBranch: jest.fn(),
  createPullRequest: jest.fn(),
  updatePullRequest: jest.fn(),
  addPullRequestLabel: jest.fn(),
};

const PR_URL = 'https://dev.azure.com/org/MaxView/_git/MaxView/pullrequest/9';

function skeletonDescription(workItemId: number, workItemTitle?: string): string {
  const template = fs.readFileSync(path.resolve(__dirname, '../../../pr-description.md'), 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim();
  const reference = workItemTitle ? `AB#${workItemId} — ${workItemTitle}` : `AB#${workItemId}`;
  return template.replace(/^Work items:.*$/m, `Work items: ${reference}`);
}

describe('buildCloudAgentPullRequestText', () => {
  it('uses the My Work title and description', () => {
    const text = buildCloudAgentPullRequestText({
      workItemId: 42,
      workItemTitle: 'Implement login',
      authorName: 'Jane Developer',
      authorEmail: 'jane@example.com',
      sourceBranch: 'feature/apex-42-implement-login',
      summary: 'Added the login form.',
    });

    expect(text.title).toBe('[APEX] apex-42-implement-login');
    expect(text.description).toBe(skeletonDescription(42, 'Implement login'));
  });

  it('uses the required branch name for the title when the pushed branch differs', () => {
    const text = buildCloudAgentPullRequestText({
      workItemId: 7,
      sourceBranch: 'cursor/random-branch',
      titleBranch: 'feature/apex-7-fix-login',
    });

    expect(text.title).toBe('[APEX] apex-7-fix-login');
    expect(text.description).toBe(skeletonDescription(7));
  });

  it('uses the filled description from the agent final message', () => {
    const text = buildCloudAgentPullRequestText({
      workItemId: 42,
      sourceBranch: 'feature/apex-42-implement-login',
      summary: [
        'Implemented the login form.',
        '<pr-description>',
        'Work items: AB#42',
        '',
        '#### What does this PR do?',
        '',
        'Adds the login form.',
        '</pr-description>',
      ].join('\n'),
    });

    expect(text.description).toBe(
      'Work items: AB#42\n\n#### What does this PR do?\n\nAdds the login form.',
    );
  });

  it('adds the AB# reference when the filled description leaves it out', () => {
    const text = buildCloudAgentPullRequestText({
      workItemId: 42,
      sourceBranch: 'feature/apex-42-implement-login',
      summary: '<pr-description>\n#### What does this PR do?\n\nAdds the login form.\n</pr-description>',
    });

    expect(text.description).toBe(
      '#### What does this PR do?\n\nAdds the login form.\n\nWork item: AB#42',
    );
  });
});

describe('openCloudAgentPullRequest', () => {
  const input = {
    project: 'MaxView',
    repo: 'MaxView',
    sourceBranch: 'feature/apex-42-implement-login',
    targetBranch: 'main',
    workItemId: 42,
    adoUserToken: 'user-token',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (AzureDevOpsService as unknown as jest.Mock).mockImplementation(() => ado);
    (db.transaction as jest.Mock).mockImplementation(async (fn: (tx: { execute: jest.Mock }) => Promise<unknown>) =>
      fn({ execute: jest.fn().mockResolvedValue(undefined) }),
    );
    ado.findPullRequestUrlBySourceBranch.mockResolvedValue(null);
    ado.createPullRequest.mockResolvedValue(PR_URL);
    ado.updatePullRequest.mockResolvedValue(undefined);
    ado.addPullRequestLabel.mockResolvedValue(undefined);
  });

  it('creates the pull request, then marks it as a draft', async () => {
    const prUrl = await openCloudAgentPullRequest(input);

    expect(prUrl).toBe(PR_URL);
    expect(ado.createPullRequest).toHaveBeenCalledWith(expect.objectContaining({
      sourceBranch: 'feature/apex-42-implement-login',
      targetBranch: 'main',
      workItemId: 42,
    }));
    expect(ado.createPullRequest.mock.calls[0][0].isDraft).toBeUndefined();
    expect(ado.updatePullRequest).toHaveBeenCalledWith({
      repo: 'MaxView',
      project: 'MaxView',
      pullRequestId: 9,
      title: '[APEX] apex-42-implement-login',
      description: skeletonDescription(42),
      isDraft: true,
    });
    expect(ado.addPullRequestLabel).toHaveBeenCalledWith({
      repo: 'MaxView',
      project: 'MaxView',
      pullRequestId: 9,
      name: CLOUD_AGENT_PULL_REQUEST_LABEL,
    });
  });

  it('labels an existing pull request on the same branch', async () => {
    ado.findPullRequestUrlBySourceBranch.mockResolvedValue(PR_URL);

    const prUrl = await openCloudAgentPullRequest(input);

    expect(prUrl).toBe(PR_URL);
    expect(ado.createPullRequest).not.toHaveBeenCalled();
    expect(ado.updatePullRequest).toHaveBeenCalledWith(expect.objectContaining({
      pullRequestId: 9,
      isDraft: true,
    }));
    expect(ado.addPullRequestLabel).toHaveBeenCalledWith({
      repo: 'MaxView',
      project: 'MaxView',
      pullRequestId: 9,
      name: 'apex-cloud-agent',
    });
  });
});

describe('alignCloudAgentPullRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AzureDevOpsService as unknown as jest.Mock).mockImplementation(() => ado);
    ado.updatePullRequest.mockResolvedValue(undefined);
    ado.addPullRequestLabel.mockResolvedValue(undefined);
  });

  it('sets the title and draft without replacing the description', async () => {
    await alignCloudAgentPullRequest({
      project: 'MaxView',
      repo: 'MaxView',
      prUrl: PR_URL,
      workItemId: 42,
      sourceBranch: 'feature/apex-42-implement-login',
    });

    expect(ado.updatePullRequest).toHaveBeenCalledWith({
      repo: 'MaxView',
      project: 'MaxView',
      pullRequestId: 9,
      title: '[APEX] apex-42-implement-login',
      isDraft: true,
    });
  });
});
