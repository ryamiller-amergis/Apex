/**
 * @jest-environment node
 */

import { RepoReaderError } from '../services/repoReader';
import { RepoServiceReader } from '../services/repoRead/repoServiceReader';

const identity = {
  provider: 'ado' as const,
  project: 'Apex',
  repo: 'reader-fixture',
  sha: 'a'.repeat(40),
};

describe('RepoServiceReader', () => {
  it('posts read/list/search to the service and maps typed failures', async () => {
    const fetchImpl = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer test-token',
      });
      expect(body).toMatchObject(identity);
      if (url.endsWith('/v1/read')) {
        return new Response(JSON.stringify({
          ok: true,
          operation: 'read',
          content: 'fixture\n',
        }), { status: 200 });
      }
      if (url.endsWith('/v1/list')) {
        return new Response(JSON.stringify({
          ok: true,
          operation: 'list',
          entries: [{ path: '/src', name: 'src', isFolder: true }],
        }), { status: 200 });
      }
      if (url.endsWith('/v1/search')) {
        return new Response(JSON.stringify({
          ok: false,
          code: 'ACCESS_DENIED',
          message: 'Repository path access denied',
          fallbackEligible: false,
        }), { status: 403 });
      }
      return new Response('missing', { status: 404 });
    });

    const reader = new RepoServiceReader({
      identity,
      baseUrl: 'https://repo-read.test',
      authToken: 'test-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(reader.readFile('README.md')).resolves.toBe('fixture\n');
    await expect(reader.listDir('')).resolves.toEqual([
      { path: '/src', name: 'src', isFolder: true },
    ]);
    await expect(reader.searchCode('needle')).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    expect(RepoReaderError).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('throws LOCAL_READ_UNAVAILABLE when the service URL is missing', () => {
    expect(
      () => new RepoServiceReader({ identity, baseUrl: '' }),
    ).toThrow(RepoReaderError);
  });
});
