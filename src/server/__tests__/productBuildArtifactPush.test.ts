import {
  filterChangedProductBuildArtifacts,
  pushProductBuildArtifacts,
} from '../services/productBuildArtifactPush';

describe('product build artifact push', () => {
  const changes = [
    { path: 'docs/product/PRODUCT.md', content: 'product-a' },
    { path: 'docs/product/BUILD_BRIEF.md', content: 'brief-a' },
    { path: 'docs/product/prototype.html', content: '<html>a</html>' },
    { path: 'docs/product/build-manifest.json', content: '{}' },
  ];

  it('returns no changes when main already matches every artifact', () => {
    const remote = new Map(changes.map((change) => [change.path, change.content]));
    expect(filterChangedProductBuildArtifacts(changes, remote)).toEqual([]);
  });

  it('pushes only files that are missing or different on main', () => {
    const remote = new Map<string, string | null>([
      [changes[0].path, changes[0].content],
      [changes[1].path, 'older brief'],
      [changes[2].path, null],
      [changes[3].path, changes[3].content],
    ]);

    expect(filterChangedProductBuildArtifacts(changes, remote)).toEqual([
      changes[1],
      changes[2],
    ]);
  });

  it('skips pushRepositoryFiles when every artifact already matches main', async () => {
    const pushFiles = jest.fn(async () => undefined);
    const readRepositoryFile = jest.fn(async (_repo: string, _branch: string, path: string) => (
      changes.find((change) => change.path === path)?.content ?? null
    ));

    await pushProductBuildArtifacts({
      repoName: 'benefits-tracker',
      branch: 'main',
      changes,
    }, { readRepositoryFile, pushFiles });

    expect(readRepositoryFile).toHaveBeenCalledTimes(changes.length);
    expect(pushFiles).not.toHaveBeenCalled();
  });

  it('pushes only changed artifacts when main is partially stale', async () => {
    const pushFiles = jest.fn(async () => undefined);
    const readRepositoryFile = jest.fn(async (_repo: string, _branch: string, path: string) => {
      if (path === changes[1].path) return 'older brief';
      return changes.find((change) => change.path === path)?.content ?? null;
    });

    await pushProductBuildArtifacts({
      repoName: 'benefits-tracker',
      branch: 'main',
      changes,
    }, { readRepositoryFile, pushFiles });

    expect(pushFiles).toHaveBeenCalledWith({
      repoName: 'benefits-tracker',
      branch: 'main',
      changes: [changes[1]],
    });
  });
});
