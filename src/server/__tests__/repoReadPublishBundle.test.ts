import { requestRepoReadBundlePublish } from '../services/brainstorm/gitSourceClone';
import { handlePublishBundleRequest } from '../services/repoRead/publishBundleHandler';

const SHA = 'a'.repeat(40);
const body = {
  provider: 'github',
  project: 'Apex',
  repository: 'octo/widgets',
  url: 'https://github.com/octo/widgets.git',
  sha: SHA,
};

describe('repo-read publish-bundle handler', () => {
  const signal = new AbortController().signal;

  it('rejects a malformed body, a non-HTTPS URL, and a private host before fetching', async () => {
    const publish = jest.fn();
    const lookup = jest.fn().mockResolvedValue(['140.82.112.3']);

    await expect(handlePublishBundleRequest({ ...body, sha: 'main' }, signal, { lookup, publish }))
      .resolves.toMatchObject({ status: 400 });
    await expect(handlePublishBundleRequest({ ...body, url: 'http://github.com/o/r' }, signal, { lookup, publish }))
      .resolves.toMatchObject({ status: 400 });
    lookup.mockResolvedValueOnce(['10.0.0.4']);
    await expect(handlePublishBundleRequest(body, signal, { lookup, publish }))
      .resolves.toMatchObject({ status: 400 });
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes the commit and reports a moved revision', async () => {
    const lookup = jest.fn().mockResolvedValue(['140.82.112.3']);
    const publish = jest.fn().mockResolvedValueOnce('ok').mockResolvedValueOnce('moved');

    await expect(handlePublishBundleRequest(body, signal, { lookup, publish }))
      .resolves.toEqual({ status: 200, body: { ok: true, state: 'ok' } });
    expect(publish).toHaveBeenCalledWith({
      url: 'https://github.com/octo/widgets.git',
      sha: SHA,
      identity: { provider: 'github', project: 'Apex', repository: 'octo/widgets' },
      signal,
    });
    await expect(handlePublishBundleRequest(body, signal, { lookup, publish }))
      .resolves.toEqual({ status: 200, body: { ok: true, state: 'moved' } });
  });

  it('hides the git error from the caller', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const lookup = jest.fn().mockResolvedValue(['140.82.112.3']);
    const publish = jest.fn().mockRejectedValue(new Error('fatal: https://user:pat@github.com denied'));

    const result = await handlePublishBundleRequest(body, signal, { lookup, publish });

    expect(result).toEqual({ status: 502, body: { ok: false, message: 'The repository could not be copied.' } });
  });
});

describe('requestRepoReadBundlePublish', () => {
  const input = {
    url: body.url,
    sha: SHA,
    identity: { provider: 'github' as const, project: 'Apex', repository: 'octo/widgets' },
  };

  it('posts the source to repo-read with the service token', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ status: 200, json: async () => ({ ok: true, state: 'ok' }) });

    await expect(requestRepoReadBundlePublish(input, {
      baseUrl: 'https://repo-read.internal/',
      authToken: 'token-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).resolves.toBe('ok');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://repo-read.internal/v1/publish-bundle');
    expect(init.headers.Authorization).toBe('Bearer token-1');
    expect(JSON.parse(init.body)).toEqual(body);
  });

  it('throws the service message on failure', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ status: 502, json: async () => ({ ok: false, message: 'The repository could not be copied.' }) })
      .mockResolvedValueOnce({ status: 404, json: async () => { throw new Error('not json'); } });
    const options = { baseUrl: 'https://repo-read.internal', authToken: 't', fetchImpl: fetchImpl as unknown as typeof fetch };

    await expect(requestRepoReadBundlePublish(input, options)).rejects.toThrow('The repository could not be copied.');
    await expect(requestRepoReadBundlePublish(input, options)).rejects.toThrow('returned 404');
  });
});
