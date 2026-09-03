import type { AzureDevOpsService } from '../services/azureDevOps';
import {
  buildWorkItemReferenceText,
  linkWorkItemToPullRequest,
  parsePullRequestNumber,
  verifyGithubReference,
} from '../services/workItemPrLinkService';

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    getGithubPullRequest: jest.fn().mockResolvedValue({ title: '', body: '' }),
    createAzureDevOpsService: jest.fn(),
    trackEvent: jest.fn(),
    ...overrides,
  };
}

describe('workItemPrLinkService (PBI-009 / TBI-008)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('AC-0 / DoD-0: builds the exact GitHub work-item mention', () => {
    expect(buildWorkItemReferenceText(123)).toBe('AB#123');
  });

  it('AC-0: verifies the mention in a GitHub PR title or body', async () => {
    const deps = dependencies({
      getGithubPullRequest: jest.fn().mockResolvedValue({
        title: 'Cloud implementation',
        body: 'Links AB#123',
      }),
    });

    await expect(verifyGithubReference({
      repo: 'amergis/Apex',
      prUrl: 'https://github.com/amergis/Apex/pull/42',
      workItemId: 123,
      project: 'Apex',
    }, deps)).resolves.toEqual({ present: true });
    expect(deps.getGithubPullRequest).toHaveBeenCalledWith('amergis/Apex', 42);
    expect(deps.trackEvent).not.toHaveBeenCalled();
  });

  it('AC-1: warns and emits telemetry when the GitHub mention is missing', async () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation();
    const deps = dependencies();

    await expect(verifyGithubReference({
      repo: 'amergis/Apex',
      prUrl: 'https://github.com/amergis/Apex/pull/42',
      workItemId: 123,
      project: 'Apex',
      runId: 'run-1',
      sessionId: 'session-1',
    }, deps)).resolves.toEqual({ present: false });
    expect(warning).toHaveBeenCalledWith(
      '[work-item-pr-link] missing AB# mention',
      expect.stringContaining('"workItemId":123'),
    );
    expect(deps.trackEvent).toHaveBeenCalledWith(
      'cloud_agent_run.work_item_reference_missing',
      {
        project: 'Apex',
        provider: 'github',
        workItemId: '123',
        runId: 'run-1',
        sessionId: 'session-1',
      },
    );
  });

  it('AC-2 / DoD-1: dispatches Azure Repos to the native work-item linker', async () => {
    const linkNative = jest.fn().mockResolvedValue(undefined);
    const deps = dependencies({
      createAzureDevOpsService: jest.fn().mockReturnValue({
        linkWorkItemToPullRequest: linkNative,
      } as unknown as AzureDevOpsService),
    });

    await expect(linkWorkItemToPullRequest({
      provider: 'ado',
      project: 'MaxView',
      repo: 'MaxView/Api',
      prUrl: 'https://dev.azure.com/amergis/MaxView/_git/Api/pullrequest/42',
      workItemId: 123,
    }, deps)).resolves.toEqual({ mechanism: 'native-link', verified: true });
    expect(linkNative).toHaveBeenCalledWith('MaxView', 'Api', 42, 123);
  });

  it('AC-3 / DoD-2: makes no host call when no PR exists', async () => {
    const deps = dependencies();

    await expect(linkWorkItemToPullRequest({
      provider: 'github',
      project: 'Apex',
      repo: 'amergis/Apex',
      prUrl: null,
      workItemId: 123,
    }, deps)).resolves.toBeNull();
    expect(deps.getGithubPullRequest).not.toHaveBeenCalled();
    expect(deps.createAzureDevOpsService).not.toHaveBeenCalled();
  });

  it('S3 / TBI-006 DoD-1: parses the PR number from a GitHub pull URL', () => {
    expect(parsePullRequestNumber('https://github.com/amergis/Apex/pull/42', 'github')).toBe(42);
    expect(parsePullRequestNumber('https://github.com/amergis/Apex/pull/42/files', 'github')).toBe(42);
  });

  it('S3 / TBI-006 DoD-1: parses the PR id from an Azure Repos pullrequest URL', () => {
    expect(parsePullRequestNumber(
      'https://dev.azure.com/amergis/MaxView/_git/Api/pullrequest/7',
      'ado',
    )).toBe(7);
    expect(parsePullRequestNumber(
      'https://dev.azure.com/amergis/MaxView/_git/Api/pullrequest/7/',
      'ado',
    )).toBe(7);
  });

  it('S3 / TBI-006 DoD-1: rejects malformed PR URLs for both hosts', () => {
    expect(() => parsePullRequestNumber('not-a-url', 'github')).toThrow();
    expect(() => parsePullRequestNumber('https://github.com/amergis/Apex/pull/abc', 'github'))
      .toThrow('Invalid github pull request URL');
    expect(() => parsePullRequestNumber('https://github.com/amergis/Apex/pull/0', 'github'))
      .toThrow('Invalid github pull request URL');
    expect(() => parsePullRequestNumber('https://github.com/amergis/Apex/pulls', 'github'))
      .toThrow('Invalid github pull request URL');
    expect(() => parsePullRequestNumber(
      'https://dev.azure.com/amergis/MaxView/_git/Api/pullrequest/abc',
      'ado',
    )).toThrow('Invalid ado pull request URL');
    expect(() => parsePullRequestNumber(
      'https://dev.azure.com/amergis/MaxView/_git/Api/pull/7',
      'ado',
    )).toThrow('Invalid ado pull request URL');
  });
});
