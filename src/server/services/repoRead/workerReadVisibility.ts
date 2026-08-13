/**
 * Whether a background or interactive worker on this host can serve native
 * reads without a working-tree clone.
 *
 * App Service routers must not skip the clone when ACA workers cannot see
 * `repo-cache` and the HTTP read service is unset.
 */
export function workerCanReadWithoutWorkingTree(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.REPO_READ_SERVICE_URL?.trim())
    || !env.WEBSITE_INSTANCE_ID?.trim();
}
