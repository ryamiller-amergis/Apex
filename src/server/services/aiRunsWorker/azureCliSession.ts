/**
 * The investigation skill runs `az` itself. The worker image installs the CLI and carries the
 * insights-reader identity, but a fresh container has no CLI session, so the first command
 * reports that Azure is not logged in.
 */
import { execFile } from 'node:child_process';

const LOGIN_TIMEOUT_MS = 60_000;

function runAz(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('az', args, { timeout: LOGIN_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }
      const detail = stderr.trim().replace(/\s+/g, ' ').slice(0, 300);
      reject(new Error(detail || 'Azure CLI could not sign in with the insights reader identity.'));
    });
  });
}

export async function ensureInsightsAzureLogin(
  run: (args: string[]) => Promise<void> = runAz,
): Promise<void> {
  const clientId = process.env.AZURE_INSIGHTS_CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error(
      'AZURE_INSIGHTS_CLIENT_ID is not set, so Azure CLI cannot sign in.',
    );
  }
  await run(['login', '--identity', '--client-id', clientId, '--output', 'none']);
}
