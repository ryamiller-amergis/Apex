import {
  getMe as getMeRoute,
  problemDetailsSchema,
  putMe as putMeRoute,
  type ProblemDetails,
  type Profile,
  type UpdateProfileBody,
} from '@project-scope/contracts';
import type { ZodType } from 'zod';
import { ApiError } from './ApiError';

async function readProblem(response: Response): Promise<ProblemDetails | null> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (text.trim() === '') {
    return null;
  }
  try {
    const parsed = problemDetailsSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function request(
  path: string,
  schema: ZodType<Profile>,
  init: RequestInit
): Promise<Profile> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError({ kind: 'network', status: null, problem: null });
  }

  if (response.status === 401) {
    throw new ApiError({
      kind: 'unauthenticated',
      status: 401,
      problem: await readProblem(response),
    });
  }

  if (!response.ok) {
    throw new ApiError({
      kind: 'problem',
      status: response.status,
      problem: await readProblem(response),
    });
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ApiError({
      kind: 'invalid-response',
      status: response.status,
      problem: null,
    });
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError({
      kind: 'invalid-response',
      status: response.status,
      problem: null,
    });
  }
  return parsed.data;
}

/** Reads the caller's profile. The URL is the contract path, with no query. */
export function getMe(): Promise<Profile> {
  return request(getMeRoute.path, getMeRoute.responses[200].body, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
}

/**
 * Replaces the caller's display name and email. A missing email is sent as
 * `null`, which is the wire value the profile API already accepts for a clear.
 */
export function putMe(body: UpdateProfileBody): Promise<Profile> {
  const payload = {
    displayName: body.displayName,
    email: body.email ?? null,
  };
  return request(putMeRoute.path, putMeRoute.responses[200].body, {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}
