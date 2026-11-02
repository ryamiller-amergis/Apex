import {
  cloneProjectCommit,
  type ProjectCommitCloneDeps,
} from '../services/brainstorm/projectCommitClone';

const sha = 'a'.repeat(40);
const input = {
  cacheDir: '/data/repo-cache/ado-maxview-maxview-abc.git',
  destination: '/data/workspaces/brainstorm/s1/src1',
  sha,
  signal: new AbortController().signal,
  identity: { provider: 'ado' as const, project: 'MaxView', repository: 'MaxView' },
};

function deps(overrides: Partial<ProjectCommitCloneDeps> = {}): ProjectCommitCloneDeps {
  return {
    isWholeV2Project: jest.fn().mockResolvedValue(true),
    isRepoCacheDir: jest.fn().mockReturnValue(true),
    resolveRemoteUrl: jest.fn().mockReturnValue('https://dev.azure.com/org/MaxView/_git/MaxView'),
    cloneCached: jest.fn().mockResolvedValue(undefined),
    cloneTemporary: jest.fn().mockResolvedValue('ok'),
    ...overrides,
  };
}

describe('cloneProjectCommit', () => {
  it('fetches a whole-V2 project commit from the remote instead of this host mirror', async () => {
    const d = deps();

    await cloneProjectCommit(input, d);

    expect(d.cloneCached).not.toHaveBeenCalled();
    expect(d.resolveRemoteUrl).toHaveBeenCalledWith('ado', 'MaxView', 'MaxView');
    expect(d.cloneTemporary).toHaveBeenCalledWith({
      url: 'https://dev.azure.com/org/MaxView/_git/MaxView',
      sha,
      destination: input.destination,
      signal: input.signal,
      identity: input.identity,
    });
  });

  it.each([
    ['the project is not wholly on V2', { isWholeV2Project: jest.fn().mockResolvedValue(false) }],
    ['the source is a feature-owned clone', { isRepoCacheDir: jest.fn().mockReturnValue(false) }],
  ])('keeps the cached path when %s', async (_label, overrides) => {
    const d = deps(overrides);

    await cloneProjectCommit(input, d);

    expect(d.cloneCached).toHaveBeenCalledWith(input);
    expect(d.cloneTemporary).not.toHaveBeenCalled();
  });

  it('keeps the cached path when the source has no identity', async () => {
    const d = deps();
    const withoutIdentity = { ...input, identity: undefined };

    await cloneProjectCommit(withoutIdentity, d);

    expect(d.cloneCached).toHaveBeenCalledWith(withoutIdentity);
    expect(d.isWholeV2Project).not.toHaveBeenCalled();
  });

  it('fails when the fetched commit does not match', async () => {
    const d = deps({ cloneTemporary: jest.fn().mockResolvedValue('moved') });

    await expect(cloneProjectCommit(input, d)).rejects.toThrow('The saved clone changed');
  });
});
