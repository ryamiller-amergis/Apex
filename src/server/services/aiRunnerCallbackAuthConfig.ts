export const AI_RUNS_ALLOW_STATIC_CALLBACK_TOKEN_ENV =
  'AI_RUNS_ALLOW_STATIC_CALLBACK_TOKEN';

/**
 * Static runner callback auth is local/test-only unless an operator explicitly
 * enables the short-term bridge for a non-production environment whose runtime
 * still uses NODE_ENV=production.
 */
export function resolveStaticAiRunnerCallbackToken(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const allowed =
    env.NODE_ENV !== 'production'
    || env[AI_RUNS_ALLOW_STATIC_CALLBACK_TOKEN_ENV]?.trim().toLowerCase() === 'true';
  if (!allowed) return undefined;
  return env.AI_RUNS_RUNNER_CALLBACK_TOKEN?.trim() || undefined;
}
