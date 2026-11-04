import { formatEnvIssues } from '@project-scope/config/format-env-issues';
import { z } from 'zod';

const APP_NAME_MESSAGE = 'expected 1 to 60 characters';
const API_BASE_MESSAGE =
  'expected an empty value or an absolute http(s) URL with no trailing slash';
const NOT_WEB_MESSAGE = 'not a web build variable';
const PORT_MESSAGE = 'expected an integer from 1 to 65535';
const APP_NAME_DEFAULT = 'project-name';

export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvValidationError';
  }
}

function unsetBlank(value: unknown): unknown {
  return value === '' ? undefined : value;
}

function isApiBaseUrl(value: string): boolean {
  if (value === '') {
    return true;
  }
  if (value.endsWith('/')) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

type FormattableIssue = {
  path?: readonly PropertyKey[];
  message?: string;
  code?: string;
  keys?: readonly string[];
};

function issuesForFormat(issues: readonly FormattableIssue[]) {
  const rows: { path: PropertyKey[]; message: string }[] = [];
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys' && issue.keys) {
      for (const key of issue.keys) {
        rows.push({ path: [key], message: NOT_WEB_MESSAGE });
      }
      continue;
    }
    rows.push({
      path: [...(issue.path ?? [])],
      message: issue.message ?? 'invalid',
    });
  }
  return rows;
}

export const webEnvSchema = z.strictObject({
  VITE_APP_NAME: z.preprocess(
    unsetBlank,
    z
      .string({ error: APP_NAME_MESSAGE })
      .min(1, { error: APP_NAME_MESSAGE })
      .max(60, { error: APP_NAME_MESSAGE })
      .default(APP_NAME_DEFAULT)
  ),
  VITE_API_BASE_URL: z.preprocess(
    unsetBlank,
    z
      .string({ error: API_BASE_MESSAGE })
      .refine(isApiBaseUrl, { error: API_BASE_MESSAGE })
      .default('')
  ),
});

const devServerObject = z.object({
  PORT: z.preprocess(
    unsetBlank,
    z.coerce
      .number({ error: PORT_MESSAGE })
      .int({ error: PORT_MESSAGE })
      .min(1, { error: PORT_MESSAGE })
      .max(65535, { error: PORT_MESSAGE })
      .default(3000)
  ),
});

export const WEB_ENV_KEYS = Object.keys(webEnvSchema.shape).sort();

export type WebEnv = z.infer<typeof webEnvSchema>;
export type DevServerEnv = z.infer<typeof devServerObject>;

export function parseWebEnv(source: object): WebEnv {
  const result = webEnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      formatEnvIssues(issuesForFormat(result.error.issues), source, new Set())
    );
  }
  return result.data;
}

export function parseDevServerEnv(source: object): DevServerEnv {
  const record = source as Record<string, unknown>;
  const result = devServerObject.safeParse({ PORT: record.PORT });
  if (!result.success) {
    throw new EnvValidationError(
      formatEnvIssues(result.error.issues, source, new Set())
    );
  }
  return result.data;
}
