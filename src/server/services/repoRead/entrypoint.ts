/**
 * Stage 3 repo-read service host. Serves BareRepoReader over HTTP from a
 * Container App's ephemeral disk. Local development keeps using in-process
 * BareRepoReader when REPO_READ_SERVICE_URL is unset.
 */
import express from 'express';
import { requireAiRunnerAuth } from '../../middleware/aiRunnerAuth';
import type { RepositoryIdentity } from '../../../shared/types/repoReader';
import { git, safeArgs } from '../../utils/asyncGit';
import { createGroundingBundleStore } from '../grounding/bundleStoreService';
import {
  ensureRepoCache,
  getRepoCacheDir,
  type RepoCacheOptions,
} from '../repoCacheService';
import { BareRepoReader } from './bareRepoReader';
import { handleRepoReadRequest } from './httpHandler';
import type { RepoReadOperation } from './httpProtocol';
import { isUsableBareMirror } from './mirrorStore';

const DEFAULT_PORT = 8080;
const MIRROR_PROBE_TIMEOUT_MS = 10_000;

// Read requests address objects by SHA and carry no branch. The branch only
// tells the remote-clone fallback which head to track.
const FALLBACK_BRANCH = process.env.REPO_READ_SERVICE_BRANCH?.trim() || 'main';

const bundleStore = createGroundingBundleStore({
  repairAndMaterialize: async () => false,
});

// Concurrent requests for the same repo must not each clone it.
const hydrations = new Map<string, Promise<string>>();

function cacheOptionsFor(identity: RepositoryIdentity): RepoCacheOptions {
  return {
    provider: identity.provider,
    project: identity.project,
    repo: identity.repo,
    branch: FALLBACK_BRANCH,
  };
}

async function mirrorHasCommit(
  mirrorPath: string,
  sha: string,
): Promise<boolean> {
  if (!isUsableBareMirror(mirrorPath)) return false;
  try {
    await git(safeArgs(mirrorPath, ['cat-file', '-e', `${sha}^{commit}`]), {
      cwd: mirrorPath,
      timeout: MIRROR_PROBE_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Container disk is ephemeral, so a cold replica starts with no mirror at all.
 * Restoring the published bundle is the fast path; cloning the remote is the
 * backstop for a SHA that was never published.
 */
async function hydrateMirror(identity: RepositoryIdentity): Promise<string> {
  const options = cacheOptionsFor(identity);
  const cacheDir = getRepoCacheDir(options);

  if (await mirrorHasCommit(cacheDir, identity.sha)) return cacheDir;

  // A mirror that merely predates this SHA needs a fetch, not a re-download —
  // restoring the bundle would delete it first.
  if (isUsableBareMirror(cacheDir)) {
    const refreshed = await ensureRepoCache(options);
    if (await mirrorHasCommit(refreshed.cacheDir, identity.sha)) {
      return refreshed.cacheDir;
    }
  }

  const restored = await bundleStore.rehydrateBare(identity, cacheDir);
  if (restored.status === 'materialized') return cacheDir;

  const cloned = await ensureRepoCache(options);
  return cloned.cacheDir;
}

async function readerFor(identity: RepositoryIdentity): Promise<BareRepoReader> {
  const key = [
    identity.provider,
    identity.project,
    identity.repo,
    identity.sha,
  ].join('/');
  let inFlight = hydrations.get(key);
  if (!inFlight) {
    inFlight = hydrateMirror(identity).finally(() => hydrations.delete(key));
    hydrations.set(key, inFlight);
  }

  return new BareRepoReader({
    identity,
    mirrorPath: await inFlight,
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
