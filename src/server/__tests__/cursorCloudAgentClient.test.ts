jest.mock('../services/repoCacheService', () => ({
  resolveGitRemote: jest.fn((provider: string, project: string, repo: string) => {
    if (provider === 'github') {
      return { url: `https://github.com/${repo}.git`, env: {}, secret: 'gh-token' };
    }
    return {
      url: `https://dev.azure.com/amergis/${project}/_git/${repo}`,
      env: {},
      secret: 'ado-pat',
    };
  }),
}));

import { buildCloudRepoUrl, toCloudRepoUrl } from '../services/cursorCloudAgentClient';

describe('cursorCloudAgentClient', () => {
  it('builds a GitHub HTTPS URL without a .git suffix or local token', () => {
    expect(buildCloudRepoUrl('github', 'Apex', 'amergis/Apex')).toBe(
      'https://github.com/amergis/Apex',
    );
  });

  it('builds an Azure DevOps _git URL without credentials', () => {
    expect(buildCloudRepoUrl('ado', 'MaxView', 'MaxView')).toBe(
      'https://dev.azure.com/amergis/MaxView/_git/MaxView',
    );
  });

  it('strips a trailing .git from clone URLs', () => {
    expect(toCloudRepoUrl('https://github.com/amergis/Apex.git')).toBe(
      'https://github.com/amergis/Apex',
    );
  });
});
