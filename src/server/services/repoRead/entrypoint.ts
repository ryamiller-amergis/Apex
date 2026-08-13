/**
 * Stage 3 repo-read service host. Serves BareRepoReader over HTTP from a
 * Container App's ephemeral disk. Local development keeps using in-process
 * BareRepoReader when REPO_READ_SERVICE_URL is unset.
 */
import express from 'express';
import { requireAiRunnerAuth } from '../../middleware/aiRunnerAuth';
import type { RepositoryIdentity } from '../../../shared/types/repoReader';
import { BareRepoReader } from './bareRepoReader';
import { handleRepoReadRequest } from './httpHandler';
import type { RepoReadOperation } from './httpProtocol';
import { getRepoCacheDir } from '../repoCacheService';

const DEFAULT_PORT = 8080;

async function readerFor(identity: RepositoryIdentity): Promise<BareRepoReader> {
  const cacheDir = getRepoCacheDir({
    provider: identity.provider,
    project: identity.project,
    repo: identity.repo,
    branch: 'main',
  });
  return new BareRepoReader({
    identity,
    mirrorPath: cacheDir,
    telemetryContext: {
      caller: 'repo-read-service',
      project: identity.project,
    },
  });
}

export function createRepoReadApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  const operations: RepoReadOperation[] = ['read', 'list', 'search'];
  for (const operation of operations) {
    app.post(`/v1/${operation}`, requireAiRunnerAuth, (req, res, next) => {
      void handleRepoReadRequest(operation, req.body, { readerFor })
        .then((result) => {
          res.status(result.status).json(result.body);
        })
        .catch(next);
    });
  }
  return app;
}

async function main(): Promise<void> {
  const port = Number.parseInt(
    process.env.REPO_READ_SERVICE_PORT?.trim()
      || process.env.PORT?.trim()
      || String(DEFAULT_PORT),
    10,
  );
  const app = createRepoReadApp();
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => resolve());
    server.on('error', reject);
  });
  console.log(
    JSON.stringify({
      event: 'RepoReadServiceStarted',
      serverPort: port,
    }),
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        event: 'RepoReadServiceFatal',
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  });
}
