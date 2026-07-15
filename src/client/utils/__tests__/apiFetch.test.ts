import { apiFetch } from '../apiFetch';

describe('apiFetch', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  it('accepts a successful 201 response with an empty body', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers(),
      text: () => Promise.resolve(''),
    }) as jest.Mock;

    await expect(apiFetch<void>('/api/admin/users/user-1/roles')).resolves.toBeUndefined();
  });

  it('parses a successful JSON response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => Promise.resolve('{"ok":true}'),
    }) as jest.Mock;

    await expect(apiFetch<{ ok: boolean }>('/api/test')).resolves.toEqual({ ok: true });
  });
});
