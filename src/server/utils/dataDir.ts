/**
 * Shared utility for resolving the writable data root directory.
 *
 * Resolution order:
 *   1. AI_PILOT_DATA_DIR env var (explicit override — works locally and in cloud)
 *   2. Azure App Service detected (/home/site/wwwroot) → /home/data/ai-pilot
 *      (/home/data persists across restarts and is shared across scaled instances)
 *   3. Fallback → <cwd>/data (local development default)
 */
import path from 'path';

export function isAzureWwwroot(): boolean {
  const home = process.env.HOME;
  const cwd = process.cwd();
  return (
    cwd.startsWith('/home/site/wwwroot') ||
    Boolean(home && cwd.startsWith(path.join(home, 'site', 'wwwroot')))
  );
}

export function resolveDataRoot(): string {
  if (process.env.AI_PILOT_DATA_DIR) {
    return path.resolve(process.env.AI_PILOT_DATA_DIR);
  }
  if (isAzureWwwroot()) {
    return path.join('/home', 'data', 'ai-pilot');
  }
  return path.join(process.cwd(), 'data');
}
