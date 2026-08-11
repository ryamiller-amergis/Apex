import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PKG_ROOT, makeRepo, cleanup, SAMPLE_REPO } from './helpers.mjs';

let workDir;
let extractedPackageRoot;
let packedFiles;

function listPackedFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        files.push(path.relative(root, absolute).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return files;
}

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-skills-packed-'));
  let tarball = process.env.APEX_SKILLS_TARBALL
    ? path.resolve(process.env.APEX_SKILLS_TARBALL)
    : null;
  if (!tarball) {
    const packOutput = execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', '--json', '--pack-destination', workDir],
      {
        cwd: PKG_ROOT,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      }
    );
    const [packResult] = JSON.parse(packOutput);
    assert.ok(packResult?.filename, 'npm pack must return a tarball filename');
    tarball = path.join(workDir, packResult.filename);
  }
  assert.ok(
    fs.existsSync(tarball),
    `packed artifact does not exist: ${tarball}`
  );

  const extractDir = path.join(workDir, 'extracted');
  fs.mkdirSync(extractDir);
  execFileSync('tar', ['-xzf', tarball, '-C', extractDir]);
  extractedPackageRoot = path.join(extractDir, 'package');
  packedFiles = new Set(listPackedFiles(extractedPackageRoot));
});

after(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

test('production package and suite versions are both 2.0.3', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extractedPackageRoot, 'package.json'), 'utf8')
  );
  const catalog = JSON.parse(
    fs.readFileSync(path.join(extractedPackageRoot, 'catalog.json'), 'utf8')
  );

  assert.equal(manifest.version, '2.0.3');
  assert.equal(catalog.suiteVersion, manifest.version);
});

test('packed artifact contains every catalog-declared foundation and adapter file', () => {
  const catalog = JSON.parse(
    fs.readFileSync(path.join(extractedPackageRoot, 'catalog.json'), 'utf8')
  );

  for (const skill of catalog.skills) {
    for (const rel of skill.foundationFiles) {
      assert.ok(
        packedFiles.has(`foundation/${skill.name}/${rel}`),
        `missing packed foundation/${skill.name}/${rel}`
      );
    }
    for (const rel of skill.adapterFiles) {
      assert.ok(
        packedFiles.has(`adapters/${skill.name}/${rel}`),
        `missing packed adapters/${skill.name}/${rel}`
      );
    }
  }
});

test('installer renders project adapter content from the packed artifact', async () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    const installerUrl = pathToFileURL(
      path.join(extractedPackageRoot, 'lib/install.mjs')
    ).href;
    const { executeInstall } = await import(installerUrl);
    executeInstall(extractedPackageRoot, repo, ['ui-lab']);
    const installed = fs.readFileSync(
      path.join(repo, '.cursor/skills/ui-lab/SKILL.md'),
      'utf8'
    );

    assert.match(installed, /UI Lab — Project Design System Adapter/);
    assert.match(installed, /APEX:BEGIN adapter/);
    assert.match(installed, /APEX:slot\(projectName\)/);
  } finally {
    cleanup(repo);
  }
});
