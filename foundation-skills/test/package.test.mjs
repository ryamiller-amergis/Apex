import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validatePackage } from '../lib/validatePackage.mjs';
import { checkRepo } from '../lib/check.mjs';
import { runDoctor, formatDoctor } from '../lib/doctor.mjs';
import { executeInstall } from '../lib/install.mjs';
import { PKG_ROOT, makeRepo, cleanup, SAMPLE_REPO } from './helpers.mjs';

test('the shipped package validates cleanly', () => {
  const result = validatePackage(PKG_ROOT);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('no-project-context lint catches a foreign reference in a foundation', () => {
  // Copy package to temp, inject a MaxView reference into a foundation file.
  const tmp = makeRepo({});
  try {
    const dst = path.join(tmp, 'pkg');
    fs.cpSync(PKG_ROOT, dst, { recursive: true, filter: (src) => !src.includes('node_modules') && !src.includes(`${path.sep}test${path.sep}`) });
    const foundation = path.join(dst, 'foundation/ui-lab/SKILL.md');
    fs.appendFileSync(foundation, '\nUse the MaxView color palette.\n');
    const result = validatePackage(dst);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /foreign-project reference/.test(e)));
  } finally {
    cleanup(tmp);
  }
});

test('doctor passes hard runtime prerequisites when registry/feed checks are skipped', () => {
  const result = runDoctor({ requireRegistry: false, requireFeed: false });
  assert.equal(result.ok, true);
  assert.ok(result.checks.find((c) => c.id === 'node').ok);
  assert.equal(result.checks.find((c) => c.id === 'apex-registry'), undefined);
  assert.equal(result.checks.find((c) => c.id === 'feed'), undefined);
});

test('doctor hard-fails when project has no @apex:registry', () => {
  const repo = makeRepo({
    ...SAMPLE_REPO,
    '.cursor/rules/.gitkeep': '',
  });
  try {
    const result = runDoctor({
      repoRoot: repo,
      requireRegistry: true,
      requireFeed: false, // isolate registry gate from network
    });
    assert.equal(result.ok, false);
    const reg = result.checks.find((c) => c.id === 'apex-registry');
    assert.ok(reg);
    assert.equal(reg.ok, false);
    assert.equal(reg.hard, true);
    assert.match(reg.remediation, /@apex:registry=/);
    assert.match(reg.remediation, /init-registry/);
    assert.match(reg.remediation, /vsts-npm-auth/);
    assert.match(formatDoctor(result), /Hard prerequisites missing/);
  } finally {
    cleanup(repo);
  }
});

test('doctor mentions .npmrc.template when present but local .npmrc lacks @apex', () => {
  const repo = makeRepo({
    ...SAMPLE_REPO,
    '.npmrc.template':
      '@maxview:registry=https://pkgs.dev.azure.com/amergis/MaxView/_packaging/maxview-core/npm/registry/\n' +
      '@apex:registry=https://pkgs.dev.azure.com/amergis/_packaging/apex-skills/npm/registry/\n' +
      'always-auth=true\n',
  });
  try {
    const result = runDoctor({
      repoRoot: repo,
      requireRegistry: true,
      requireFeed: false,
    });
    assert.equal(result.ok, false);
    const reg = result.checks.find((c) => c.id === 'apex-registry');
    assert.match(reg.detail, /npmrc\.template/);
    assert.match(reg.remediation, /init-registry/);
  } finally {
    cleanup(repo);
  }
});

test('doctor passes apex-registry when .npmrc defines @apex:registry', () => {
  const repo = makeRepo({
    ...SAMPLE_REPO,
    '.npmrc':
      '@apex:registry=https://pkgs.dev.azure.com/example/_packaging/apex-skills/npm/registry/\n' +
      'always-auth=true\n',
  });
  try {
    const result = runDoctor({
      repoRoot: repo,
      requireRegistry: true,
      requireFeed: false,
    });
    const reg = result.checks.find((c) => c.id === 'apex-registry');
    assert.ok(reg?.ok);
    assert.match(reg.detail, /pkgs\.dev\.azure\.com\/example/);
    // Feed skipped — only registry was required
    assert.equal(result.ok, true);
  } finally {
    cleanup(repo);
  }
});

test('check reports installed vs available after install', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['ui-lab']);
    const res = checkRepo(PKG_ROOT, repo);
    assert.equal(res.installed, true);
    assert.equal(res.installedSuite, '0.2.0');
    assert.equal(res.skills[0].name, 'ui-lab');
    assert.equal(res.skills[0].compatible, true);
    assert.equal(res.skills[0].drift, false);
  } finally {
    cleanup(repo);
  }
});
