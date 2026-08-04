/**
 * @jest-environment node
 */
describe('skillCatalogGitHub.searchRepoCode cache', () => {
  const originalFetch = global.fetch;
  const originalOrg = process.env.GITHUB_ORG;
  const originalToken = process.env.GITHUB_TOKEN;
  const originalSearchInterval = process.env.GITHUB_CODE_SEARCH_MIN_INTERVAL_MS;

  beforeEach(() => {
    jest.resetModules();
    process.env.GITHUB_ORG = 'acme';
    process.env.GITHUB_TOKEN = 'test-token';
    process.env.GITHUB_CODE_SEARCH_MIN_INTERVAL_MS = '0';
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalOrg === undefined) delete process.env.GITHUB_ORG;
    else process.env.GITHUB_ORG = originalOrg;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    if (originalSearchInterval === undefined) delete process.env.GITHUB_CODE_SEARCH_MIN_INTERVAL_MS;
    else process.env.GITHUB_CODE_SEARCH_MIN_INTERVAL_MS = originalSearchInterval;
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

  it('debounces identical concurrent searches onto one GitHub request', async () => {
    let resolveFetch!: (value: unknown) => void;
    (global.fetch as jest.Mock).mockImplementation(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const { searchRepoCode } = await import('../services/skillCatalogGitHub');
    const first = searchRepoCode('repo', 'Walkthrough', 'main', 'acme', 5);
    const second = searchRepoCode('repo', 'Walkthrough', 'main', 'acme', 5);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    resolveFetch({
      ok: true,
      json: async () => ({ items: [] }),
    });

    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
  });

  it('rejects a different overlapping search instead of queuing behind it', async () => {
    let resolveFetch!: (value: unknown) => void;
    (global.fetch as jest.Mock).mockImplementation(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const { searchRepoCode } = await import('../services/skillCatalogGitHub');
    const first = searchRepoCode('repo', 'Walkthrough', 'main', 'acme', 5);
    await expect(
      searchRepoCode('repo', 'FeatureFlag', 'main', 'acme', 5),
    ).rejects.toThrow('already running');

    resolveFetch({
      ok: true,
      json: async () => ({ items: [] }),
    });
    await expect(first).resolves.toEqual([]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('fails fast after GitHub returns a code-search 403', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: { get: jest.fn().mockReturnValue(null) },
      text: async () => 'secondary rate limit',
    });

    const { searchRepoCode } = await import('../services/skillCatalogGitHub');
    await expect(
      searchRepoCode('repo', 'Walkthrough', 'main', 'acme', 5),
    ).rejects.toThrow('rate-limited (403)');
    await expect(
      searchRepoCode('repo', 'FeatureFlag', 'main', 'acme', 5),
    ).rejects.toThrow('rate-limited; retry after');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
