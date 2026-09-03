describe('skillCatalogGitHub.getPullRequestStatus (VT-02 / TBI-006 DoD-1)', () => {
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

  function mockPullRequest(payload: { state: string; merged: boolean }) {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue(payload),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('VT-02 / TBI-006 DoD-1: maps an open GitHub PR to open', async () => {
    const fetchMock = mockPullRequest({ state: 'open', merged: false });
    const { getPullRequestStatus } = await import(
      '../services/skillCatalogGitHub'
    );

    await expect(getPullRequestStatus('amergis/Apex', 42)).resolves.toBe(
      'open'
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/amergis/Apex/pulls/42',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      })
    );
  });

  it('VT-02 / TBI-006 DoD-1: maps a merged GitHub PR to merged', async () => {
    mockPullRequest({ state: 'closed', merged: true });
    const { getPullRequestStatus } = await import(
      '../services/skillCatalogGitHub'
    );

    await expect(getPullRequestStatus('amergis/Apex', 42)).resolves.toBe(
      'merged'
    );
  });

  it('VT-02 / TBI-006 DoD-1: maps a closed but unmerged GitHub PR to open', async () => {
    mockPullRequest({ state: 'closed', merged: false });
    const { getPullRequestStatus } = await import(
      '../services/skillCatalogGitHub'
    );

    await expect(getPullRequestStatus('amergis/Apex', 42)).resolves.toBe(
      'open'
    );
  });

  it('VT-02 / TBI-006 DoD-1: resolves the org from GITHUB_ORG when the repo is unqualified', async () => {
    process.env.GITHUB_ORG = 'amergis';
    const fetchMock = mockPullRequest({ state: 'open', merged: false });
    const { getPullRequestStatus } = await import(
      '../services/skillCatalogGitHub'
    );

    await expect(getPullRequestStatus('Apex', 7)).resolves.toBe('open');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/amergis/Apex/pulls/7',
      expect.anything()
    );
  });
});
