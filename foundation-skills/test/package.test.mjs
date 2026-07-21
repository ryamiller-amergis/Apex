import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validatePackage } from '../lib/validatePackage.mjs';
import { checkRepo } from '../lib/check.mjs';
import { runDoctor } from '../lib/doctor.mjs';
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

test('doctor passes hard prerequisites in this environment', () => {
  const result = runDoctor({ checkFeed: false });
  assert.equal(result.ok, true);
  assert.ok(result.checks.find((c) => c.id === 'node').ok);
});

test('check reports installed vs available after install', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['ui-lab']);
    const res = checkRepo(PKG_ROOT, repo);
    assert.equal(res.installed, true);
    assert.equal(res.installedSuite, '0.1.0');
    assert.equal(res.skills[0].name, 'ui-lab');
    assert.equal(res.skills[0].compatible, true);
    assert.equal(res.skills[0].drift, false);
  } finally {
    cleanup(repo);
  }
});
