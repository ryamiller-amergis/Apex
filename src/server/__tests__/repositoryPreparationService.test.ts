import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

jest.mock('../db/drizzle', () => ({ db: {} }));

import type { RunGrounding, RunRef } from '../../shared/types/runGrounding';
import { createSharedReadCheckoutService } from '../services/grounding/sharedReadCheckoutService';
import {
  createRepositoryPreparationService,
  type RepositoryPreparationTarget,
  type RepositoryPreparationWorkflowClass,
} from '../services/repositoryPreparationService';

const exec = promisify(execFile);

describe('cold external-project repository preparation contract', () => {
  let tempRoot: string;
  let sourceRepository: string;
  let mirrorRepository: string;
  let dataRoot: string;
  let sha: string;
  let mirrorStarted: jest.Mock;
  let activatedGroundings: RunGrounding[];

  const repository: RepositoryPreparationTarget = {
    provider: 'github',
    project: 'External Project',
    repo: 'external-repository',
    branch: 'main',
  };

  const git = async (args: string[], cwd?: string): Promise<string> => {
    const result = await exec('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Apex Test',
        GIT_AUTHOR_EMAIL: 'apex-test@example.invalid',
        GIT_COMMITTER_NAME: 'Apex Test',
        GIT_COMMITTER_EMAIL: 'apex-test@example.invalid',
      },
    });
    return result.stdout.trim();
  };

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'apex-cold-external-'));
    sourceRepository = path.join(tempRoot, 'source');
    mirrorRepository = path.join(tempRoot, 'cache', 'external.git');
    dataRoot = path.join(tempRoot, 'data');
    mirrorStarted = jest.fn();
    activatedGroundings = [];

    await fs.mkdir(sourceRepository, { recursive: true });
    await git(['init', '--initial-branch=main'], sourceRepository);
    await fs.writeFile(
      path.join(sourceRepository, 'PROJECT.md'),
      '# External project\n',
      'utf8'
    );
    await git(['add', 'PROJECT.md'], sourceRepository);
    await git(['commit', '-m', 'initial external project'], sourceRepository);
    sha = await git(['rev-parse', 'HEAD'], sourceRepository);
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const ensureMirror = async (): Promise<{ baseSha: string }> => {
    try {
      await fs.access(path.join(mirrorRepository, 'HEAD'));
    } catch {
      mirrorStarted();
      await fs.mkdir(path.dirname(mirrorRepository), { recursive: true });
      await git(['clone', '--bare', sourceRepository, mirrorRepository]);
    }
    return {
      baseSha: await git(['rev-parse', 'refs/heads/main'], mirrorRepository),
    };
  };

  const readCachedSha = async (): Promise<string | null> => {
    try {
      return await git(['rev-parse', 'refs/heads/main'], mirrorRepository);
    } catch {
      return null;
    }
  };

  const groundingFor = (run: RunRef, resolvedSha: string): RunGrounding => ({
    ...run,
    id: `grounding-${run.runId}`,
    repoRole: 'target',
    provider: 'github',
    repository: repository.repo,
    branch: repository.branch,
    groundedSha: resolvedSha,
    groundedAt: '2026-08-11T00:00:00.000Z',
    isActive: true,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  });

  const createService = () => {
    const shared = createSharedReadCheckoutService({
      dataRoot,
      materializeToPath: async (identity, destination) => {
        await git(['clone', mirrorRepository, destination]);
        await git(['checkout', '--detach', identity.sha], destination);
      },
      withLease: async (_key, operation) =>
        operation({
          signal: new AbortController().signal,
          assertOwned: async () => undefined,
        }),
      listActiveGroundings: async () => activatedGroundings,
      telemetry: jest.fn(),
    });

    return createRepositoryPreparationService({
      readCachedOriginSha: readCachedSha,
      ensureRepoCache: ensureMirror,
      sharedReadCheckout: shared,
      groundingService: {
        activateGroundings: async (input) => {
          const grounding = groundingFor(input.run, input.target.groundedSha);
          activatedGroundings.push(grounding);
          return {
            ok: true,
            durableGrounding: true,
            fallback: 'none',
            groundings: [grounding],
          };
        },
      },
      materializeWritable: async (grounding, destinationRun) => {
        const destination = path.join(
          dataRoot,
          'workspaces',
          'grounding',
          destinationRun.runId
        );
        await git(['clone', mirrorRepository, destination]);
        await git(['checkout', '--detach', grounding.groundedSha], destination);
        return { state: 'materialized', workspacePath: destination };
      },
      telemetry: jest.fn(),
    });
  };

  it.each<RepositoryPreparationWorkflowClass>([
    'agent-home',
    'interview',
    'adr',
  ])(
    '%s: no mirror or checkout starts preparation, reads shared checkout, and persists outside it',
    async (workflowClass) => {
      const service = createService();
      expect(await readCachedSha()).toBeNull();
      expect(
        service.getReadyReadOnly({
          repository,
          workflowClass,
          sha,
        })
      ).toBeNull();

      const prepared = await service.prepareReadOnly({
        repository,
        workflowClass,
      });
      const repositoryContent = await fs.readFile(
        path.join(prepared.checkout.workspacePath, 'PROJECT.md'),
        'utf8'
      );
      const statusPath = path.join(
        dataRoot,
        'domain',
        `${workflowClass}.status`
      );
      await fs.mkdir(path.dirname(statusPath), { recursive: true });
      await fs.writeFile(statusPath, 'completed', 'utf8');

      expect(mirrorStarted).toHaveBeenCalledTimes(1);
      expect(prepared.identity.sha).toBe(sha);
      expect(repositoryContent).toBe('# External project\n');
      await expect(fs.readFile(statusPath, 'utf8')).resolves.toBe('completed');
      expect(
        service.getReadyReadOnly({ repository, workflowClass, sha })
      ).toMatchObject({
        checkout: { workspacePath: prepared.checkout.workspacePath },
      });
    }
  );

  it.each<RepositoryPreparationWorkflowClass>([
    'prd',
    'test-cases',
    'prd-validation',
    'design-doc',
    'design-doc-validation',
  ])(
    '%s: no mirror or grounding creates a writable pinned run and persists output',
    async (workflowClass) => {
      const service = createService();
      const destinationRun: RunRef = {
        runType: 'chat',
        runId: `run-${workflowClass}`,
        project: repository.project,
      };
      expect(await readCachedSha()).toBeNull();

      const prepared = await service.prepareWritable({
        destinationRun,
        workflowClass,
        repository,
      });
      const output = path.join(
        prepared.workspacePath!,
        '.ai-pilot',
        'output',
        'result.md'
      );
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, `${workflowClass}: complete\n`, 'utf8');
      const statusPath = path.join(
        dataRoot,
        'domain',
        `${workflowClass}.status`
      );
      await fs.mkdir(path.dirname(statusPath), { recursive: true });
      await fs.writeFile(statusPath, 'ready', 'utf8');

      expect(mirrorStarted).toHaveBeenCalledTimes(1);
      expect(prepared.grounding).toMatchObject({
        runId: destinationRun.runId,
        groundedSha: sha,
        isActive: true,
      });
      expect(prepared.workspacePath).toContain(
        path.join('workspaces', 'grounding')
      );
      await expect(fs.readFile(output, 'utf8')).resolves.toBe(
        `${workflowClass}: complete\n`
      );
      await expect(fs.readFile(statusPath, 'utf8')).resolves.toBe('ready');
    }
  );
});
