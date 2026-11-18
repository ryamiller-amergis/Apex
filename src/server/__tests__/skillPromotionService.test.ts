import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openSkillChangePullRequest } from '../services/skillPromotionService';
import { getSkillConfig } from '../services/projectSettingsService';
import { checkoutDefaultBranch, cleanupWorkspace, pushBranch } from '../services/repoCheckoutService';
import { git } from '../utils/asyncGit';
import { createPullRequest } from '../services/skillCatalogGitHub';

jest.mock('../services/projectSettingsService', () => ({ getSkillConfig: jest.fn() }));
jest.mock('../services/repoCheckoutService', () => ({
  checkoutDefaultBranch: jest.fn(),
  checkoutNewBranch: jest.fn().mockResolvedValue(undefined),
  cleanupWorkspace: jest.fn(),
  pushBranch: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/repoCacheService', () => ({ resolveGitRemote: jest.fn().mockReturnValue({ url: 'x', env: {} }) }));
jest.mock('../utils/asyncGit', () => ({
  git: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  safeArgs: (_cwd: string, args: string[]) => args,
}));
jest.mock('../services/skillCatalogGitHub', () => ({ createPullRequest: jest.fn() }));
jest.mock('../services/azureDevOps', () => ({ AzureDevOpsService: jest.fn() }));

const SKILL_PATH = '.cursor/skills/to-prd/SKILL.md';
const BASELINE = '# to-prd\r\nWrite testable criteria.\r\n';

describe('openSkillChangePullRequest', () => {
  let workspace: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-pr-'));
    await fs.mkdir(path.join(workspace, '.cursor/skills/to-prd'), { recursive: true });
    jest.mocked(checkoutDefaultBranch).mockResolvedValue(workspace);
    jest.mocked(getSkillConfig).mockResolvedValue({
      skillRepo: 'acme/skills',
      skillBranch: 'main',
      skillProvider: 'github',
    } as never);
    jest.mocked(createPullRequest).mockResolvedValue('https://github.com/acme/skills/pull/7');
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const input = {
    project: 'Apex',
    experimentId: 'abcdef12-0000',
    skillPath: SKILL_PATH,
    baselineContent: BASELINE.replace(/\r\n/g, '\n'),
    candidateContent: '# to-prd\nWrite testable criteria.\nName an owner.\n',
    changeNotes: 'Adds owners',
    result: null,
  };

  it('writes the candidate with the file\'s line endings and opens a GitHub pull request', async () => {
    await fs.writeFile(path.join(workspace, SKILL_PATH), BASELINE);

    const outcome = await openSkillChangePullRequest(input);

    expect(outcome).toEqual({ ok: true, url: 'https://github.com/acme/skills/pull/7', branchName: expect.stringMatching(/^skill-learning\/to-prd-abcdef12-/) });
    await expect(fs.readFile(path.join(workspace, SKILL_PATH), 'utf8')).resolves.toBe(
      '# to-prd\r\nWrite testable criteria.\r\nName an owner.\r\n',
    );
    expect(git).toHaveBeenCalledTimes(2);
    expect(pushBranch).toHaveBeenCalled();
    expect(createPullRequest).toHaveBeenCalledWith(expect.objectContaining({ org: 'acme', repo: 'skills', targetBranch: 'main' }));
    expect(cleanupWorkspace).toHaveBeenCalledWith('skill-learning-abcdef12-0000');
  });

  it('refuses when the Skill changed in the repo after the experiment started', async () => {
    await fs.writeFile(path.join(workspace, SKILL_PATH), '# to-prd\nSomeone else edited this.\n');

    const outcome = await openSkillChangePullRequest(input);

    expect(outcome).toEqual({ ok: false, error: expect.stringContaining('changed in acme/skills@main') });
    expect(pushBranch).not.toHaveBeenCalled();
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it('refuses a Skill path that leaves the repository', async () => {
    const outcome = await openSkillChangePullRequest({ ...input, skillPath: '../outside/SKILL.md' });
    expect(outcome).toEqual({ ok: false, error: 'The Skill path points outside the repository.' });
  });
});
