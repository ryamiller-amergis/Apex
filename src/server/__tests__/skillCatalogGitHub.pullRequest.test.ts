describe('skillCatalogGitHub.getPullRequest (PBI-009 AC-0)', () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
    process.env = { ...originalEnv, GITHUB_TOKEN: 'test-token' };
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it('reads title and body from an owner/repo configuration', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        title: 'Implement cloud development AB#123',
        body: 'Automated implementation.',
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const { getPullRequest } = await import('../services/skillCatalogGitHub');

    await expect(getPullRequest('amergis/Apex', 42)).resolves.toEqual({
      title: 'Implement cloud development AB#123',
      body: 'Automated implementation.',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/amergis/Apex/pulls/42',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    );
  });

  it('normalizes a null PR body for reference verification', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ title: 'PR title', body: null }),
    }) as unknown as typeof fetch;
    const { getPullRequest } = await import('../services/skillCatalogGitHub');

    await expect(getPullRequest('amergis/Apex', 42)).resolves.toEqual({
      title: 'PR title',
      body: '',
    });
  });
});
