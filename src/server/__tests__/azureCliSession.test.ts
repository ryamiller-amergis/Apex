import { ensureInsightsAzureLogin } from '../services/aiRunsWorker/azureCliSession';

describe('ensureInsightsAzureLogin', () => {
  const original = process.env.AZURE_INSIGHTS_CLIENT_ID;

  afterEach(() => {
    if (original === undefined) delete process.env.AZURE_INSIGHTS_CLIENT_ID;
    else process.env.AZURE_INSIGHTS_CLIENT_ID = original;
  });

  it('signs in as the insights reader identity', async () => {
    process.env.AZURE_INSIGHTS_CLIENT_ID = 'reader-client';
    const run = jest.fn().mockResolvedValue(undefined);

    await ensureInsightsAzureLogin(run);

    expect(run).toHaveBeenCalledWith([
      'login', '--identity', '--client-id', 'reader-client', '--output', 'none',
    ]);
  });

  it('refuses to start when the insights reader identity is not configured', async () => {
    delete process.env.AZURE_INSIGHTS_CLIENT_ID;
    const run = jest.fn();

    await expect(ensureInsightsAzureLogin(run)).rejects.toThrow(/AZURE_INSIGHTS_CLIENT_ID/);
    expect(run).not.toHaveBeenCalled();
  });
});
