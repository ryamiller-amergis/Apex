/**
 * @jest-environment node
 */
describe('skillCatalogGitHub.searchRepoCode cache', () => {
  const originalFetch = global.fetch;
  const originalOrg = process.env.GITHUB_ORG;
  const originalToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    jest.resetModules();
    process.env.GITHUB_ORG = 'acme';
    process.env.GITHUB_TOKEN = 'test-token';
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalOrg === undefined) delete process.env.GITHUB_ORG;
    else process.env.GITHUB_ORG = originalOrg;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
  });

  it('caches identical searches so GitHub /search/code is only hit once', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{
          name: 'Foo.tsx',
          path: 'src/Foo.tsx',
          html_url: 'https://github.com/acme/repo/blob/main/src/Foo.tsx',
          text_matches: [{ fragment: 'Avatar' }],
        }],
      }),
    });

    const { searchRepoCode, invalidateCache } = await import('../services/skillCatalogGitHub');
    invalidateCache();

    const first = await searchRepoCode('repo', 'Avatar', 'main', 'acme', 5);
    const second = await searchRepoCode('repo', 'Avatar', 'main', 'acme', 5);

    expect(first).toEqual(second);
    expect(first[0]?.path).toBe('/src/Foo.tsx');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns empty array for blank query without calling GitHub', async () => {
    const { searchRepoCode } = await import('../services/skillCatalogGitHub');
    await expect(searchRepoCode('repo', '   ')).resolves.toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
