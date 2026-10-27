import { formatEnvIssues } from '@project-scope/config/format-env-issues';
import { z } from 'zod';

const PORT_MESSAGE = 'expected an integer from 1 to 65535';
const POSTGRES_URL_MESSAGE = 'expected a postgres or postgresql URL';
const NODE_ENV_MESSAGE = 'expected development, test, or production';
const LOG_LEVEL_MESSAGE =
  'expected fatal, error, warn, info, debug, trace, or silent';
const AUTH_MODE_MESSAGE = 'expected development or external';
const PRODUCTION_AUTH_MESSAGE =
  'development is not allowed when NODE_ENV is production';

const SECRET_NAMES = new Set(['DATABASE_URL']);

export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvValidationError';
  }
}

function unsetBlank(value: unknown): unknown {
  return value === '' ? undefined : value;
}

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
  } catch {
    return false;
  }
}

const portSchema = z.preprocess(
  unsetBlank,
  z.coerce
    .number({ error: PORT_MESSAGE })
    .int({ error: PORT_MESSAGE })
    .min(1, { error: PORT_MESSAGE })
    .max(65535, { error: PORT_MESSAGE })
    .default(3000)
);

const envObject = z.object({
  NODE_ENV: z.preprocess(
    unsetBlank,
    z.enum(['development', 'test', 'production'], { error: NODE_ENV_MESSAGE })
  ),
  PORT: portSchema,
  LOG_LEVEL: z.preprocess(
    unsetBlank,
    z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], {
        error: LOG_LEVEL_MESSAGE,
      })
      .default('info')
  ),
  DATABASE_URL: z.preprocess(
    unsetBlank,
    z
      .string({ error: POSTGRES_URL_MESSAGE })
      .refine(isPostgresUrl, { error: POSTGRES_URL_MESSAGE })
  ),
  AUTH_MODE: z.preprocess(
    unsetBlank,
    z.enum(['development', 'external'], { error: AUTH_MODE_MESSAGE })
  ),
});

export const envSchema = envObject.superRefine((value, ctx) => {
  if (value.NODE_ENV === 'production' && value.AUTH_MODE === 'development') {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_MODE'],
      message: PRODUCTION_AUTH_MESSAGE,
    });
  }
});

// Zod refuses pick() on a schema that already has a refinement. Migrations read
// only these two fields, so the production authentication check stays on envSchema.
export const databaseEnvSchema = envObject.pick({
  NODE_ENV: true,
  DATABASE_URL: true,
});

export const API_ENV_KEYS = Object.keys(envObject.shape).sort();

export type Env = z.infer<typeof envSchema>;
export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;

export function parseEnv(source: object): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      formatEnvIssues(result.error.issues, source, SECRET_NAMES)
    );
  }
  return result.data;
}

export function loadEnv(source: object = process.env): Env {
  try {
    return parseEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
