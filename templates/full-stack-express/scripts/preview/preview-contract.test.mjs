import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  loadPreviewManifest,
  parsePreviewManifest,
} from './preview-manifest.mjs';
import {
  buildRuntimeBundle,
  listRuntimeBundleEntries,
} from './runtime-bundle.mjs';
import { createPreviewHttpProxy } from './runner-tcp-proxy.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const execFileAsync = promisify(execFile);

function validManifest() {
  return {
    schemaVersion: 1,
    template: {
      id: 'full-stack-express',
      version: '1.0.0',
    },
    runner: {
      id: 'full-stack-express',
      version: '1.0.0',
      dependencyLayout: 'workspace-runtime-v1',
    },
    toolchain: {
      node: '>=24.0.0 <25.0.0',
      packageManager:
        'pnpm@10.34.9+sha512.f49b5a8ea0fdedb44bb3c0c1d6575092a53c2950d95b7ad15df11f17974877a2de3a01c07e934e9b28ce716e51c09a94962c7306d09be2e1e4b18a8c8762fd32',
    },
    commands: {
      install: ['corepack', 'pnpm', 'install', '--frozen-lockfile'],
      build: ['corepack', 'pnpm', 'build'],
      migrate: ['node', 'api/dist/cli/migrate.js'],
      seed: ['node', 'api/dist/cli/seed.js'],
      start: [
        'node',
        '--import',
        './api/dist/instrument.js',
        'api/dist/index.js',
      ],
      runtimeBundle: ['node', 'scripts/preview/build-runtime-bundle.mjs'],
    },
    application: {
      port: 3000,
      livenessPath: '/health/live',
      readinessPath: '/health/ready',
    },
    development: {
      dockerfile: 'Dockerfile.studio',
      applicationPort: 5173,
      requiredTransports: ['http', 'websocket', 'vite_hmr'],
      tasks: {
        typecheck: ['corepack', 'pnpm', 'typecheck'],
        unit_test: ['corepack', 'pnpm', 'test:unit'],
        quality_check: ['corepack', 'pnpm', 'check'],
        production_build: ['corepack', 'pnpm', 'build'],
      },
    },
    verification: {
      journey: 'e2e/specs/profile.spec.ts',
    },
    allowedEnvironmentNames: [
      'AUTH_MODE',
      'CLIENT_DIST_DIR',
      'DATABASE_URL',
      'NODE_ENV',
      'PORT',
    ],
    bundle: {
      format: 'tar',
      output: 'artifacts/preview/apex-preview-runtime.tar',
      sbomRef: 'golden-stack:full-stack-express:1.0.0',
      includes: [
        { source: 'apps/api/dist', target: 'api/dist' },
        { source: 'apps/web/dist', target: 'web' },
      ],
      requiredFiles: [
        'api/dist/cli/migrate.js',
        'api/dist/cli/seed.js',
        'api/dist/index.js',
        'api/dist/instrument.js',
        'web/index.html',
      ],
    },
  };
}

async function writeFixture() {
  const fixture = await mkdtemp(path.join(tmpdir(), 'apex-preview-bundle-'));
  const files = {
    'apps/api/dist/index.js': 'console.log("api");\n',
    'apps/api/dist/instrument.js': 'export {};\n',
    'apps/api/dist/cli/migrate.js': 'console.log("migrate");\n',
    'apps/api/dist/cli/seed.js': 'console.log("seed");\n',
    'apps/web/dist/index.html': '<main>Apex preview</main>\n',
    'apps/web/dist/assets/app.js': 'console.log("web");\n',
    'apps/web/dist/favicon.svg': '<svg>\n  <path />\n</svg>\n',
  };
  await writeFile(
    path.join(fixture, 'apex.preview.json'),
    `${JSON.stringify(validManifest(), null, 2)}\n`
  );
  for (const [relative, content] of Object.entries(files)) {
    const destination = path.join(fixture, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  return fixture;
}

describe('Golden Stack preview manifest', () => {
  it('validates the committed manifest and matches the root toolchain', async () => {
    const manifest = await loadPreviewManifest(root);
    const packageJson = JSON.parse(
      await readFile(path.join(root, 'package.json'), 'utf8')
    );

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.toolchain).toEqual({
      node: packageJson.engines.node,
      packageManager: packageJson.packageManager,
    });
    expect(manifest.runner).toEqual({
      id: manifest.template.id,
      version: manifest.template.version,
      dependencyLayout: 'workspace-runtime-v1',
    });
    expect(manifest.development).toEqual({
      dockerfile: 'Dockerfile.studio',
      applicationPort: 5173,
      requiredTransports: ['http', 'websocket', 'vite_hmr'],
      tasks: {
        typecheck: ['corepack', 'pnpm', 'typecheck'],
        unit_test: ['corepack', 'pnpm', 'test:unit'],
        quality_check: ['corepack', 'pnpm', 'check'],
        production_build: ['corepack', 'pnpm', 'build'],
      },
    });
  });

  it('rejects unknown properties and missing required commands', () => {
    expect(() =>
      parsePreviewManifest({ ...validManifest(), surprise: true })
    ).toThrow(/unrecognized|unknown/i);

    const withoutSeed = validManifest();
    delete withoutSeed.commands.seed;
    expect(() => parsePreviewManifest(withoutSeed)).toThrow(/seed/i);
  });

  it('rejects unsafe paths, duplicate environment names, and shell commands', () => {
    const unsafe = validManifest();
    unsafe.bundle.output = '../runtime.tar';
    expect(() => parsePreviewManifest(unsafe)).toThrow(/relative|path/i);

    const duplicateEnv = validManifest();
    duplicateEnv.allowedEnvironmentNames = ['PORT', 'PORT'];
    expect(() => parsePreviewManifest(duplicateEnv)).toThrow(/duplicate/i);

    const shellCommand = validManifest();
    shellCommand.commands.start = 'node api/dist/index.js';
    expect(() => parsePreviewManifest(shellCommand)).toThrow(/array/i);

    const unsafeStudioDockerfile = validManifest();
    unsafeStudioDockerfile.development.dockerfile = '../Dockerfile.studio';
    expect(() => parsePreviewManifest(unsafeStudioDockerfile)).toThrow(
      /relative|path/i
    );

    const missingHmr = validManifest();
    missingHmr.development.requiredTransports = [
      'http',
      'websocket',
      'websocket',
    ];
    expect(() => parsePreviewManifest(missingHmr)).toThrow(
      /duplicate|vite_hmr/i
    );
  });

  it('binds the runner and SBOM reference to the template version', () => {
    const runnerDrift = validManifest();
    runnerDrift.runner.version = '2.0.0';
    expect(() => parsePreviewManifest(runnerDrift)).toThrow(/runner/i);

    const sbomDrift = validManifest();
    sbomDrift.bundle.sbomRef = 'golden-stack:full-stack-express:2.0.0';
    expect(() => parsePreviewManifest(sbomDrift)).toThrow(/sbom|expected/i);

    const reservedTarget = validManifest();
    reservedTarget.bundle.includes[0].target = 'apex.runtime.json';
    expect(() => parsePreviewManifest(reservedTarget)).toThrow(/reserved/i);
  });
});

describe('deterministic runtime bundle', () => {
  it('writes byte-identical archives with sorted entries and normalized metadata', async () => {
    const fixture = await writeFixture();
    try {
      const firstPath = path.join(fixture, 'first.tar');
      const secondPath = path.join(fixture, 'second.tar');
      const first = await buildRuntimeBundle({
        root: fixture,
        outputPath: firstPath,
      });

      await utimes(
        path.join(fixture, 'apps/api/dist/index.js'),
        new Date('2035-01-01T00:00:00.000Z'),
        new Date('2035-01-01T00:00:00.000Z')
      );
      await writeFile(
        path.join(fixture, 'apps/api/dist/index.js'),
        'console.log("api");\r\n'
      );
      await writeFile(
        path.join(fixture, 'apps/web/dist/favicon.svg'),
        '<svg>\r\n  <path />\r\n</svg>\r\n'
      );
      const manifestText = await readFile(
        path.join(fixture, 'apex.preview.json'),
        'utf8'
      );
      await writeFile(
        path.join(fixture, 'apex.preview.json'),
        manifestText.replace(/\n/g, '\r\n')
      );
      const second = await buildRuntimeBundle({
        root: fixture,
        outputPath: secondPath,
      });

      const firstBytes = await readFile(firstPath);
      const secondBytes = await readFile(secondPath);
      expect(secondBytes).toEqual(firstBytes);
      expect(second.digest).toBe(first.digest);
      expect(first.digest).toBe(
        `sha256:${createHash('sha256').update(firstBytes).digest('hex')}`
      );
      expect(listRuntimeBundleEntries(firstBytes)).toEqual([
        'apex.preview.json',
        'apex.runtime.json',
        'api/dist/cli/migrate.js',
        'api/dist/cli/seed.js',
        'api/dist/index.js',
        'api/dist/instrument.js',
        'web/assets/app.js',
        'web/favicon.svg',
        'web/index.html',
      ]);
      const { stdout } = await execFileAsync('tar', ['-tf', firstPath]);
      expect(stdout.trim().split(/\r?\n/)).toEqual(
        listRuntimeBundleEntries(firstBytes)
      );

      const descriptorResult = await execFileAsync(
        'tar',
        ['-xOf', firstPath, 'apex.runtime.json'],
        { encoding: null }
      );
      const descriptor = JSON.parse(descriptorResult.stdout.toString('utf8'));
      expect(descriptor.schemaVersion).toBe(1);
      expect(descriptor.runner).toEqual(validManifest().runner);
      expect(descriptor.sbomRef).toBe(validManifest().bundle.sbomRef);
      expect(descriptor.entries.map((entry) => entry.path)).toEqual(
        [...descriptor.entries.map((entry) => entry.path)].sort()
      );
      for (const entry of descriptor.entries) {
        const extracted = await execFileAsync(
          'tar',
          ['-xOf', firstPath, entry.path],
          { encoding: null }
        );
        expect(entry.sizeBytes).toBe(extracted.stdout.length);
        expect(entry.digest).toBe(
          `sha256:${createHash('sha256').update(extracted.stdout).digest('hex')}`
        );
      }
      expect(descriptor.manifestDigest).toBe(
        descriptor.entries.find((entry) => entry.path === 'apex.preview.json')
          .digest
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('aborts when a required runtime file is missing', async () => {
    const fixture = await writeFixture();
    try {
      await rm(path.join(fixture, 'apps/api/dist/cli/seed.js'));
      await expect(
        buildRuntimeBundle({
          root: fixture,
          outputPath: path.join(fixture, 'runtime.tar'),
        })
      ).rejects.toThrow(/api\/dist\/cli\/seed\.js/);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('rejects case-insensitive archive path collisions', async () => {
    const fixture = await writeFixture();
    try {
      const manifestPath = path.join(fixture, 'apex.preview.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.bundle.includes.push({
        source: 'apps/api/dist',
        target: 'API/dist',
      });
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      await expect(
        buildRuntimeBundle({
          root: fixture,
          outputPath: path.join(fixture, 'runtime.tar'),
        })
      ).rejects.toThrow(/case-insensitive.*collision/i);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('rejects Windows-reserved archive paths', async () => {
    const fixture = await writeFixture();
    try {
      const manifestPath = path.join(fixture, 'apex.preview.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.bundle.includes[0].target = 'con';
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      await expect(
        buildRuntimeBundle({
          root: fixture,
          outputPath: path.join(fixture, 'runtime.tar'),
        })
      ).rejects.toThrow(/windows-incompatible/i);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('rejects a tar archive with a corrupt header checksum', async () => {
    const fixture = await writeFixture();
    try {
      const outputPath = path.join(fixture, 'runtime.tar');
      await buildRuntimeBundle({ root: fixture, outputPath });
      const bundle = await readFile(outputPath);
      bundle[0] ^= 1;
      expect(() => listRuntimeBundleEntries(bundle)).toThrow(/checksum/i);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('rejects output paths with symlinked ancestors', async () => {
    const fixture = await writeFixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'apex-preview-outside-'));
    try {
      const linkedOutput = path.join(fixture, 'linked-output');
      await symlink(
        outside,
        linkedOutput,
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      await expect(
        buildRuntimeBundle({
          root: fixture,
          outputPath: path.join(linkedOutput, 'runtime.tar'),
        })
      ).rejects.toThrow(/symlink/i);
    } finally {
      await rm(fixture, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('preview HTTP proxy', () => {
  it('adds CORS headers for sandboxed module requests and handles preflight', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end('export const ready = true;');
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamAddress = upstream.address();
    const proxy = createPreviewHttpProxy({
      host: '127.0.0.1',
      port: upstreamAddress.port,
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyAddress = proxy.address();
    const url = `http://127.0.0.1:${proxyAddress.port}/assets/app.js`;

    try {
      const moduleResponse = await fetch(url, {
        headers: { Origin: 'null' },
      });
      expect(moduleResponse.status).toBe(200);
      expect(moduleResponse.headers.get('access-control-allow-origin')).toBe(
        '*'
      );
      await expect(moduleResponse.text()).resolves.toContain('ready = true');

      const preflight = await fetch(url, {
        method: 'OPTIONS',
        headers: {
          Origin: 'null',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
      expect(preflight.headers.get('access-control-allow-headers')).toBe(
        'content-type'
      );
    } finally {
      await Promise.all([
        new Promise((resolve) => proxy.close(resolve)),
        new Promise((resolve) => upstream.close(resolve)),
      ]);
    }
  });
});
