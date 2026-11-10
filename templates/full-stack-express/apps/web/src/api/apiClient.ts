import {
  analyzeInsights as analyzeInsightsRoute,
  createNotification as createNotificationRoute,
  getMe as getMeRoute,
  getNotifications as getNotificationsRoute,
  markNotificationsRead as markNotificationsReadRoute,
  problemDetailsSchema,
  putMe as putMeRoute,
  type AnalyzeInsightsBody,
  type CreateNotificationBody,
  type InsightsAnalysis,
  type MarkNotificationReadBody,
  type NotificationsList,
  type ProblemDetails,
  type Profile,
  type UpdateProfileBody,
} from '@project-scope/contracts';
import type { ZodType } from 'zod';
import { webEnv } from '../config/env';
import { ApiError } from './ApiError';
import {
  createPreviewNotification,
  markPreviewNotificationsRead,
  readPreviewNotifications,
  readPreviewProfile,
  runPreviewInsightsAnalysis,
  writePreviewProfile,
} from './previewSampleStore';

function isPreviewSampleMode(): boolean {
  return webEnv.VITE_APEX_PREVIEW_MODE === 'sample';
}

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

async function request<T>(
  path: string,
  schema: ZodType<T>,
  init: RequestInit
): Promise<T> {
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
  if (isPreviewSampleMode()) {
    return Promise.resolve(readPreviewProfile());
  }
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
  if (isPreviewSampleMode()) {
    return Promise.resolve(writePreviewProfile(body));
  }
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

export function getNotifications(): Promise<NotificationsList> {
  if (isPreviewSampleMode()) {
    return Promise.resolve(readPreviewNotifications());
  }
  return request(
    getNotificationsRoute.path,
    getNotificationsRoute.responses[200].body,
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
    }
  );
}

export function postNotification(
  body: CreateNotificationBody
): Promise<NotificationsList> {
  if (isPreviewSampleMode()) {
    return Promise.resolve(createPreviewNotification(body));
  }
  return request(
    createNotificationRoute.path,
    createNotificationRoute.responses[200].body,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
}

export function putNotificationsRead(
  body: MarkNotificationReadBody
): Promise<NotificationsList> {
  if (isPreviewSampleMode()) {
    return Promise.resolve(markPreviewNotificationsRead(body));
  }
  return request(
    markNotificationsReadRoute.path,
    markNotificationsReadRoute.responses[200].body,
    {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
}

export function postAnalyzeInsights(
  body: AnalyzeInsightsBody = {}
): Promise<InsightsAnalysis> {
  if (isPreviewSampleMode()) {
    return Promise.resolve(runPreviewInsightsAnalysis(body));
  }
  return request(
    analyzeInsightsRoute.path,
    analyzeInsightsRoute.responses[200].body,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
}
