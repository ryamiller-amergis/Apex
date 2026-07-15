import { createHash, randomUUID } from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import type { DevSessionSetupPhase } from '../../shared/types/devWorkbench';
import { resolveDataRoot } from '../utils/dataDir';

const NPM_CI_ARGS = [
  'ci',
  '--include=dev',
  '--prefer-offline',
  '--no-audit',
  '--no-fund',
] as const;
const PNPM_INSTALL_ARGS = [
  'install',
  '--frozen-lockfile',
  '--prod=false',
  '--prefer-offline',
] as const;
const DEFAULT_LOCK_POLL_MS = 250;
const DEFAULT_LOCK_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_STALE_LOCK_MS = 60 * 60_000;
const COMPLETE_MARKER = '.apex-dependencies-ready.json';
const EXCLUDED_DISCOVERY_DIRS = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  'bin',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'obj',
  'out',
  'target',
]);
const LOCKFILE_MANAGERS = {
  'package-lock.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
} as const;

export type DependencyBootstrapPhase = DevSessionSetupPhase;
export type SupportedPackageManager = 'npm' | 'pnpm';

export interface DependencyCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type DependencyCommandRunner = (
  command: string,
  args: readonly string[],
  options: DependencyCommandOptions
) => Promise<void>;

export interface DependencyBootstrapOptions {
  dataRoot?: string;
  nodeVersion?: string;
  commandRunner?: DependencyCommandRunner;
  lockPollMs?: number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  onPhase?: (
    phase: DependencyBootstrapPhase,
    detail: string
  ) => void | Promise<void>;
}

export interface DependencyBootstrapResult {
  cacheKey: string;
  cacheDir: string;
  cacheHit: boolean;
  units: DependencyInstallUnitResult[];
}

export interface DependencyInstallUnitResult {
  relativeDir: string;
  packageManager: SupportedPackageManager;
  packageManagerVersion?: string;
  lockfile: string;
  cacheKey: string;
  cacheDir: string;
  cacheHit: boolean;
}

interface DependencyInstallUnit {
  relativeDir: string;
  unitDir: string;
  packageJson: string;
  lockfilePath: string;
  lockfileName: keyof typeof LOCKFILE_MANAGERS;
  packageManager: SupportedPackageManager;
  packageManagerVersion?: string;
}

function defaultCommandRunner(
  command: string,
  args: readonly string[],
  options: DependencyCommandOptions
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';

    child.stderr.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 8_000) stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} exited with code ${code ?? 'unknown'}${stderr ? `: ${stderr.trim()}` : ''}`
        )
      );
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function isCompleteCache(cacheDir: string): Promise<boolean> {
  return (
    (await pathExists(path.join(cacheDir, COMPLETE_MARKER))) &&
    (await pathExists(path.join(cacheDir, 'node_modules')))
  );
}

async function attachCache(
  workspaceDir: string,
  cacheDir: string
): Promise<void> {
  const workspaceModules = path.join(workspaceDir, 'node_modules');
  const cacheModules = path.join(cacheDir, 'node_modules');

  try {
    const currentTarget = await fs.realpath(workspaceModules);
    if (currentTarget === (await fs.realpath(cacheModules))) return;
  } catch {
    // Missing, broken, or non-link node_modules is replaced below.
  }

  await fs.rm(workspaceModules, { recursive: true, force: true });
  await fs.symlink(
    cacheModules,
    workspaceModules,
    process.platform === 'win32' ? 'junction' : 'dir'
  );
}

async function acquireCacheLock(
  lockDir: string,
  options: Required<
    Pick<
      DependencyBootstrapOptions,
      'lockPollMs' | 'lockTimeoutMs' | 'staleLockMs'
    >
  >,
  onWait: () => void | Promise<void>
): Promise<void> {
  const startedAt = Date.now();
  let announcedWait = false;

  while (true) {
    try {
      await fs.mkdir(lockDir);
      return;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'EEXIST') throw err;
    }

    if (!announcedWait) {
      announcedWait = true;
      await onWait();
    }

    try {
      const stat = await fs.stat(lockDir);
      if (Date.now() - stat.mtimeMs > options.staleLockMs) {
        await fs.rm(lockDir, { recursive: true, force: true });
        continue;
      }
    } catch {
      continue;
    }

    if (Date.now() - startedAt >= options.lockTimeoutMs) {
      throw new Error(
        `Timed out waiting for dependency cache lock after ${options.lockTimeoutMs}ms`
      );
    }
    await sleep(options.lockPollMs);
  }
}

function toPortableRelativeDir(workspaceDir: string, unitDir: string): string {
  const relative = path.relative(workspaceDir, unitDir);
  return relative ? relative.split(path.sep).join('/') : '.';
}

function isWithinInstallUnit(relativeDir: string, installDir: string): boolean {
  return (
    installDir === '.' ||
    relativeDir === installDir ||
    relativeDir.startsWith(`${installDir}/`)
  );
}

function parsePackageManager(
  value: unknown,
  packageJson: string
): { name?: string; version?: string } {
  if (value === undefined) return {};
  if (typeof value !== 'string') {
    throw new Error(
      `Invalid packageManager metadata in ${packageJson}: expected a string`
    );
  }
  const match = /^([^@\s]+)@([^@\s]+)$/.exec(value.trim());
  if (!match) {
    throw new Error(
      `Invalid packageManager metadata "${value}" in ${packageJson}; expected manager@version`
    );
  }
  return { name: match[1].toLowerCase(), version: match[2] };
}

function isExactManagerVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version);
}

export async function discoverJavaScriptInstallUnits(
  workspaceDir: string
): Promise<DependencyInstallUnit[]> {
  const lockfilesByDir = new Map<
    string,
    Array<keyof typeof LOCKFILE_MANAGERS>
  >();
  const packageJsonDirs: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const lockfiles: Array<keyof typeof LOCKFILE_MANAGERS> = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'package.json') {
        packageJsonDirs.push(currentDir);
      }
      if (
        entry.isFile() &&
        Object.prototype.hasOwnProperty.call(LOCKFILE_MANAGERS, entry.name)
      ) {
        lockfiles.push(entry.name as keyof typeof LOCKFILE_MANAGERS);
      }
    }
    if (lockfiles.length > 0) lockfilesByDir.set(currentDir, lockfiles);

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (EXCLUDED_DISCOVERY_DIRS.has(entry.name.toLowerCase())) continue;
      await walk(path.join(currentDir, entry.name));
    }
  }

  await walk(workspaceDir);
  const units: DependencyInstallUnit[] = [];
  const sortedLockDirs = [...lockfilesByDir.keys()].sort((a, b) =>
    toPortableRelativeDir(workspaceDir, a).localeCompare(
      toPortableRelativeDir(workspaceDir, b)
    )
  );

  for (const unitDir of sortedLockDirs) {
    const lockfiles = lockfilesByDir.get(unitDir)!;
    const relativeDir = toPortableRelativeDir(workspaceDir, unitDir);
    if (lockfiles.length > 1) {
      throw new Error(
        `Multiple supported lockfiles were found in the same install folder "${relativeDir}": ${lockfiles.join(', ')}. Keep exactly one package-manager lockfile.`
      );
    }

    const packageJson = path.join(unitDir, 'package.json');
    if (!(await pathExists(packageJson))) {
      throw new Error(
        `Cannot prepare locked dependencies in "${relativeDir}": ${lockfiles[0]} has no package.json beside it`
      );
    }

    let manifest: { packageManager?: unknown };
    try {
      manifest = JSON.parse(await fs.readFile(packageJson, 'utf8')) as {
        packageManager?: unknown;
      };
    } catch (err) {
      throw new Error(
        `Cannot parse package.json for install folder "${relativeDir}": ${(err as Error).message}`
      );
    }

    const lockfileName = lockfiles[0];
    const packageManager = LOCKFILE_MANAGERS[lockfileName];
    const metadata = parsePackageManager(manifest.packageManager, packageJson);
    if (metadata.name && metadata.name !== packageManager) {
      throw new Error(
        `packageManager declares ${metadata.name}${metadata.version ? `@${metadata.version}` : ''} in "${relativeDir}", but ${lockfileName} selects ${packageManager}. Align the metadata and lockfile before retrying.`
      );
    }
    if (
      packageManager === 'pnpm' &&
      (!metadata.version || !isExactManagerVersion(metadata.version))
    ) {
      throw new Error(
        `pnpm install folder "${relativeDir}" must declare an exact packageManager version such as "pnpm@9.15.4" so Corepack can run a pinned installer`
      );
    }
    if (
      packageManager === 'pnpm' &&
      (await pathExists(path.join(unitDir, 'pnpm-workspace.yaml')))
    ) {
      throw new Error(
        `pnpm workspace dependency bootstrap is not supported safely yet for "${relativeDir}"; disable dev-dependency-bootstrap for this project and let the agent install in the checked-out workspace`
      );
    }

    units.push({
      relativeDir,
      unitDir,
      packageJson,
      lockfilePath: path.join(unitDir, lockfileName),
      lockfileName,
      packageManager,
      packageManagerVersion: metadata.version,
    });
  }

  const installDirs = units.map((unit) => unit.relativeDir);
  const unlockedPackageDirs = packageJsonDirs
    .map((dir) => toPortableRelativeDir(workspaceDir, dir))
    .filter(
      (relativeDir) =>
        !installDirs.some((installDir) =>
          isWithinInstallUnit(relativeDir, installDir)
        )
    );
  if (unlockedPackageDirs.length > 0) {
    throw new Error(
      `Cannot prepare lockfile-exact dependencies: package.json has no supported package-lock.json or pnpm-lock.yaml install unit at ${unlockedPackageDirs.join(', ')}`
    );
  }

  return units;
}

function buildCacheKey(
  unit: DependencyInstallUnit,
  nodeVersion: string,
  lockHash: string
): string {
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, '_');
  const folder = unit.relativeDir === '.' ? 'root' : unit.relativeDir;
  const managerIdentity = `${unit.packageManager}-${unit.packageManagerVersion ?? 'unversioned'}`;
  return [
    `node-${sanitize(nodeVersion)}`,
    sanitize(managerIdentity),
    `folder-${sanitize(folder)}`,
    `lock-${lockHash}`,
  ].join('-');
}

function resolveInstallCommand(unit: DependencyInstallUnit): {
  command: string;
  args: readonly string[];
} {
  if (unit.packageManager === 'pnpm') {
    return {
      command: 'corepack',
      args: [`pnpm@${unit.packageManagerVersion!}`, ...PNPM_INSTALL_ARGS],
    };
  }
  return { command: 'npm', args: NPM_CI_ARGS };
}

/**
 * Installs a lockfile-exact development dependency tree into a shared cache,
 * then attaches that immutable tree to a freshly materialized dev workspace.
 */
export async function bootstrapDevelopmentDependencies(
  workspaceDir: string,
  options: DependencyBootstrapOptions = {}
): Promise<DependencyBootstrapResult> {
  const nodeVersion = options.nodeVersion ?? process.version;
  const cacheRoot = path.join(
    options.dataRoot ?? resolveDataRoot(),
    'dev-dependency-cache'
  );
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const onPhase = options.onPhase ?? (() => undefined);
  const units = await discoverJavaScriptInstallUnits(workspaceDir);

  await fs.mkdir(cacheRoot, { recursive: true });
  if (units.length === 0) {
    await onPhase(
      'dependencies_ready',
      'No JavaScript lockfile install units found; no dependencies were prepared'
    );
    return {
      cacheKey: 'no-javascript-install-units',
      cacheDir: cacheRoot,
      cacheHit: true,
      units: [],
    };
  }

  const results: DependencyInstallUnitResult[] = [];
  for (const unit of units) {
    const lockContents = await fs.readFile(unit.lockfilePath);
    const lockHash = createHash('sha256').update(lockContents).digest('hex');
    const cacheKey = buildCacheKey(unit, nodeVersion, lockHash);
    const cacheDir = path.join(cacheRoot, cacheKey);
    const lockDir = `${cacheDir}.lock`;
    const stagingDir = `${cacheDir}.building-${process.pid}-${randomUUID()}`;
    const installCommand = resolveInstallCommand(unit);

    await onPhase(
      'dependencies_preparing',
      `Preparing ${unit.packageManager} dependency cache for ${unit.relativeDir} (${cacheKey})`
    );
    if (await isCompleteCache(cacheDir)) {
      await attachCache(unit.unitDir, cacheDir);
      await onPhase(
        'dependencies_ready',
        `Reused ${unit.packageManager} dependency cache for ${unit.relativeDir} (${cacheKey})`
      );
      results.push({
        relativeDir: unit.relativeDir,
        packageManager: unit.packageManager,
        packageManagerVersion: unit.packageManagerVersion,
        lockfile: unit.lockfileName,
        cacheKey,
        cacheDir,
        cacheHit: true,
      });
      continue;
    }

    await acquireCacheLock(
      lockDir,
      {
        lockPollMs: options.lockPollMs ?? DEFAULT_LOCK_POLL_MS,
        lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
        staleLockMs: options.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
      },
      () =>
        onPhase(
          'dependencies_waiting',
          `Waiting for ${unit.packageManager} dependency cache for ${unit.relativeDir} (${cacheKey})`
        )
    );

    try {
      if (await isCompleteCache(cacheDir)) {
        await attachCache(unit.unitDir, cacheDir);
        await onPhase(
          'dependencies_ready',
          `Reused ${unit.packageManager} dependency cache for ${unit.relativeDir} (${cacheKey})`
        );
        results.push({
          relativeDir: unit.relativeDir,
          packageManager: unit.packageManager,
          packageManagerVersion: unit.packageManagerVersion,
          lockfile: unit.lockfileName,
          cacheKey,
          cacheDir,
          cacheHit: true,
        });
        continue;
      }

      await fs.rm(cacheDir, { recursive: true, force: true });
      await fs.rm(stagingDir, { recursive: true, force: true });
      await fs.mkdir(stagingDir, { recursive: true });
      await Promise.all([
        fs.copyFile(unit.packageJson, path.join(stagingDir, 'package.json')),
        fs.copyFile(
          unit.lockfilePath,
          path.join(stagingDir, unit.lockfileName)
        ),
      ]);

      await commandRunner(installCommand.command, installCommand.args, {
        cwd: stagingDir,
        env: {
          ...process.env,
          ...(unit.packageManager === 'pnpm'
            ? { NPM_CONFIG_PRODUCTION: 'false' }
            : {}),
        },
      });
      if (!(await pathExists(path.join(stagingDir, 'node_modules')))) {
        throw new Error(
          `${installCommand.command} ${installCommand.args.join(' ')} completed without creating node_modules`
        );
      }

      await fs.writeFile(
        path.join(stagingDir, COMPLETE_MARKER),
        JSON.stringify({
          cacheKey,
          relativeDir: unit.relativeDir,
          lockHash,
          lockfile: unit.lockfileName,
          nodeVersion,
          packageManager: unit.packageManager,
          packageManagerVersion: unit.packageManagerVersion,
          command: `${installCommand.command} ${installCommand.args.join(' ')}`,
          completedAt: new Date().toISOString(),
        })
      );
      await fs.rename(stagingDir, cacheDir);
      await attachCache(unit.unitDir, cacheDir);
      await onPhase(
        'dependencies_ready',
        `Prepared ${unit.packageManager} dependency cache for ${unit.relativeDir} (${cacheKey})`
      );
      results.push({
        relativeDir: unit.relativeDir,
        packageManager: unit.packageManager,
        packageManagerVersion: unit.packageManagerVersion,
        lockfile: unit.lockfileName,
        cacheKey,
        cacheDir,
        cacheHit: false,
      });
    } catch (err) {
      await fs.rm(stagingDir, { recursive: true, force: true });
      const commandText = `${installCommand.command} ${installCommand.args.join(' ')}`;
      const message = `Development dependency bootstrap failed for ${unit.relativeDir} while running ${commandText}: ${(err as Error).message}`;
      await onPhase('dependencies_failed', message);
      throw new Error(message);
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  }

  const aggregateKey =
    results.length === 1
      ? results[0].cacheKey
      : `multi-${createHash('sha256')
          .update(results.map((result) => result.cacheKey).join('\n'))
          .digest('hex')}`;
  return {
    cacheKey: aggregateKey,
    cacheDir: results.length === 1 ? results[0].cacheDir : cacheRoot,
    cacheHit: results.every((result) => result.cacheHit),
    units: results,
  };
}
