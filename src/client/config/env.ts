import { z } from 'zod';

const envSchema = z.object({
  /** Pipe-separated team definitions: "Project|AreaPath~~~Project2|AreaPath2" */
  VITE_TEAMS: z.string().default('MaxView|MaxView'),
  /** Azure DevOps organization name */
  VITE_ADO_ORG: z.string().default('amergis'),
  /** Azure DevOps default project name */
  VITE_ADO_PROJECT: z.string().default('MaxView'),
  /** Work item poll interval in seconds */
  VITE_POLL_INTERVAL: z.coerce.number().int().positive().default(60),
});

function parseEnv() {
  const raw = {
    VITE_TEAMS: import.meta.env.VITE_TEAMS,
    VITE_ADO_ORG: import.meta.env.VITE_ADO_ORG,
    VITE_ADO_PROJECT: import.meta.env.VITE_ADO_PROJECT,
    VITE_POLL_INTERVAL: import.meta.env.VITE_POLL_INTERVAL,
  };

  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    console.error(`[env] Invalid environment variables:\n${issues}`);
  }

  // Return defaults on failure so the app can still start
  return result.success ? result.data : envSchema.parse({});
}

export const env = parseEnv();
