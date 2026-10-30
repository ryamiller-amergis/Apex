import { finish, isDirect } from './cli.mjs';
import { runLicenseScan } from './scan-licenses.mjs';
import { runSecretScan } from './scan-secrets.mjs';
import { runVulnerabilityScan } from './scan-vulns.mjs';

export async function runScan(options = {}) {
  const secrets = await runSecretScan(options);
  const vulns = await runVulnerabilityScan(options);
  const licenses = await runLicenseScan(options);
  const exitCode = Math.max(
    secrets.exitCode,
    vulns.exitCode,
    licenses.exitCode
  );
  return {
    exitCode,
    lines: [...secrets.lines, ...vulns.lines, ...licenses.lines],
  };
}

if (isDirect(import.meta.url)) {
  finish(await runScan());
}
