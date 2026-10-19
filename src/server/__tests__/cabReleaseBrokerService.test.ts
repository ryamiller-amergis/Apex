import {
  assertCabAdoRequestAllowed,
  CabReleaseBrokerError,
  forwardCabAdoRequest,
} from '../services/cabReleaseBrokerService';

const env = {
  ADO_ORG: 'https://dev.azure.com/Amergis',
  ADO_PAT: 'server-pat',
} as NodeJS.ProcessEnv;

function request(url: string, method = 'GET', body?: unknown) {
  return { method, url, body };
}

describe('cabReleaseBrokerService', () => {
  it('allows the release ref lookup and attaches the server PAT', async () => {
    const seen: { authorization?: string; url?: string } = {};
    const result = await forwardCabAdoRequest(
      request('https://dev.azure.com/Amergis/MaxView/_apis/git/repositories/MaxView/refs?filter=heads/Release/2026.15.0&api-version=7.1'),
      env,
      (async (url, init) => {
        seen.url = String(url);
        seen.authorization = (init?.headers as Record<string, string>).Authorization;
        return new Response(JSON.stringify({ value: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ value: [] });
    expect(seen.url).toContain('heads/Release/2026.15.0');
    expect(seen.authorization).toBe(
      `Basic ${Buffer.from(':server-pat').toString('base64')}`,
    );
  });

  it('returns an Azure DevOps error status without throwing', async () => {
    const result = await forwardCabAdoRequest(
      request('https://dev.azure.com/Amergis/MaxView/_apis/wiki/wikis/MaxView.wiki/pages?path=/Manual%20Release/2026.15.0&api-version=7.1'),
      env,
      (async () => new Response('missing', { status: 404, headers: { etag: '"1"' } })) as typeof fetch,
    );
    expect(result.status).toBe(404);
    expect(result.etag).toBe('"1"');
  });

  it('rejects work-item updates and other organizations', () => {
    expect(() => assertCabAdoRequestAllowed(
      request('https://dev.azure.com/Amergis/MaxView/_apis/wit/workitems/1', 'PATCH', [{ op: 'add' }]),
      env,
    )).toThrow(CabReleaseBrokerError);
    expect(() => assertCabAdoRequestAllowed(
      request('https://dev.azure.com/Other/MaxView/_apis/git/repositories/MaxView/refs'),
      env,
    )).toThrow(/configured organization/);
  });

  it('rejects a wiki page outside Manual Release and a pipeline other than snow', () => {
    expect(() => assertCabAdoRequestAllowed(
      request('https://dev.azure.com/Amergis/MaxView/_apis/wiki/wikis/MaxView.wiki/pages?path=/Secret&api-version=7.1'),
      env,
    )).toThrow(/Manual Release/);
    expect(() => assertCabAdoRequestAllowed(
      request('https://dev.azure.com/Amergis/MaxView/_apis/pipelines/1/runs?api-version=7.1', 'POST', {}),
      env,
    )).toThrow(CabReleaseBrokerError);
  });

  it('allows a dry-run snow queue and refuses a ref update', () => {
    expect(() => assertCabAdoRequestAllowed(
      request('https://dev.azure.com/Amergis/MaxView/_apis/pipelines/670/runs?api-version=7.1', 'POST', {
        resources: { repositories: { self: { refName: 'refs/heads/tbi/55352-phase-3' } } },
        templateParameters: { releaseBranch: 'Release/2026.15.0', cabDescription: 'Y2Fi' },
      }),
      env,
    )).not.toThrow();

    expect(() => assertCabAdoRequestAllowed(
      request('https://dev.azure.com/Amergis/MaxView/_apis/git/repositories/MaxView/refs?api-version=7.1', 'POST', [
        { name: 'refs/heads/Release/2026.15.0', oldObjectId: 'a'.repeat(40), newObjectId: 'b'.repeat(40) },
      ]),
      env,
    )).toThrow(/cannot update an existing ref/);
  });

  it('rejects an unfiltered ref list, definition list, and build list', () => {
    expect(() => assertCabAdoRequestAllowed(
      request('https://dev.azure.com/Amergis/MaxView/_apis/git/repositories/MaxView/refs?api-version=7.1'),
      env,
    )).toThrow(/Release\/\{version\}/);
    expect(() => assertCabAdoRequestAllowed(
      request('https://dev.azure.com/Amergis/MaxView/_apis/build/definitions?api-version=7.1'),
      env,
    )).toThrow(/mv-prod-cd/);
    expect(() => assertCabAdoRequestAllowed(
      request('https://dev.azure.com/Amergis/MaxView/_apis/build/builds?api-version=7.1'),
      env,
    )).toThrow(/Release\/\{version\}/);
  });

  it('fails when the server has no PAT', async () => {
    await expect(forwardCabAdoRequest(
      request('https://dev.azure.com/Amergis/MaxView/_apis/git/repositories/MaxView/refs?filter=heads/development'),
      { ADO_ORG: env.ADO_ORG },
    )).rejects.toMatchObject({ status: 503, code: 'CAB_BROKER_UNAVAILABLE' });
  });
});
