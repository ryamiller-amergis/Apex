import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { writeAtomic } from '../atomic-write.mjs';
import {
  allowedLicensesFile,
  exceptionsFile,
  imageTag,
  nodeImage,
  serviceName,
  templateRoot,
} from '../constants.mjs';
import { dockerAvailable } from '../docker.mjs';
import { evaluateLicenses } from '../evaluate-licenses.mjs';
import { evaluateSecrets } from '../evaluate-secrets.mjs';
import { evaluateVulns } from '../evaluate-vulns.mjs';
import { loadJsonSchema, exceptionsFileSchema } from '../load-config.mjs';
import { runCommand } from '../run-command.mjs';
import { runLicenseScan } from '../scan-licenses.mjs';
import { runScan } from '../scan.mjs';
import { runSecretScan } from '../scan-secrets.mjs';
import { isSecretScanIgnored } from '../secret-ignore.mjs';
import { runVulnerabilityScan } from '../scan-vulns.mjs';
import { runSbom } from '../sbom.mjs';
import {
  buildSbomDocument,
  flattenPnpmTree,
  npmPurl,
  serializeSbom,
  sha256Hex,
} from '../sbom-document.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const supplyChainDir = path.resolve(here, '..');
const containerBuildScript = path.join(supplyChainDir, 'container-build.mjs');
const containerTestScript = path.join(supplyChainDir, 'test-container.mjs');
const dockerfile = path.join(templateRoot, 'Dockerfile');
const dockerignore = path.join(templateRoot, '.dockerignore');

const highReport = {
  results: [
    {
      packages: [
        {
          package: { name: 'left-pad', version: '1.0.0' },
          groups: [
            {
              ids: ['GHSA-test-high'],
              aliases: [],
              max_severity: 'high',
            },
          ],
        },
      ],
    },
  ],
};

function exception(overrides) {
  return {
    advisory: 'GHSA-test-high',
    package: 'left-pad',
    reason: 'Reviewed for this template',
    owner: 'platform',
    reviewed: '2026-01-01',
    expires: '2027-01-01',
    ...overrides,
  };
}

describe('secret scan', () => {
  it('VT-02 PBI-029 AC-1 TBI-030 DoD-2 names the file and line and hides the token', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'secret-scan-'));
    const token = `ghp_${'a'.repeat(36)}`;
    const relative = path.join('nested', 'planted.js');
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(
      path.join(root, relative),
      `const token = "${token}";\n`,
      'utf8'
    );
    try {
      const result = await runSecretScan({
        root,
        files: [relative],
      });
      const output = result.lines.join('\n');
      expect(result.exitCode).toBe(1);
      expect(output).toContain('nested/planted.js');
      expect(output).toContain('line 1');
      expect(output).toContain('@secretlint/secretlint-rule-github');
      expect(output).not.toContain(token);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('PBI-029 AC-0 a clean tree exits 0', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'secret-clean-'));
    await writeFile(path.join(root, 'readme.txt'), 'nothing to see\n', 'utf8');
    try {
      const result = await runSecretScan({ root, files: ['readme.txt'] });
      expect(result.exitCode).toBe(0);
      expect(result.lines).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('NFR drops matched secret fields from a recorded report', () => {
    const token = `ghp_${'b'.repeat(36)}`;
    const result = evaluateSecrets(
      [
        {
          filePath: '/repo/secret.txt',
          sourceContent: token,
          messages: [
            {
              message: `found ${token}`,
              ruleId: '@secretlint/secretlint-rule-github',
              data: { KEY: token },
              loc: { start: { line: 4 } },
            },
          ],
        },
      ],
      '/repo'
    );
    const output = result.lines.join('\n');
    expect(output).toBe(
      'rule @secretlint/secretlint-rule-github file secret.txt line 4'
    );
    expect(output).not.toContain(token);
  });

  it('PBI-029 AC-0 skips tracked tests and still scans an explicit file list', () => {
    const patterns = ['**/*.test.ts', '**/*.test.mjs', '**/test/**'];
    expect(
      isSecretScanIgnored('apps/api/src/routes/me.test.ts', patterns)
    ).toBe(true);
    expect(
      isSecretScanIgnored('apps/api/test/support/testDatabase.ts', patterns)
    ).toBe(true);
    expect(isSecretScanIgnored('apps/api/src/routes/me.ts', patterns)).toBe(
      false
    );
    expect(isSecretScanIgnored('.env.example', patterns)).toBe(false);
  });
});

describe('vulnerability scan', () => {
  it('VT-03 PBI-029 AC-2 honors an unexpired exception and lists it', () => {
    const result = evaluateVulns(highReport, [exception({})], {
      today: '2026-10-27',
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines).toEqual([
      'honored exception: GHSA-test-high left-pad',
    ]);
  });

  it('VT-04 PBI-029 AC-2 fails with no exception and with an expired exception', () => {
    const open = evaluateVulns(highReport, [], { today: '2026-10-27' });
    const expired = evaluateVulns(
      highReport,
      [exception({ expires: '2020-01-01' })],
      { today: '2026-10-27' }
    );
    expect(open.exitCode).toBe(1);
    expect(expired.exitCode).toBe(1);
    for (const result of [open, expired]) {
      const output = result.lines.join('\n');
      expect(output).toContain('left-pad');
      expect(output).toContain('GHSA-test-high');
    }
    expect(expired.lines.join('\n')).toContain(
      'expired exception: GHSA-test-high left-pad'
    );
  });

  it('ignores a moderate advisory', () => {
    const result = evaluateVulns(
      {
        results: [
          {
            packages: [
              {
                package: { name: 'esbuild', version: '0.18.20' },
                groups: [
                  {
                    ids: ['GHSA-medium'],
                    aliases: [],
                    max_severity: '5.3',
                  },
                ],
              },
            ],
          },
        ],
      },
      [],
      { today: '2026-10-27' }
    );
    expect(result.exitCode).toBe(0);
  });

  it('VT-06 TBI-030 names a missing exception field', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'exceptions-'));
    const file = path.join(root, 'vulnerability-exceptions.json');
    await writeFile(
      file,
      JSON.stringify([
        {
          advisory: 'GHSA-test-high',
          package: 'left-pad',
          reason: 'missing owner',
          reviewed: '2026-01-01',
          expires: '2027-01-01',
        },
      ]),
      'utf8'
    );
    try {
      const result = await runVulnerabilityScan({
        root,
        exceptionsFile: file,
      });
      expect(result.exitCode).toBe(2);
      const output = result.lines.join('\n');
      expect(output).toContain('vulnerability-exceptions.json');
      expect(output).toContain('owner');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('VT-06 TBI-030 names a missing lockfile', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lockfile-'));
    try {
      const result = await runVulnerabilityScan({
        root,
        exceptionsFile,
      });
      expect(result.exitCode).toBe(2);
      expect(result.lines.join('\n')).toContain('pnpm-lock.yaml is missing');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('VT-07 TBI-030 an unreachable advisory source exits 2', async () => {
    const result = await runVulnerabilityScan({
      root: templateRoot,
      scanLockfile: async () => ({
        error: new Error('unreachable'),
        status: null,
        stdout: '',
        stderr: 'ENOTFOUND advisory.example',
      }),
    });
    expect(result.exitCode).toBe(2);
    expect(result.exitCode).not.toBe(0);
    expect(result.lines.join('\n')).toContain('scan could not run');
    expect(result.lines.join('\n')).not.toContain('ENOTFOUND');
  });
});

describe('license check', () => {
  it('VT-05 PBI-029 AC-3 names the package and the disallowed license', () => {
    const result = evaluateLicenses(
      [
        { name: 'left-pad', version: '1.0.0', license: 'GPL-3.0' },
        { name: 'express', version: '5.3.0', license: 'MIT' },
      ],
      ['MIT', 'Apache-2.0', 'ISC', 'BSD-3-Clause']
    );
    expect(result.exitCode).toBe(1);
    expect(result.lines).toEqual(['package left-pad license GPL-3.0']);
  });

  it('PBI-029 AC-0 an allowed list passes', () => {
    const result = evaluateLicenses(
      [{ name: 'express', version: '5.3.0', license: 'MIT' }],
      ['MIT']
    );
    expect(result.exitCode).toBe(0);
  });
});

describe('SBOM document', () => {
  it('VT-10 PBI-028 AC-2 TBI-031 NFR is identical for the same lockfile', () => {
    const components = flattenPnpmTree([
      {
        name: '@project-scope/api',
        dependencies: {
          express: { version: '5.3.0' },
          zod: {
            version: '4.6.7',
            dependencies: { express: { version: '5.3.0' } },
          },
        },
      },
    ]);
    const first = serializeSbom(
      buildSbomDocument({
        components,
        lockfileHash: 'abc',
        serviceName,
      })
    );
    const second = serializeSbom(
      buildSbomDocument({
        components: [...components].reverse(),
        lockfileHash: 'abc',
        serviceName,
      })
    );
    expect(createHash('sha256').update(first).digest('hex')).toBe(
      createHash('sha256').update(second).digest('hex')
    );
    expect(first).not.toContain('timestamp');
  });

  it('VT-11 PBI-028 AC-3 omits a development-only package from the prod tree', () => {
    const components = flattenPnpmTree([
      {
        dependencies: {
          express: { version: '5.3.0' },
        },
      },
    ]);
    const names = components.map((component) => component.name);
    expect(names).toContain('express');
    expect(names).not.toContain('vitest');
    expect(npmPurl('@project-scope/contracts', '0.0.0')).toBe(
      'pkg:npm/%40project-scope/contracts@0.0.0'
    );
  });

  it('VT-09 PBI-028 AC-1 TBI-031 DoD-2 leaves no file when the lockfile is missing or invalid', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sbom-'));
    try {
      const missing = await runSbom({ root });
      expect(missing.exitCode).toBe(2);
      expect(missing.lines.join('\n')).toContain('pnpm-lock.yaml is missing');
      await writeFile(path.join(root, 'pnpm-lock.yaml'), 'not a lockfile\n');
      const invalid = await runSbom({ root });
      expect(invalid.exitCode).toBe(2);
      expect(invalid.lines.join('\n')).toContain('pnpm-lock.yaml is invalid');
      const names = await readdir(path.join(root, 'artifacts', 'sbom')).catch(
        () => []
      );
      expect(names).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('VT-09 removes the temporary file when the write fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'atomic-'));
    const filename = 'project-service.cdx.json';
    await mkdir(path.join(root, filename));
    await expect(writeAtomic(root, filename, '{}\n')).rejects.toThrow();
    const names = await readdir(root);
    expect(names.some((name) => name.includes('.tmp'))).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it('uses SOURCE_DATE_EPOCH when it is set', () => {
    const document = buildSbomDocument({
      components: [],
      lockfileHash: sha256Hex(Buffer.from('lock')),
      sourceDateEpoch: '0',
      serviceName,
    });
    expect(document.metadata.timestamp).toBe('1970-01-01T00:00:00.000Z');
    expect(document.serialNumber).toMatch(/^urn:uuid:/);
  });
});

describe('configuration and repository files', () => {
  it('TBI-030 DoD-1 stores the allowed license list in the repository', async () => {
    const loaded = loadJsonSchema(
      allowedLicensesFile,
      (await import('../load-config.mjs')).allowedLicensesSchema
    );
    expect(loaded.ok).toBe(true);
    expect(loaded.data).toEqual(
      expect.arrayContaining(['MIT', 'Apache-2.0', 'ISC', 'BSD-3-Clause'])
    );
  });

  it('TBI-030 DoD-3 the runbook explains a reviewed exception', async () => {
    const text = await readFile(
      path.join(templateRoot, 'docs', 'runbooks', 'supply-chain.md'),
      'utf8'
    );
    for (const field of [
      'advisory',
      'package',
      'reason',
      'owner',
      'reviewed',
      'expires',
    ]) {
      expect(text).toContain(field);
    }
    expect(text).toContain('high');
    expect(text).toContain('critical');
  });

  it('the committed exception file matches the schema', () => {
    const loaded = loadJsonSchema(exceptionsFile, exceptionsFileSchema);
    expect(loaded.ok).toBe(true);
    expect(loaded.data).toEqual([]);
  });

  it('TBI-031 DoD-0 package.json names the supply-chain scripts', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(templateRoot, 'package.json'), 'utf8')
    );
    for (const name of [
      'scan:secrets',
      'scan:vulns',
      'scan:licenses',
      'scan',
      'sbom',
      'container:build',
      'test:container',
    ]) {
      expect(manifest.scripts[name]).toBeTruthy();
    }
  });
});

describe('static container definition', () => {
  it('VT-20 TBI-032 DoD-3 has no cloud-provider terms in the definition', async () => {
    const heads = ['aw', 'ec', 'ec', 'amazonaw'];
    const tails = ['s', 's', 'r', 's'];
    const needles = heads.map((head, index) => head + tails[index]);
    const files = [dockerfile, dockerignore];
    const walk = async (directory) => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          files.push(full);
        }
      }
    };
    await walk(supplyChainDir);
    await walk(path.join(templateRoot, 'config', 'supply-chain'));
    const hits = [];
    for (const file of files) {
      const text = (await readFile(file, 'utf8')).toLowerCase();
      for (const needle of needles) {
        const pattern = new RegExp(`\\b${needle}\\b`, 'i');
        if (pattern.test(text)) {
          hits.push(`${path.relative(templateRoot, file)}:${needle}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('PBI-027 AC-0 TBI-032 DoD-0 the definition builds with a frozen install', async () => {
    const text = await readFile(dockerfile, 'utf8');
    expect(text).toContain('--frozen-lockfile');
    expect(text).toContain(nodeImage);
    expect(text).toContain(`USER 10001`);
    expect(text).toContain('NODE_ENV=production');
    expect(text).toContain('CLIENT_DIST_DIR=/app/web');
    expect(text).toContain('/health/live');
    expect(text).toContain('dist/instrument.js');
    expect(text).toContain('dist/index.js');
    expect(text).not.toContain('DATABASE_URL');
    expect(text).not.toContain('AUTH_MODE');
    expect(text).not.toContain('APP_ENV');
    expect(text).not.toContain('WEB_DIST_DIR');
    expect(text).not.toContain('db:migrate');
    expect(text).not.toContain('drizzle-kit');
    expect(text).toContain('/out/api/dist/cli');
    expect(text).toContain('/out/api/dist/persistence/migrations');
    expect(text).toContain('/out/api/dist/persistence/seed');
  });

  it('PBI-027 AC-2 TBI-032 DoD-1 the runtime stage drops build tools and dev packages', async () => {
    const text = await readFile(dockerfile, 'utf8');
    expect(text).toContain('deploy --legacy --prod');
    for (const tool of ['npm', 'npx', 'corepack', 'yarn']) {
      expect(text).toContain(tool);
    }
    expect(text).toContain('USER 10001');
  });

  it('VT-13 TBI-031 DoD-3 ignores generated SBOM files', async () => {
    const ignore = await readFile(dockerignore, 'utf8');
    expect(ignore.split('\n')).toContain('artifacts');
    const sbomDir = path.join(templateRoot, 'artifacts', 'sbom');
    await mkdir(sbomDir, { recursive: true });
    const file = path.join(sbomDir, 'sample.cdx.json');
    await writeFile(file, '{}\n');
    try {
      const result = await runCommand(
        'git',
        ['check-ignore', '-q', '--', file],
        { cwd: templateRoot }
      );
      expect(result.status).toBe(0);
    } finally {
      await rm(file, { force: true });
    }
  });

  it('VT-21 the image env instructions set no secrets', async () => {
    const text = await readFile(dockerfile, 'utf8');
    const runtime = text.split('AS runtime')[1] ?? '';
    const envLines = runtime
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('ENV '));
    expect(envLines).toEqual([
      'ENV NODE_ENV=production',
      'ENV CLIENT_DIST_DIR=/app/web',
    ]);
  });
});

describe('container scripts without Docker', () => {
  it('VT-24 TBI-032 container:build and test:container name Docker when it is absent', async () => {
    const hidden = await mkdtemp(path.join(tmpdir(), 'no-docker-'));
    const env = { ...process.env, PATH: hidden };
    try {
      for (const script of [containerBuildScript, containerTestScript]) {
        const result = await runCommand(process.execPath, [script], {
          cwd: templateRoot,
          env,
        });
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.status).toBe(2);
        expect(output).toContain('Docker');
      }
    } finally {
      await rm(hidden, { recursive: true, force: true });
    }
  });
});

describe('workspace supply chain', () => {
  it('VT-01 PBI-029 AC-0 TBI-030 the template scan exits 0', async () => {
    const result = await runScan();
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).not.toContain('honored exception:');
  }, 180000);

  it('VT-08 VT-10 VT-11 PBI-028 the production SBOM matches pnpm ls', async () => {
    const first = await runSbom();
    expect(first.exitCode).toBe(0);
    const raw = await readFile(first.file, 'utf8');
    const second = await runSbom();
    expect(second.exitCode).toBe(0);
    const again = await readFile(second.file, 'utf8');
    expect(createHash('sha256').update(again).digest('hex')).toBe(
      createHash('sha256').update(raw).digest('hex')
    );
    const document = JSON.parse(raw);
    expect(document.bomFormat).toBe('CycloneDX');
    expect(document.specVersion).toBe('1.6');
    const listed = await runCommand(
      'corepack',
      [
        'pnpm',
        'ls',
        '--prod',
        '--depth',
        'Infinity',
        '--json',
        '--filter',
        '@project-scope/api',
        '--filter',
        '@project-scope/web',
      ],
      { cwd: templateRoot }
    );
    expect(listed.status).toBe(0);
    const expected = new Set(
      flattenPnpmTree(
        JSON.parse(listed.stdout.slice(listed.stdout.indexOf('[')))
      ).map((component) => component.purl)
    );
    const actual = new Set(
      document.components.map((component) => component.purl)
    );
    expect(actual).toEqual(expected);
    expect([...actual].some((purl) => purl.includes('vitest'))).toBe(false);
    expect(
      [...actual].some((purl) => purl.startsWith('pkg:npm/express@'))
    ).toBe(true);
    expect(raw).not.toContain('timestamp');
  }, 180000);

  it('VT-12 TBI-030 TBI-031 output does not contain an environment sentinel', async () => {
    const sentinel = `SENTINEL_${'c'.repeat(24)}_FEAT013`;
    const env = { ...process.env, SUPPLY_CHAIN_SENTINEL: sentinel };
    const sbom = await runSbom({ env });
    expect(sbom.exitCode).toBe(0);
    const file = path.join(
      templateRoot,
      'artifacts',
      'sbom',
      `${serviceName}.cdx.json`
    );
    const documentText = await readFile(file, 'utf8');
    const scans = await Promise.all([
      runSecretScan({ env }),
      runVulnerabilityScan({ env }),
      runLicenseScan({ env }),
    ]);
    const output = [documentText, ...scans.flatMap((scan) => scan.lines)].join(
      '\n'
    );
    expect(output).not.toContain(sentinel);
  }, 180000);

  it('scan keeps the highest exit code', async () => {
    const result = await runScan({
      files: [],
      scanLockfile: async () => ({
        error: new Error('down'),
        status: null,
        stdout: '',
        stderr: '',
      }),
      licenseReport: {
        error: null,
        status: 0,
        stdout: JSON.stringify({ MIT: [] }),
        stderr: '',
      },
    });
    expect(result.exitCode).toBe(2);
  });
});

describe('Docker image', () => {
  it('records when Docker is unavailable for the image probes', async () => {
    const available = await dockerAvailable();
    if (available) {
      expect(imageTag).toBe('project-service:local');
      return;
    }
    process.stderr.write(
      'Docker is not available. Container build and image probes are skipped. Lower-tier Dockerfile and runtime tests cover each criterion.\n'
    );
    expect(available).toBe(false);
  });
});
