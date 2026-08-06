/**
 * Tests for the install/bootstrap scope gates added in 1.0.1:
 *  - bare `install` (no skill names, no --all) exits with a clear error
 *  - bare `bootstrap` without a lockfile exits with a clear error
 *  - bare `bootstrap` with a lockfile uses only locked skills
 *  - `--all` still installs/bootstraps the full catalog
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cmdInstall, cmdBootstrap } from '../lib/commands.mjs';
import { executeInstall } from '../lib/install.mjs';
import { PKG_ROOT, makeRepo, cleanup, SAMPLE_REPO } from './helpers.mjs';

// ── install gate ──────────────────────────────────────────────────────────────

test('bare install (no skills, no --all) refuses with an actionable error', () => {
  const repo = makeRepo(SAMPLE_REPO);
  const logs = [];
  try {
    const code = cmdInstall({ _: [], all: false, cwd: repo, package: PKG_ROOT }, (m) => logs.push(m));
    assert.equal(code, 1);
    const combined = logs.join('\n');
    assert.match(combined, /No skills specified/);
    assert.match(combined, /--all/);
    // Nothing should have been written.
    assert.equal(fs.existsSync(path.join(repo, 'apex-skills.lock.json')), false);
  } finally {
    cleanup(repo);
  }
});

test('install with explicit skill names still works (via executeInstall)', () => {
  // cmdInstall triggers live doctor (requires real registry). Test the underlying
  // install logic directly — cmdInstall gate is covered by the bare-install test above.
  const repo = makeRepo(SAMPLE_REPO);
  try {
    const res = executeInstall(PKG_ROOT, repo, ['ui-lab']);
    assert.equal(res.dryRun, false);
    assert.ok(fs.existsSync(path.join(repo, 'apex-skills.lock.json')));
  } finally {
    cleanup(repo);
  }
});

test('install --all via cmdInstall: gate passes when all=true', () => {
  // Verify the gate logic: all=true should NOT produce the "No skills" error.
  // We only check the gate itself (not a full live install) to avoid doctor.
  const repo = makeRepo(SAMPLE_REPO);
  const logs = [];
  // Patch: call cmdInstall with all=true but expect it to proceed past the gate
  // (will fail at doctor in CI without registry — we just assert it doesn't emit the gate error).
  cmdInstall({ _: [], all: true, cwd: repo, package: PKG_ROOT }, (m) => logs.push(m));
  const combined = logs.join('\n');
  assert.ok(
    !combined.includes('No skills specified'),
    '--all should not trigger the bare-install gate error',
  );
  cleanup(repo);
});

// ── bootstrap gate ────────────────────────────────────────────────────────────

test('bare bootstrap with no lockfile refuses with an actionable error', () => {
  const repo = makeRepo(SAMPLE_REPO);
  const logs = [];
  try {
    const code = cmdBootstrap({ _: [], all: false, cwd: repo, package: PKG_ROOT }, (m) => logs.push(m));
    assert.equal(code, 1);
    const combined = logs.join('\n');
    assert.match(combined, /No apex-skills\.lock\.json/);
    assert.match(combined, /--all/);
  } finally {
    cleanup(repo);
  }
});

test('bare bootstrap uses only skills from lockfile', () => {
  const repo = makeRepo(SAMPLE_REPO);
  const logs = [];
  try {
    // Install only ui-lab so the lockfile has exactly one skill.
    executeInstall(PKG_ROOT, repo, ['ui-lab']);

    const code = cmdBootstrap({ _: [], all: false, cwd: repo, package: PKG_ROOT }, (m) => logs.push(m));
    assert.equal(code, 0);
    // Should mention ui-lab.
    assert.ok(logs.some((l) => l.includes('ui-lab')));
    // Should NOT have bootstrapped any other skill.
    assert.ok(!logs.some((l) => /Bootstrapped "[^"]*"/.test(l) && !l.includes('ui-lab')));
  } finally {
    cleanup(repo);
  }
});

test('bare bootstrap --all scopes to lockfile skills, not the full catalog', () => {
  const repo = makeRepo(SAMPLE_REPO);
  const logs = [];
  try {
    executeInstall(PKG_ROOT, repo, ['ui-lab']);

    const code = cmdBootstrap({ _: [], all: true, cwd: repo, package: PKG_ROOT }, (m) => logs.push(m));
    assert.equal(code, 0);
    assert.ok(logs.some((l) => /scopes to 1 installed skill/.test(l)));
    const bootstrapped = logs.filter((l) => /Bootstrapped "/.test(l));
    assert.equal(bootstrapped.length, 1, '--all must not expand beyond the lockfile');
    assert.ok(bootstrapped[0].includes('ui-lab'));
  } finally {
    cleanup(repo);
  }
});

test('bootstrap with explicit skill names ignores lockfile', () => {
  const repo = makeRepo(SAMPLE_REPO);
  const logs = [];
  try {
    // No install, no lockfile — named bootstrap should still work.
    const code = cmdBootstrap({ _: ['ui-lab'], all: false, cwd: repo, package: PKG_ROOT }, (m) => logs.push(m));
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes('ui-lab')));
  } finally {
    cleanup(repo);
  }
});
