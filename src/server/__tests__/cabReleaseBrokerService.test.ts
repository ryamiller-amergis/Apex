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

  it('allows a read of the parent wiki page and refuses a write of it', () => {
    expect(() => assertCabAdoRequestAllowed(
      request('https://dev.azure.com/Amergis/MaxView/_apis/wiki/wikis/MaxView.wiki/pages?path=/Manual%20Release&api-version=7.1'),
      env,
    )).not.toThrow();

    expect(() => assertCabAdoRequestAllowed(
      request('https://dev.azure.com/Amergis/MaxView/_apis/wiki/wikis/MaxView.wiki/pages?path=/Manual%20Release&api-version=7.1', 'PUT', {
        content: '# overwritten',
      }),
      env,
    )).toThrow(/Wiki writes are limited/);

    expect(() => assertCabAdoRequestAllowed(
      request('https://dev.azure.com/Amergis/MaxView/_apis/wiki/wikis/MaxView.wiki/pages?path=/Manual%20Release/2026.15.0&api-version=7.1', 'PUT', {
        content: '# 2026.15.0',
      }),
      env,
    )).not.toThrow();
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

  it('refuses a build log until the build is mv-prod-cd on a release branch', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      if (String(url).includes('/builds/99?')) {
        return new Response(JSON.stringify({
          id: 99,
          sourceBranch: 'refs/heads/feature/secret',
          definition: { name: 'some-other-pipeline' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('pipeline secret', { status: 200 });
    });

    await expect(forwardCabAdoRequest(
      request('https://dev.azure.com/Amergis/MaxView/_apis/build/builds/99/logs/1'),
      env,
      fetchImpl as unknown as typeof fetch,
    )).rejects.toMatchObject({ status: 403, code: 'CAB_BROKER_FORBIDDEN' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('forwards an mv-prod-cd build log on a release branch', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      if (String(url).includes('/builds/42?')) {
        return new Response(JSON.stringify({
          id: 42,
          sourceBranch: 'refs/heads/Release/2026.15.0',
          definition: { name: 'mv-prod-cd' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('build log', { status: 200, headers: { 'content-type': 'text/plain' } });
    });

    const result = await forwardCabAdoRequest(
      request('https://dev.azure.com/Amergis/MaxView/_apis/build/builds/42/logs/3'),
      env,
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.status).toBe(200);
    expect(result.body).toBe('build log');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('forwards a snow pipeline build and its log on the payload branch', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      if (String(url).includes('/builds/129216?')) {
        return new Response(JSON.stringify({
          id: 129216,
          status: 'inProgress',
          sourceBranch: 'refs/heads/development',
          definition: { id: 670, name: 'SNOW - Create CAB Request - Test' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('Created ServiceNow Change: CHG0033999', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    });

    const status = await forwardCabAdoRequest(
      request('https://dev.azure.com/Amergis/MaxView/_apis/build/builds/129216'),
      env,
      fetchImpl as unknown as typeof fetch,
    );
    const log = await forwardCabAdoRequest(
      request('https://dev.azure.com/Amergis/MaxView/_apis/build/builds/129216/logs/4'),
      env,
      fetchImpl as unknown as typeof fetch,
    );

    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ definition: { id: 670 } });
    expect(log.body).toContain('CHG0033999');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('fails when the server has no PAT', async () => {
    await expect(forwardCabAdoRequest(
      request('https://dev.azure.com/Amergis/MaxView/_apis/git/repositories/MaxView/refs?filter=heads/development'),
      { ADO_ORG: env.ADO_ORG },
    )).rejects.toMatchObject({ status: 503, code: 'CAB_BROKER_UNAVAILABLE' });
  });
});
