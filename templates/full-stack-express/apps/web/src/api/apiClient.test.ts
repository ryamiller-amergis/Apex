import {
  getMe as getMeRoute,
  putMe as putMeRoute,
} from '@project-scope/contracts';
import { describe, expect, it } from 'vitest';
import {
  problemBody,
  problemResponse,
  sampleProfile,
  SECRET_PROBLEM_DETAIL,
} from '../testing/profileFixture';
import { installFetch, jsonResponse } from '../testing/fetchMock';
import { ApiError } from './ApiError';
import { getMe, putMe } from './apiClient';

describe('api client', () => {
  it('VT-23 TBI-022 DoD-0 and DoD-2 returns parsed profile data from a relative URL', async () => {
    const calls = installFetch(() => jsonResponse(sampleProfile));

    const profile = await getMe();

    expect(profile).toEqual(sampleProfile);
    expect(getMeRoute.path).toBe('/api/v1/me');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/v1/me');
    expect(calls[0]?.url.includes('?')).toBe(false);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.accept).toBe('application/json');
  });

  it('VT-23 TBI-022 DoD-1 a Problem Details error throws ApiError with status and body', async () => {
    installFetch(() => problemResponse(500));

    const error = await getMe().then(
      () => {
        throw new Error('expected rejection');
      },
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.kind).toBe('problem');
    expect(apiError.status).toBe(500);
    expect(apiError.problem).toEqual(problemBody(500));
    expect(apiError.message).not.toContain(SECRET_PROBLEM_DETAIL);
    expect(apiError.isUnauthenticated).toBe(false);
  });

  it('VT-23 TBI-022 DoD-3 a 401 throws the unauthenticated error', async () => {
    installFetch(() => problemResponse(401));

    await expect(getMe()).rejects.toMatchObject({
      kind: 'unauthenticated',
      status: 401,
      isUnauthenticated: true,
    });
  });

  it('VT-23 TBI-022 DoD-2 a rejected fetch throws kind network', async () => {
    installFetch(() => Promise.reject(new TypeError('offline')));

    await expect(putMe(sampleProfile)).rejects.toMatchObject({
      kind: 'network',
      status: null,
      problem: null,
    });
  });

  it('VT-23 TBI-022 DoD-2 put sends JSON to the relative profile URL with only the two fields', async () => {
    const calls = installFetch(() => jsonResponse(sampleProfile));

    await putMe({ displayName: 'Ada Example', email: null });

    expect(putMeRoute.path).toBe('/api/v1/me');
    expect(calls[0]?.url).toBe('/api/v1/me');
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.accept).toBe('application/json');
    expect(calls[0]?.contentType).toBe('application/json');
    expect(calls[0]?.body).toEqual({
      displayName: 'Ada Example',
      email: null,
    });
    expect(Object.keys(calls[0]?.body as object).sort()).toEqual([
      'displayName',
      'email',
    ]);
  });

  it('VT-23 a missing email is sent as null', async () => {
    const calls = installFetch(() => jsonResponse(sampleProfile));

    await putMe({ displayName: 'Ada Example' });

    expect(calls[0]?.body).toEqual({
      displayName: 'Ada Example',
      email: null,
    });
  });

  it('VT-20 TBI-022 DoD-3 and NFR a 200 body that fails the shared schema throws invalid-response', async () => {
    installFetch(() =>
      jsonResponse({ displayName: 'Sam Example', email: 'sam@example.test' })
    );

    await expect(getMe()).rejects.toMatchObject({
      kind: 'invalid-response',
      status: 200,
      problem: null,
    });

    installFetch(() =>
      jsonResponse({
        displayName: 'Sam Example',
        email: 'sam@example.test',
        status: 12,
      })
    );
    await expect(getMe()).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('VT-23 a non-JSON error body is a problem with no parsed body', async () => {
    installFetch(
      () =>
        new Response('<html>proxy</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        })
    );

    await expect(getMe()).rejects.toMatchObject({
      kind: 'problem',
      status: 502,
      problem: null,
    });
  });
});
