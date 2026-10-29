import path from 'node:path';
import { fileURLToPath } from 'node:url';

const supplyChainDir = path.dirname(fileURLToPath(import.meta.url));

export const templateRoot = path.resolve(supplyChainDir, '..', '..');

/** Placeholder service name from the template README. */
export const serviceName = 'project-service';

export const imageTag = `${serviceName}:local`;

/** Default listen port from the API schema. The image does not set PORT. */
export const listenPort = 3000;

/** Runtime path of the built web client. The API reads CLIENT_DIST_DIR. */
export const clientDistDir = '/app/web';

export const runtimeUserId = '10001';

export const sbomDirectory = path.join(templateRoot, 'artifacts', 'sbom');

export const exceptionsFile = path.join(
  templateRoot,
  'config',
  'supply-chain',
  'vulnerability-exceptions.json'
);

export const allowedLicensesFile = path.join(
  templateRoot,
  'config',
  'supply-chain',
  'allowed-licenses.json'
);

export const secretlintConfigFile = path.join(
  templateRoot,
  'config',
  'supply-chain',
  '.secretlintrc.json'
);

export const EXIT_CLEAN = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_CANNOT_RUN = 2;

export const productionPackages = ['@project-scope/api', '@project-scope/web'];

/**
 * Image digest for node:24-bookworm-slim on 2026-10-27.
 * The same digest is node:24.22.1-bookworm-slim.
 */
export const nodeImage =
  'node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205';
