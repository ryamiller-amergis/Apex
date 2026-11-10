import { exec, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import pg from 'pg';

import { createLocalBrowserEvidenceStore } from '../../src/server/services/build/buildPreviewBrowserEvidenceStore';
import { createBuildPreviewBrowserVerifier } from '../../src/server/services/build/buildPreviewBrowserVerifier';
import { createDockerPostgresSandboxDataProvider } from '../../src/server/services/build/dockerPostgresSandboxDataProvider';
import {
  createDockerCommandRunner,
  createDockerPreviewResourceStore,
  dockerResourceName,
} from '../../src/server/services/build/dockerPreviewRuntime';
import { createDockerSandboxProvider } from '../../src/server/services/build/dockerSandboxProvider';
import { createGoldenStackPreviewJourneyRunner } from '../../src/server/services/build/goldenStackPreviewJourneyRunner';
import { createLocalBuildPreviewWalkingSkeleton } from '../../src/server/services/build/buildPreviewLocalWalkingSkeleton';
import {
  createScratchDatabase,
  type ScratchDatabase,
} from './support/scratch-db';

const enabled =
  process.env.RUN_DOCKER_PREVIEW_WALKING_SKELETON_INTEGRATION === '1';
const describeDocker = enabled ? describe : describe.skip;
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(__dirname, '../..');
const templateRoot = path.join(
  repositoryRoot,
  'templates',
  'full-stack-express'
);
const bundlePath = path.join(
  templateRoot,
  'artifacts',
  'preview',
  'apex-preview-runtime.tar'
);
const runnerImage = 'apex/full-stack-express-preview-runner:1.0.0';
const commit = 'a'.repeat(40);

describeDocker('local preview walking skeleton', () => {
  jest.setTimeout(10 * 60_000);

  let scratch: ScratchDatabase;
  let client: pg.Client;
  let pool: { end(): Promise<void> } | null = null;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.OTEL_SDK_DISABLED = 'true';
    scratch = await createScratchDatabase('previewwalk');
    process.env.DATABASE_URL = scratch.connectionString;
    client = new pg.Client({ connectionString: scratch.connectionString });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.end();
    if (pool) await pool.end();
    if (scratch) await scratch.drop();
  });

  it('blocks then reaches preview_ready for the same persisted revision', async () => {
    if (process.env.REUSE_DOCKER_PREVIEW_ASSETS !== '1') {
      await execAsync('corepack pnpm build', {
        cwd: templateRoot,
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
      });
      await execFileAsync(
        'node',
        ['scripts/preview/build-runtime-bundle.mjs'],
        {
          cwd: templateRoot,
          windowsHide: true,
        }
      );
      await execFileAsync(
        'docker',
        ['build', '--file', 'Dockerfile.preview', '--tag', runnerImage, '.'],
        {
          cwd: templateRoot,
          windowsHide: true,
          timeout: 8 * 60_000,
          maxBuffer: 50 * 1024 * 1024,
        }
      );
    }

    const [
      { createDrizzleLocalPreviewInstanceStore },
      browserRepository,
      completionStore,
      deploymentModule,
      dbModule,
    ] = await Promise.all([
      import('../../src/server/services/build/buildPreviewLocalInstanceStore'),
      import('../../src/server/services/build/buildPreviewBrowserCheckRepository'),
      import('../../src/server/services/build/buildPreviewCompletionStore'),
      import('../../src/server/services/buildDeploymentService'),
      import('../../src/server/db'),
    ]);
    pool = dbModule.default;

    const userId = `preview-walk-${randomUUID()}`;
    const runId = randomUUID();
    const revisionId = randomUUID();
    const pipelineRunId = `local-preview:${revisionId}`;
    const project = `Preview Walk ${randomUUID()}`;
    const repository = 'full-stack-express';
    await client.query(
      `INSERT INTO app_users (oid, display_name)
       VALUES ($1, 'Preview Walking Skeleton')`,
      [userId]
    );
    await client.query(
      `INSERT INTO build_runs (
         id, project, repository, requested_by_user_id, client_request_id,
         prompt, status, skill_snapshot, support_contacts,
         quality_manifest_snapshot, cost_cap_usd, elapsed_cap_seconds,
         parallelism_cap
       ) VALUES (
         $1, $2, $3, $4, $5, 'Build a real full-stack preview', 'deploying',
         '{"model":"test"}'::jsonb,
         $6::jsonb,
         '{"typeCheck":"tsc","lint":"eslint","relatedTests":"jest","unitSuite":"jest"}'::jsonb,
         25, 14400, 2
       )`,
      [
        runId,
        project,
        repository,
        userId,
        `preview-walk-${randomUUID()}`,
        JSON.stringify([
          {
            userId,
            displayName: 'Preview Walking Skeleton',
            email: 'preview@example.test',
          },
        ]),
      ]
    );
    await client.query(
      `INSERT INTO build_revisions (
         id, build_run_id, revision_number, validated_commit,
         preview_rollout_mode, pipeline_run_id, deployment_status,
         deployment_queued_at
       ) VALUES ($1, $2, 1, $3, 'live', $4, 'deploying', now())`,
      [revisionId, runId, commit, pipelineRunId]
    );
    await client.query(
      `INSERT INTO build_preview_leases (
         project, repository, build_run_id, build_revision_id, expires_at
       ) VALUES ($1, $2, $3, $4, now() + interval '2 hours')`,
      [project, repository, runId, revisionId]
    );

    const deployment = deploymentModule.defaultBuildDeploymentService;
    const blocked = await deployment.settleFromCallback({
      pipelineRunId,
      commit,
      status: 'succeeded',
      previewUrl: 'http://127.0.0.1:1',
    });
    expect(blocked).toEqual({
      kind: 'ok',
      response: {
        applied: false,
        reason: 'preview_evidence_pending',
      },
    });
    await expect(
      client.query<{ status: string }>(
        'SELECT status FROM build_runs WHERE id = $1',
        [runId]
      )
    ).resolves.toMatchObject({
      rows: [{ status: 'deploying' }],
    });

    const bundle = await readFile(bundlePath);
    const digest = `sha256:${createHash('sha256')
      .update(bundle)
      .digest('hex')}`;
    const evidenceRoot = await mkdtemp(
      path.join(os.tmpdir(), 'preview-walking-evidence-')
    );
    const docker = createDockerCommandRunner({ timeoutMs: 180_000 });
    const resources = createDockerPreviewResourceStore();
    const resolveRuntimeBundle = async (requestedDigest: string) => {
      if (requestedDigest !== digest) {
        throw new Error(`Unknown runtime bundle ${requestedDigest}.`);
      }
      return { path: bundlePath, digest };
    };
    const data = createDockerPostgresSandboxDataProvider({
      docker,
      resources,
      postgresImage: 'postgres:16',
      previewRunnerImage: runnerImage,
      resolveRuntimeBundle,
    });
    const sandbox = createDockerSandboxProvider({
      docker,
      resources,
      previewRunnerImage: runnerImage,
      resolveRuntimeBundle,
    });
    let instanceId: string | null = null;

    try {
      const browserVerifier = createBuildPreviewBrowserVerifier({
        repository: browserRepository.createDrizzleBrowserCheckRepository(),
        evidence: createLocalBrowserEvidenceStore({ root: evidenceRoot }),
        runner: createGoldenStackPreviewJourneyRunner(),
      });
      const instanceStore = createDrizzleLocalPreviewInstanceStore();
      const walkingSkeleton = createLocalBuildPreviewWalkingSkeleton({
        store: instanceStore,
        data,
        sandbox,
        browserVerifier,
        settlePreview: async (request) => {
          const settled = await deployment.settleFromCallback(request);
          if (settled.kind !== 'ok') {
            throw new Error(`Unexpected settlement result ${settled.kind}.`);
          }
          expect(settled.response).toEqual({ applied: true });
          return settled.response;
        },
      });
      const walkingInput = {
        buildRunId: runId,
        revisionId,
        revisionNumber: 1,
        commit,
        templateVersion: '1.0.0',
        runtimeBundle: {
          digest,
          sizeBytes: bundle.length,
          blobRef: {
            container: 'local-preview-runtime',
            key: `${revisionId}/runtime.tar`,
          },
        },
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        pipelineRunId,
      };
      const outcome = await walkingSkeleton.run(walkingInput);
      expect(outcome).toMatchObject({
        kind: 'preview_ready',
        browserCheckId: expect.any(String),
        previewUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      });
      instanceId = outcome.instanceId;
      await expect(walkingSkeleton.run(walkingInput)).rejects.toThrow(
        'A local preview instance can only start for a deploying revision.'
      );

      const completion =
        await completionStore.defaultBuildPreviewCompletionPort.loadGate({
          revisionId,
          project,
          repository,
        });
      expect(completion).toMatchObject({
        mode: 'live',
        evidence: {
          revisionId,
          validatedCommit: commit,
          artifact: { commit, digest },
          instance: {
            id: instanceId,
            state: 'ready',
            artifactDigest: digest,
          },
          readiness: {
            status: 'passed',
            instanceId,
          },
          browserCheck: {
            status: 'passed',
            instanceId,
            artifactDigest: digest,
          },
        },
      });

      const state = await client.query<{
        run_status: string;
        deployment_status: string;
        instance_state: string;
        readiness_status: string;
        browser_status: string;
      }>(
        `SELECT
           run.status AS run_status,
           revision.deployment_status,
           instance.state AS instance_state,
           instance.readiness_status,
           browser_check.status AS browser_status
         FROM build_runs run
         JOIN build_revisions revision ON revision.build_run_id = run.id
         JOIN build_preview_artifacts artifact
           ON artifact.build_revision_id = revision.id
         JOIN build_preview_instances instance
           ON instance.build_preview_artifact_id = artifact.id
         JOIN build_preview_browser_checks browser_check
           ON browser_check.build_preview_instance_id = instance.id
         WHERE run.id = $1`,
        [runId]
      );
      expect(state.rows).toEqual([
        {
          run_status: 'preview_ready',
          deployment_status: 'succeeded',
          instance_state: 'ready',
          readiness_status: 'passed',
          browser_status: 'passed',
        },
      ]);
      const blockedEvents = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM build_events
         WHERE build_run_id = $1
           AND event_type = 'preview_completion_blocked'`,
        [runId]
      );
      expect(blockedEvents.rows[0]?.count).toBe(1);

      await client.query(
        `UPDATE build_preview_instances
         SET created_at = now() - interval '2 hours',
             expires_at = now() - interval '1 hour'
         WHERE id = $1`,
        [instanceId]
      );
      await client.query(
        `UPDATE build_runs SET status = 'deploying' WHERE id = $1`,
        [runId]
      );
      await client.query(
        `UPDATE build_revisions
         SET deployment_status = 'deploying', deployed_at = NULL
         WHERE id = $1`,
        [revisionId]
      );
      const replacement = await instanceStore.begin({
        ...walkingInput,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
      expect(replacement.instanceId).not.toBe(instanceId);
      await expect(
        instanceStore.listCleanupCandidates(revisionId)
      ).resolves.toContainEqual({
        instanceId,
        dataHandle: `docker-db:${instanceId}`,
        sandboxHandle: `docker-sandbox:${instanceId}`,
      });
      await instanceStore.markCleanup({
        instanceId,
        status: 'running',
      });
      await expect(
        instanceStore.listCleanupCandidates(revisionId)
      ).resolves.toContainEqual({
        instanceId,
        dataHandle: `docker-db:${instanceId}`,
        sandboxHandle: `docker-sandbox:${instanceId}`,
      });
      const recovered = await client.query<{
        id: string;
        state: string;
        cleanup_state: string;
        failure_code: string | null;
      }>(
        `SELECT id, state, cleanup_state, failure_code
         FROM build_preview_instances
         WHERE build_preview_artifact_id = $1
         ORDER BY created_at, id`,
        [replacement.artifactId]
      );
      expect(recovered.rows).toEqual(
        expect.arrayContaining([
          {
            id: instanceId,
            state: 'failed',
            cleanup_state: 'running',
            failure_code: 'orchestration_abandoned',
          },
          {
            id: replacement.instanceId,
            state: 'provisioning',
            cleanup_state: 'pending',
            failure_code: null,
          },
        ])
      );
    } finally {
      if (instanceId) {
        await sandbox.destroy({
          idempotencyKey: `${instanceId}:sandbox:destroy`,
          handle: `docker-sandbox:${instanceId}`,
        });
        await data.destroy({
          idempotencyKey: `${instanceId}:data:destroy`,
          databaseHandle: `docker-db:${instanceId}`,
        });
        await docker
          .run([
            'rm',
            '--force',
            dockerResourceName('proxy', instanceId),
            dockerResourceName('app', instanceId),
            dockerResourceName('db', instanceId),
          ])
          .catch(() => undefined);
        await docker
          .run(['network', 'rm', dockerResourceName('network', instanceId)])
          .catch(() => undefined);
      }
      await rm(evidenceRoot, { force: true, recursive: true });
    }
  });
});
