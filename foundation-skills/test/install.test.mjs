import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { executeInstall, planInstall } from '../lib/install.mjs';
import { readLockfile, lockfileIntegrity } from '../lib/lockfile.mjs';
import { PKG_ROOT, makeRepo, cleanup, SAMPLE_REPO } from './helpers.mjs';

test('install vendors foundation, scaffolds adapter, writes lockfile', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    const res = executeInstall(PKG_ROOT, repo, ['ui-lab']);
    assert.equal(res.dryRun, false);
    assert.ok(fs.existsSync(path.join(repo, '.apex/foundation/ui-lab/SKILL.md')));
    assert.ok(fs.existsSync(path.join(repo, '.cursor/skills/ui-lab/SKILL.md')));
    assert.ok(fs.existsSync(path.join(repo, 'apex-skills.lock.json')));

    const lock = readLockfile(repo);
    assert.equal(lock.suiteVersion, '0.1.0');
    assert.ok(lock.skills['ui-lab'].vendored['.apex/foundation/ui-lab/SKILL.md']);
    assert.equal(lock.skills['ui-lab'].adapterScaffolded, true);
    // Integrity is reproducible.
    assert.equal(typeof lock.integrity, 'string');
    assert.equal(lock.integrity, lockfileIntegrity({ ...lock, integrity: undefined }));
  } finally {
    cleanup(repo);
  }
});

test('never clobbers a pre-existing team adapter', () => {
  const repo = makeRepo({ ...SAMPLE_REPO, '.cursor/skills/ui-lab/SKILL.md': '# my edits\n' });
  try {
    const res = executeInstall(PKG_ROOT, repo, ['ui-lab']);
    const content = fs.readFileSync(path.join(repo, '.cursor/skills/ui-lab/SKILL.md'), 'utf8');
    assert.equal(content, '# my edits\n');
    assert.ok(res.warnings.some((w) => /already exists/.test(w)));
  } finally {
    cleanup(repo);
  }
});

test('dry-run writes nothing', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    const res = executeInstall(PKG_ROOT, repo, ['ui-lab'], { dryRun: true });
    assert.equal(res.dryRun, true);
    assert.equal(fs.existsSync(path.join(repo, '.apex/foundation/ui-lab/SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(repo, 'apex-skills.lock.json')), false);
  } finally {
    cleanup(repo);
  }
});

test('unknown skill aborts with error', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    assert.throws(() => executeInstall(PKG_ROOT, repo, ['does-not-exist']), /Unknown skill/);
  } finally {
    cleanup(repo);
  }
});

test('checksum drift on managed file aborts re-install', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['ui-lab']);
    // Tamper with a managed vendored file.
    const managed = path.join(repo, '.apex/foundation/ui-lab/SKILL.md');
    fs.appendFileSync(managed, '\nhand edit\n');
    assert.throws(() => executeInstall(PKG_ROOT, repo, ['ui-lab']), /checksum drift/);
  } finally {
    cleanup(repo);
  }
});

test('re-install after edits preserves adapter and re-vendors foundation', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['ui-lab']);
    const adapterPath = path.join(repo, '.cursor/skills/ui-lab/SKILL.md');
    fs.writeFileSync(adapterPath, '# team owns this\n');
    const res = executeInstall(PKG_ROOT, repo, ['ui-lab']);
    assert.equal(fs.readFileSync(adapterPath, 'utf8'), '# team owns this\n');
    assert.ok(res.warnings.some((w) => /already exists/.test(w)));
  } finally {
    cleanup(repo);
  }
});

test('plan reports actions without writing', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    const plan = planInstall(PKG_ROOT, repo, ['ui-lab']);
    assert.equal(plan.errors.length, 0);
    assert.equal(plan.actions.length, 1);
    assert.equal(fs.existsSync(path.join(repo, 'apex-skills.lock.json')), false);
  } finally {
    cleanup(repo);
  }
});
