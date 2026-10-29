import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../check-toolchain.mjs'
);

function validFiles() {
  const node = '24.0.0';
  const range = '>=24.0.0 <25.0.0';
  const pnpm = '12.15.0';
  return {
    'package.json': JSON.stringify({
      name: '@project-scope/project-name',
      packageManager: `pnpm@${pnpm}+sha512.abc`,
      engines: { node: range, pnpm },
    }),
    '.nvmrc': `${node}\n`,
    'pnpm-workspace.yaml': [
      'packages:',
      "  - 'apps/*'",
      "  - 'packages/*'",
      'catalog:',
      '  typescript: 6.0.3',
      "  '@types/node': 24.19.2",
      'onlyBuiltDependencies: []',
      '',
    ].join('\n'),
    'docs/compatibility.md': [
      '# Compatibility',
      '',
      '| Component | Pinned version | Source | Installed in |',
      '| --- | --- | --- | --- |',
      `| Node | ${node} | implementation-date latest stable | .nvmrc |`,
      `| pnpm | ${pnpm} | implementation-date latest stable | packageManager |`,
      '| typescript | 6.0.3 | implementation-date latest stable | apps/api |',
      '| @types/node | 24.19.2 | implementation-date latest stable | reserved |',
      '',
    ].join('\n'),
    'packages/config/package.json': JSON.stringify({
      name: '@project-scope/config',
      devDependencies: { typescript: 'catalog:' },
    }),
    'packages/config/tsconfig.json': JSON.stringify({
      extends: './tsconfig.base.json',
    }),
    'apps/api/package.json': JSON.stringify({
      name: '@project-scope/api',
      devDependencies: {
        typescript: 'catalog:',
        '@project-scope/config': 'workspace:*',
      },
    }),
    'apps/api/tsconfig.json': JSON.stringify({
      extends: '@project-scope/config/tsconfig.node.json',
    }),
  };
}

async function withFixture(files, fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'toolchain-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content);
    }
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function run(root, args = [], env = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args, root], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('VT-08 valid workspace exits 0 and prints no failure', async () => {
  await withFixture(validFiles(), async (root) => {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });
});

test('VT-08 non-exact catalog version fails', async () => {
  const files = validFiles();
  files['pnpm-workspace.yaml'] = files['pnpm-workspace.yaml'].replace(
    'typescript: 6.0.3',
    'typescript: ^6.0.3'
  );
  await withFixture(files, async (root) => {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /catalog entry typescript has non-exact version "\^6\.0\.3"/
    );
  });
});

test('VT-08 inline member dependency fails and names the member', async () => {
  const files = validFiles();
  const api = JSON.parse(files['apps/api/package.json']);
  api.dependencies = { 'left-pad': '1.0.0' };
  files['apps/api/package.json'] = JSON.stringify(api);
  await withFixture(files, async (root) => {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /check-toolchain: @project-scope\/api: left-pad uses "1\.0\.0" but must use "catalog:" or "workspace:\*"/
    );
  });
});

test('VT-08 TBI-002 DoD-3 missing compatibility row fails', async () => {
  const files = validFiles();
  files['docs/compatibility.md'] = files['docs/compatibility.md'].replace(
    '| typescript | 6.0.3 | implementation-date latest stable | apps/api |\n',
    ''
  );
  await withFixture(files, async (root) => {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /docs\/compatibility\.md is missing a row for typescript 6\.0\.3/
    );
  });
});

test('VT-08 table version disagreeing with the catalog fails', async () => {
  const files = validFiles();
  files['docs/compatibility.md'] = files['docs/compatibility.md'].replace(
    '| typescript | 6.0.3 |',
    '| typescript | 1.2.3 |'
  );
  await withFixture(files, async (root) => {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /docs\/compatibility\.md lists typescript 1\.2\.3 but the catalog pins 6\.0\.3/
    );
  });
});

test('VT-08 .nvmrc outside engines.node fails', async () => {
  const files = validFiles();
  files['.nvmrc'] = '22.0.0\n';
  files['docs/compatibility.md'] = files['docs/compatibility.md'].replace(
    '| Node | 24.0.0 |',
    '| Node | 22.0.0 |'
  );
  await withFixture(files, async (root) => {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /\.nvmrc 22\.0\.0 is outside engines\.node >=24\.0\.0 <25\.0\.0/
    );
  });
});

test('VT-08 packageManager and engines.pnpm mismatch fails', async () => {
  const files = validFiles();
  const manifest = JSON.parse(files['package.json']);
  manifest.packageManager = 'pnpm@1.2.3';
  manifest.engines.pnpm = '9.9.9';
  files['package.json'] = JSON.stringify(manifest);
  files['docs/compatibility.md'] = files['docs/compatibility.md'].replace(
    '| pnpm | 12.15.0 |',
    '| pnpm | 1.2.3 |'
  );
  await withFixture(files, async (root) => {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /packageManager pnpm@1\.2\.3 does not equal engines\.pnpm 9\.9\.9/
    );
  });
});

test('VT-08 TBI-003 DoD-1 member tsconfig without the shared extends fails', async () => {
  const files = validFiles();
  files['apps/api/tsconfig.json'] = JSON.stringify({
    extends: './local.json',
  });
  await withFixture(files, async (root) => {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /check-toolchain: @project-scope\/api: tsconfig\.json must extend @project-scope\/config\/tsconfig\.node\.json/
    );
  });
});

test('VT-08 unsupported engines.node grammar fails with its own message', async () => {
  const files = validFiles();
  const manifest = JSON.parse(files['package.json']);
  manifest.engines.node = '>=24';
  files['package.json'] = JSON.stringify(manifest);
  await withFixture(files, async (root) => {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /engines\.node ">=24" must match ">=X\.Y\.Z <N\.0\.0"/
    );
  });
});

test('VT-08 extra compatibility row fails', async () => {
  const files = validFiles();
  files['docs/compatibility.md'] +=
    '| left-pad | 1.0.0 | implementation-date latest stable | reserved |\n';
  await withFixture(files, async (root) => {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /docs\/compatibility\.md lists left-pad 1\.0\.0 but the catalog has no entry for it/
    );
  });
});

test('VT-08 PBI-001 AC-2 preinstall rejects an npm user agent', async () => {
  const files = validFiles();
  files['package-lock.json'] = '{}\n';
  await withFixture(files, async (root) => {
    const result = run(root, ['--preinstall'], {
      npm_config_user_agent: 'npm/11.16.0 node/v24.0.0 win32 x64',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /this workspace uses pnpm/);
    assert.doesNotMatch(result.stderr, /does not match the pinned pnpm/);
    assert.equal(existsSync(path.join(root, 'package-lock.json')), false);
  });
});

test('VT-08 TBI-002 DoD-1 preinstall rejects a different pnpm version', async () => {
  await withFixture(validFiles(), async (root) => {
    const result = run(root, ['--preinstall'], {
      npm_config_user_agent: `pnpm/1.2.3 npm/? node/${process.version} win32 x64`,
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /pnpm 1\.2\.3 does not match the pinned pnpm 12\.15\.0/
    );
  });
});

test('VT-08 TBI-002 DoD-1 preinstall rejects a Node version outside engines.node', async () => {
  const files = validFiles();
  const manifest = JSON.parse(files['package.json']);
  manifest.engines.node = '>=1.0.0 <2.0.0';
  files['package.json'] = JSON.stringify(manifest);
  await withFixture(files, async (root) => {
    const nodeVersion = process.version.replace(/^v/, '');
    const result = run(root, ['--preinstall'], {
      npm_config_user_agent: `pnpm/12.15.0 npm/? node/${process.version} win32 x64`,
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      new RegExp(
        `Node ${nodeVersion.replace(/\./g, '\\.')} is outside the supported range >=1\\.0\\.0 <2\\.0\\.0`
      )
    );
  });
});

test('VT-08 preinstall passes for the pinned pnpm and a Node version inside engines.node', async () => {
  const [major, minor, patch] = process.version.replace(/^v/, '').split('.');
  const files = validFiles();
  const manifest = JSON.parse(files['package.json']);
  manifest.engines.node = `>=${major}.${minor}.${patch} <${Number(major) + 1}.0.0`;
  files['package.json'] = JSON.stringify(manifest);
  await withFixture(files, async (root) => {
    const result = run(root, ['--preinstall'], {
      npm_config_user_agent: `pnpm/12.15.0 npm/? node/${process.version} win32 x64`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  });
});
