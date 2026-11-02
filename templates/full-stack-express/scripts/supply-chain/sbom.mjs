import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { finish, isDirect } from './cli.mjs';
import {
  EXIT_CANNOT_RUN,
  EXIT_CLEAN,
  productionPackages,
  sbomDirectory,
  serviceName,
  templateRoot,
} from './constants.mjs';
import { writeAtomic } from './atomic-write.mjs';
import { dockerAvailable, DOCKER_UNAVAILABLE } from './docker.mjs';
import { parseJsonText } from './parse-json.mjs';
import { runCommand } from './run-command.mjs';
import {
  buildSbomDocument,
  flattenPnpmTree,
  serializeSbom,
  sha256Hex,
} from './sbom-document.mjs';

function lockfileProblem(root) {
  const lockfile = path.join(root, 'pnpm-lock.yaml');
  if (!existsSync(lockfile)) {
    return { ok: false, message: 'pnpm-lock.yaml is missing' };
  }
  let text;
  try {
    text = readFileSync(lockfile);
  } catch {
    return { ok: false, message: 'pnpm-lock.yaml is missing' };
  }
  if (!text.includes(Buffer.from('lockfileVersion:'))) {
    return { ok: false, message: 'pnpm-lock.yaml is invalid' };
  }
  return { ok: true, bytes: text, file: lockfile };
}

function sbomPath(root, image) {
  const directory =
    root === templateRoot
      ? sbomDirectory
      : path.join(root, 'artifacts', 'sbom');
  const filename = image
    ? `${serviceName}.image.cdx.json`
    : `${serviceName}.cdx.json`;
  return { directory, filename };
}

async function productionTree(root, env) {
  const result = await runCommand(
    'corepack',
    [
      'pnpm',
      'ls',
      '--prod',
      '--depth',
      'Infinity',
      '--json',
      ...productionPackages.flatMap((name) => ['--filter', name]),
    ],
    { cwd: root, env }
  );
  if (result.error || result.status !== 0 || result.stdout.trim() === '') {
    return { ok: false, message: 'SBOM generation could not run' };
  }
  try {
    return { ok: true, trees: parseJsonText(result.stdout) };
  } catch {
    return { ok: false, message: 'SBOM generation could not run' };
  }
}

function imageArgument(argv) {
  const index = argv.indexOf('--image');
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? '';
}

export async function runSbom(options = {}) {
  const root = options.root ?? templateRoot;
  const env = options.env ?? process.env;
  const image = options.image ?? null;
  const lockfile = lockfileProblem(root);
  if (!lockfile.ok) {
    return { exitCode: EXIT_CANNOT_RUN, lines: [lockfile.message] };
  }
  const destination = sbomPath(root, image);
  try {
    if (image !== null) {
      if (image === '') {
        return {
          exitCode: EXIT_CANNOT_RUN,
          lines: ['SBOM generation could not run: image tag is missing'],
        };
      }
      if (!(await dockerAvailable(env))) {
        return { exitCode: EXIT_CANNOT_RUN, lines: [DOCKER_UNAVAILABLE] };
      }
      const output = path.join(destination.directory, destination.filename);
      const generator = path.join(
        templateRoot,
        'node_modules',
        '@cyclonedx',
        'cdxgen',
        'bin',
        'cdxgen.js'
      );
      const { mkdir } = await import('node:fs/promises');
      await mkdir(destination.directory, { recursive: true });
      const result = await runCommand(
        process.execPath,
        [
          generator,
          '-t',
          'docker',
          '-o',
          output,
          '--no-install-deps',
          '--spec-version',
          '1.6',
          image,
        ],
        { cwd: root, env }
      );
      if (result.error || result.status !== 0 || !existsSync(output)) {
        const { rm } = await import('node:fs/promises');
        await rm(output, { force: true });
        await rm(`${output}.tmp`, { force: true });
        return {
          exitCode: EXIT_CANNOT_RUN,
          lines: ['SBOM generation could not run'],
        };
      }
      return {
        exitCode: EXIT_CLEAN,
        lines: [
          `wrote ${path.join('artifacts', 'sbom', destination.filename)}`,
        ],
        file: output,
      };
    }
    const tree = await productionTree(root, env);
    if (!tree.ok) {
      return { exitCode: EXIT_CANNOT_RUN, lines: [tree.message] };
    }
    const document = buildSbomDocument({
      components: flattenPnpmTree(tree.trees),
      lockfileHash: sha256Hex(lockfile.bytes),
      sourceDateEpoch: env.SOURCE_DATE_EPOCH,
      serviceName,
    });
    const file = path.join(destination.directory, destination.filename);
    await writeAtomic(
      destination.directory,
      destination.filename,
      serializeSbom(document)
    );
    return {
      exitCode: EXIT_CLEAN,
      lines: [`wrote ${path.join('artifacts', 'sbom', destination.filename)}`],
      file,
    };
  } catch {
    return {
      exitCode: EXIT_CANNOT_RUN,
      lines: ['SBOM generation could not run'],
    };
  }
}

if (isDirect(import.meta.url)) {
  const image = imageArgument(process.argv.slice(2));
  finish(await runSbom({ image }));
}
