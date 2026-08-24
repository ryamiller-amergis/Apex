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
import { listSkillConfigsForProject } from '../projectSettingsService';
import {
  ensureRepoCache,
  getRepoCacheDir,
} from '../repoCacheService';
import { flushTelemetry, trackEvent } from '../telemetry';
import { BareRepoReader } from './bareRepoReader';
import { handleRepoReadRequest } from './httpHandler';
import type { RepoReadOperation } from './httpProtocol';
import {
  hydrateRepoReadMirror,
  kickBackgroundMirrorRefresh,
} from './mirrorHydration';
import { isUsableBareMirror } from './mirrorStore';

const DEFAULT_PORT = 8080;
const MIRROR_PROBE_TIMEOUT_MS = 10_000;

// Used only when project settings cannot be reached. Projects configure their
// own root branch, so assuming one repository's convention breaks the others.
const FALLBACK_BRANCH = process.env.REPO_READ_SERVICE_BRANCH?.trim() || 'main';

const bundleStore = createGroundingBundleStore({
  repairAndMaterialize: async () => false,
});

// Concurrent requests for the same repo must not each clone it.
const hydrations = new Map<string, Promise<string>>();

// skillRepo is stored as `repo`, `project/repo`, or `org/repo` depending on
// provider, while a read identity carries the bare name.
function repoName(value: string): string {
  return value.trim().toLowerCase().split('/').filter(Boolean).pop() ?? '';
}

/**
 * Read requests carry no branch, but a mirror fetch verifies
 * `refs/heads/<branch>`. The project's configured root branch is the only
 * authority for that.
 */
export async function resolveBranch(
  identity: RepositoryIdentity,
  listConfigs = listSkillConfigsForProject
): Promise<string> {
  try {
    const configs = await listConfigs(identity.project);
    const wanted = repoName(identity.repo);
    // Configs come back default-first, so an unmatched repo still resolves.
    const match =
      configs.find((config) => repoName(config.skillRepo) === wanted) ??
      configs[0];
    const branch = match?.skillBranch?.trim();
    if (branch) return branch;
  } catch {
    // Serving with a guess beats refusing to serve at all.
  }
  return FALLBACK_BRANCH;
}

async function mirrorHasCommit(
  mirrorPath: string,
  sha: string
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
 * backstop for a SHA that was never published. A warm mirror missing this pin
 * is fetched in the background — chat must not await or abort that fetch.
 */
async function hydrateMirror(identity: RepositoryIdentity): Promise<string> {
  return hydrateRepoReadMirror(identity, {
    getRepoCacheDir,
    isUsableBareMirror,
    mirrorHasCommit,
    resolveBranch,
    rehydrateBare: (id, destination) =>
      bundleStore.rehydrateBare(id, destination),
    ensureRepoCache,
    kickBackgroundRefresh: kickBackgroundMirrorRefresh,
  });
}

async function readerFor(
  identity: RepositoryIdentity
): Promise<BareRepoReader> {
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

// Git errors can echo a remote URL carrying a PAT, and this event bypasses the
// grounding sanitizer, so credentials are stripped at the point of capture.
function redactCredentials(message: string): string {
  return message.replace(/\/\/[^/@\s]+@/g, '//***@').slice(0, 300);
}

export interface LifecycleDiagnosticsDeps {
  startedAt?: number;
  emit?: typeof trackEvent;
  flush?: typeof flushTelemetry;
  exit?: (code: number) => void;
  inFlight?: () => number;
  rssBytes?: () => number;
}

/**
 * This container gets restarted often enough that the cause matters, and from
 * the outside the causes are indistinguishable: a failed health probe arrives as
 * SIGTERM, a bug arrives as an uncaught error, and an OOM arrives as SIGKILL,
 * which by definition no handler can observe. Recording the first two is what
 * makes the third identifiable — a disappearance with no event preceding it.
 *
 * RSS is read here rather than trusted from platform metrics, which sample once
 * a minute and so miss the spike immediately before a kill.
 */
export function installLifecycleDiagnostics(
  deps: LifecycleDiagnosticsDeps = {}
): void {
  const startedAt = deps.startedAt ?? Date.now();
  const emit = deps.emit ?? trackEvent;
  const flush = deps.flush ?? flushTelemetry;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const inFlight = deps.inFlight ?? (() => hydrations.size);
  const rssBytes = deps.rssBytes ?? (() => process.memoryUsage().rss);

  const report = async (reason: string, error?: unknown): Promise<void> => {
    const properties: Record<string, string> = {
      reason,
      rssMb: String(Math.round(rssBytes() / 1_048_576)),
      // A hydration or search in flight at exit is the link between the kill and
      // the request that provoked it.
      inFlightHydrations: String(inFlight()),
      uptimeSeconds: String(Math.round((Date.now() - startedAt) / 1000)),
    };
    if (error !== undefined) {
      properties.errorName = error instanceof Error ? error.name : typeof error;
      properties.errorMessage = redactCredentials(
        error instanceof Error ? error.message : String(error)
      );
    }
    emit('RepoReadServiceExit', properties);
    console.error(
      JSON.stringify({ event: 'RepoReadServiceExit', ...properties })
    );
    await flush();
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void report(signal).then(() => exit(0));
    });
  }
  process.once('uncaughtException', (error) => {
    void report('uncaughtException', error).then(() => exit(1));
  });
  process.once('unhandledRejection', (reason) => {
    void report('unhandledRejection', reason).then(() => exit(1));
  });
}

async function main(): Promise<void> {
  installLifecycleDiagnostics();

  const port = Number.parseInt(
    process.env.REPO_READ_SERVICE_PORT?.trim() ||
      process.env.PORT?.trim() ||
      String(DEFAULT_PORT),
    10
  );
  const app = createRepoReadApp();
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => resolve());
    server.on('error', reject);
  });
  // Paired with RepoReadServiceExit so a restart is one query rather than a
  // correlation against platform events that arrive minutes late.
  trackEvent('RepoReadServiceStarted', { serverPort: String(port) });
  console.log(
    JSON.stringify({
      event: 'RepoReadServiceStarted',
      serverPort: port,
    })
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        event: 'RepoReadServiceFatal',
        errorMessage: error instanceof Error ? error.message : String(error),
      })
    );
    process.exitCode = 1;
  });
}
