/**
 * Tests for the APEX entitlement gate added in 1.1.0.
 *
 * Covers the CLI-side half: remote sanitization, `.apex/config.json` read/write,
 * APEX_URL resolution, requested-skill partitioning, and the fail-closed /
 * cached-fallback behaviour of checkApexAuthorization.
 *
 * The network is never touched — checkApexAuthorization is exercised through the
 * paths that short-circuit before fetch (skip, no APEX_URL, cached config), and
 * through a stubbed global fetch for the authorized / denied paths.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  sanitizeRemote,
  readApexConfig,
  writeApexConfig,
  resolveApexUrl,
  partitionRequestedSkills,
  checkApexAuthorization,
  readPackageVersion,
  verifyArtifactVersion,
  CONFIG_REL_PATH,
} from '../lib/apexAuthorize.mjs';
import { makeRepo, cleanup, SAMPLE_REPO, PKG_ROOT } from './helpers.mjs';

const ORIGINAL_APEX_URL = process.env.APEX_URL;
const ORIGINAL_FETCH = globalThis.fetch;

/**
 * A fixture that is a real git repo with an `origin` remote, so these tests drive
 * detectGitRemote through its actual code path instead of stubbing it out.
 */
function makeGitRepo(remoteUrl = 'https://dev.azure.com/amergis/MaxView/_git/MaxView') {
  const root = makeRepo(SAMPLE_REPO);
  const run = (args) => spawnSync('git', args, { cwd: root, stdio: 'ignore', shell: true });
  run(['init']);
  run(['remote', 'add', 'origin', remoteUrl]);
  return root;
}

beforeEach(() => {
  delete process.env.APEX_URL;
});

afterEach(() => {
  if (ORIGINAL_APEX_URL === undefined) delete process.env.APEX_URL;
  else process.env.APEX_URL = ORIGINAL_APEX_URL;
  globalThis.fetch = ORIGINAL_FETCH;
});

// ── remote sanitization ───────────────────────────────────────────────────────

test('sanitizeRemote strips embedded credentials from https remotes', () => {
  assert.equal(
    sanitizeRemote('https://user:ghp_secrettoken@github.com/org/repo.git'),
    'https://github.com/org/repo.git',
  );
  assert.equal(
    sanitizeRemote('https://amergis@dev.azure.com/amergis/MaxView/_git/MaxView'),
    'https://dev.azure.com/amergis/MaxView/_git/MaxView',
  );
});

test('sanitizeRemote leaves scp-style ssh remotes intact', () => {
  // git@ is structural here, not a credential.
  assert.equal(
    sanitizeRemote('git@github.com:org/repo.git'),
    'git@github.com:org/repo.git',
  );
});

test('sanitizeRemote handles blank input', () => {
  assert.equal(sanitizeRemote(''), '');
  assert.equal(sanitizeRemote(undefined), '');
});

// ── config.json round-trip ────────────────────────────────────────────────────

test('writeApexConfig writes stable, sorted, newline-terminated JSON', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    writeApexConfig(repo, {
      apexProject: 'maxview',
      apexUrl: 'https://apex.example.com',
      repo: 'MaxView',
      releaseVersion: '1.0.0',
      authorizedSkills: ['to-prd', 'design-system', 'grill-with-docs'],
      authorizedAt: '2026-08-04T00:00:00.000Z',
    });

    const raw = fs.readFileSync(path.join(repo, CONFIG_REL_PATH), 'utf8');
    assert.ok(raw.endsWith('\n'), 'file should end with a newline');

    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed.authorizedSkills, ['design-system', 'grill-with-docs', 'to-prd']);
    assert.equal(parsed.apexProject, 'maxview');
    assert.equal(parsed.releaseVersion, '1.0.0');
  } finally {
    cleanup(repo);
  }
});

test('readApexConfig returns null for a missing or corrupt config', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    assert.equal(readApexConfig(repo), null);

    fs.mkdirSync(path.join(repo, '.apex'), { recursive: true });
    fs.writeFileSync(path.join(repo, CONFIG_REL_PATH), '{ not valid json', 'utf8');
    assert.equal(readApexConfig(repo), null);
  } finally {
    cleanup(repo);
  }
});

// ── APEX_URL resolution ───────────────────────────────────────────────────────

test('resolveApexUrl prefers APEX_URL env var and trims trailing slashes', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    process.env.APEX_URL = 'https://apex.example.com///';
    const resolved = resolveApexUrl(repo);
    assert.equal(resolved.url, 'https://apex.example.com');
    assert.match(resolved.source, /APEX_URL/);
  } finally {
    cleanup(repo);
  }
});

test('resolveApexUrl falls back to the recorded config when env is unset', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    writeApexConfig(repo, {
      apexProject: 'maxview',
      apexUrl: 'https://apex-from-config.example.com',
      authorizedSkills: ['to-prd'],
    });
    const resolved = resolveApexUrl(repo);
    assert.equal(resolved.url, 'https://apex-from-config.example.com');
    assert.equal(resolved.source, CONFIG_REL_PATH);
  } finally {
    cleanup(repo);
  }
});

test('resolveApexUrl returns null when neither source is present', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    assert.equal(resolveApexUrl(repo), null);
  } finally {
    cleanup(repo);
  }
});

// ── requested-skill partitioning ──────────────────────────────────────────────

test('partitionRequestedSkills separates released from unreleased skills', () => {
  const { allowed, rejected } = partitionRequestedSkills(
    ['to-prd', 'ui-lab', 'grill-with-docs'],
    ['to-prd', 'grill-with-docs'],
  );
  assert.deepEqual(allowed, ['to-prd', 'grill-with-docs']);
  assert.deepEqual(rejected, ['ui-lab']);
});

test('partitionRequestedSkills rejects companions absent from the authorized release manifest', () => {
  const { allowed, rejected } = partitionRequestedSkills(
    ['to-prd', 'post-skill-bootstrap'],
    ['to-prd'],
  );
  assert.deepEqual(allowed, ['to-prd']);
  assert.deepEqual(rejected, ['post-skill-bootstrap']);
});

test('partitionRequestedSkills allows everything when no allowlist is known', () => {
  const { allowed, rejected } = partitionRequestedSkills(['to-prd'], []);
  assert.deepEqual(allowed, ['to-prd']);
  assert.deepEqual(rejected, []);
});

// ── checkApexAuthorization ────────────────────────────────────────────────────

test('--skip-apex-check passes as a soft check without contacting APEX', async () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    globalThis.fetch = () => assert.fail('fetch must not be called when skipping');
    const check = await checkApexAuthorization({ repoRoot: repo, skip: true });
    assert.equal(check.ok, true);
    assert.equal(check.hard, false);
    assert.match(check.detail, /skipped/);
  } finally {
    cleanup(repo);
  }
});

test('missing APEX_URL with no prior authorization fails closed', async () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    const check = await checkApexAuthorization({ repoRoot: repo });
    assert.equal(check.ok, false);
    assert.equal(check.hard, true);
    assert.match(check.remediation, /APEX_URL/);
  } finally {
    cleanup(repo);
  }
});

test('a recorded authorization does NOT satisfy the check on its own', async () => {
  // Regression guard: accepting a cached grant made the gate bypassable in one
  // step and let a de-targeted project keep installing. It must fail closed.
  const repo = makeGitRepo();
  try {
    writeApexConfig(repo, {
      apexProject: 'maxview',
      apexUrl: null,
      repo: 'MaxView',
      releaseVersion: '1.0.0',
      authorizedSkills: ['to-prd'],
    });

    const check = await checkApexAuthorization({ repoRoot: repo });
    assert.equal(check.ok, false);
    assert.equal(check.hard, true);
    assert.match(check.remediation, /APEX_URL/);
  } finally {
    cleanup(repo);
  }
});

test('a recorded apexUrl is used to locate APEX, not to grant entitlement', async () => {
  const repo = makeGitRepo();
  try {
    writeApexConfig(repo, {
      apexProject: 'maxview',
      apexUrl: 'https://apex-from-config.example.com',
      repo: 'MaxView',
      releaseVersion: '1.0.0',
      authorizedSkills: ['to-prd'],
    });

    let requestedUrl = null;
    globalThis.fetch = async (url) => {
      requestedUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          authorized: false,
          reason: 'no-release',
          repo: 'MaxView',
          apexProject: 'maxview',
          version: null,
          artifactVersion: null,
          skills: [],
          message: 'De-targeted.',
        }),
      };
    };

    const check = await checkApexAuthorization({ repoRoot: repo });
    // The URL came from config, but APEX's live "no" overrides the recorded grant.
    assert.match(requestedUrl, /apex-from-config\.example\.com/);
    assert.equal(check.ok, false);
    assert.match(check.detail, /no-release/);
  } finally {
    cleanup(repo);
  }
});

test('an APEX denial fails hard and surfaces the server message', async () => {
  const repo = makeGitRepo('https://dev.azure.com/amergis/MatterWorx/_git/MatterWorx');
  try {
    process.env.APEX_URL = 'https://apex.example.com';
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        authorized: false,
        reason: 'no-release',
        repo: 'MatterWorx',
        apexProject: 'matterworx',
        version: null,
        skills: [],
        message: 'No published APEX release targets project "matterworx".',
      }),
    });

    const check = await checkApexAuthorization({ repoRoot: repo });
    assert.equal(check.ok, false);
    assert.equal(check.hard, true);
    assert.match(check.detail, /no-release/);
    assert.match(check.remediation, /No published APEX release/);
    assert.equal(check.authorization, null);
  } finally {
    cleanup(repo);
  }
});

test('an APEX approval passes and returns the entitlement for recording', async () => {
  const repo = makeGitRepo();
  try {
    process.env.APEX_URL = 'https://apex.example.com';
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        authorized: true,
        reason: 'authorized',
        repo: 'MaxView',
        apexProject: 'maxview',
        version: '1.0.0',
        skills: ['to-prd', 'grill-with-docs'],
        message: 'Authorized.',
      }),
    });

    const check = await checkApexAuthorization({ repoRoot: repo });
    assert.equal(check.ok, true);
    assert.equal(check.authorization.apexProject, 'maxview');
    assert.equal(check.authorization.releaseVersion, '1.0.0');
    assert.deepEqual(check.authorization.authorizedSkills, ['to-prd', 'grill-with-docs']);
  } finally {
    cleanup(repo);
  }
});

test('authorization requests the release matching the running package version', async () => {
  const repo = makeGitRepo();
  let requestedUrl = '';
  try {
    process.env.APEX_URL = 'https://apex.example.com';
    globalThis.fetch = async (url) => {
      requestedUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          authorized: true,
          reason: 'authorized',
          repo: 'MaxView',
          apexProject: 'maxview',
          version: '2.0.0',
          artifactVersion: '2.0.0',
          skills: ['to-prd'],
          message: 'Authorized.',
        }),
      };
    };

    await checkApexAuthorization({ repoRoot: repo, packageVersion: '2.0.0' });

    const parsed = new URL(requestedUrl);
    assert.equal(parsed.searchParams.get('artifactVersion'), '2.0.0');
  } finally {
    cleanup(repo);
  }
});

test('an unreachable APEX fails closed even with a recorded authorization', async () => {
  // Regression guard for the "point APEX_URL at a dead port" bypass.
  const repo = makeGitRepo();
  try {
    writeApexConfig(repo, {
      apexProject: 'maxview',
      apexUrl: 'https://apex.example.com',
      repo: 'MaxView',
      releaseVersion: '1.0.0',
      authorizedSkills: ['to-prd'],
    });
    process.env.APEX_URL = 'https://apex.example.com';
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };

    const check = await checkApexAuthorization({ repoRoot: repo });
    assert.equal(check.ok, false);
    assert.equal(check.hard, true);
    assert.match(check.detail, /could not reach APEX/);
    assert.match(check.remediation, /--skip-apex-check/);
  } finally {
    cleanup(repo);
  }
});

test('an unreachable APEX with no recorded authorization fails closed', async () => {
  const repo = makeGitRepo();
  try {
    process.env.APEX_URL = 'https://apex.example.com';
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };

    const check = await checkApexAuthorization({ repoRoot: repo });
    assert.equal(check.ok, false);
    assert.equal(check.hard, true);
    assert.match(check.remediation, /--skip-apex-check/);
  } finally {
    cleanup(repo);
  }
});

test('a degraded APEX is reported as an APEX-side fault, not a local one', async () => {
  // A stalled lookup returns 503 + authorization-unavailable rather than hanging.
  // Blaming the developer's network here sends them chasing VPN and APEX_URL
  // problems that do not exist, so the remediation must read differently.
  const repo = makeGitRepo();
  try {
    process.env.APEX_URL = 'https://apex.example.com';
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({
        error: 'Authorization service is temporarily unavailable',
        code:  'authorization-unavailable',
      }),
    });

    const check = await checkApexAuthorization({ repoRoot: repo });
    assert.equal(check.ok, false);
    assert.equal(check.hard, true);
    assert.match(check.detail, /reachable but could not answer/);
    assert.match(check.remediation, /APEX-side problem/);
    assert.doesNotMatch(check.remediation, /VPN/);
    // Bypassing an APEX outage is not the right advice — retry is.
    assert.doesNotMatch(check.remediation, /--skip-apex-check/);
  } finally {
    cleanup(repo);
  }
});

test('an unlabelled server error still reads as a connectivity failure', async () => {
  const repo = makeGitRepo();
  try {
    process.env.APEX_URL = 'https://apex.example.com';
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: 'boom', code: 'authorization-failed' }),
    });

    const check = await checkApexAuthorization({ repoRoot: repo });
    assert.equal(check.ok, false);
    assert.equal(check.hard, true);
    assert.match(check.detail, /could not reach APEX/);
    assert.match(check.remediation, /--skip-apex-check/);
  } finally {
    cleanup(repo);
  }
});

// ── artifact version enforcement ──────────────────────────────────────────────

test('verifyArtifactVersion accepts a matching package version', () => {
  const auth = { artifactVersion: '1.1.0', releaseVersion: '2.0.0' };
  assert.equal(verifyArtifactVersion(auth, '1.1.0'), null);
});

test('a verified mismatch blocks and names the exact fix', () => {
  const auth = { artifactVersion: '1.0.0', releaseVersion: '0.4.0', artifactVersionVerified: true };
  const result = verifyArtifactVersion(auth, '1.1.0');
  assert.ok(result, 'expected a mismatch result');
  assert.equal(result.severity, 'error');
  assert.match(result.message, /refusing to install/);
  assert.match(result.message, /@apex\/skills@1\.1\.0/);          // what is running
  assert.match(result.message, /npx @apex\/skills@1\.0\.0 install/); // the remediation
});

test('an unverified mismatch warns instead of blocking', () => {
  // APEX only proves a version exists when the feed is configured at publish
  // time. Blocking on a hand-typed value would lock teams out over an APEX-side
  // data gap they cannot fix, so this path must stay non-fatal.
  const auth = { artifactVersion: '0.4.0', releaseVersion: '0.4.0', artifactVersionVerified: false };
  const result = verifyArtifactVersion(auth, '1.1.0');
  assert.ok(result, 'expected a mismatch result');
  assert.equal(result.severity, 'warn');
  assert.match(result.message, /continuing anyway/);
  assert.doesNotMatch(result.message, /refusing to install/);
});

test('a missing verification flag is treated as unverified', () => {
  // Older APEX builds omit the field entirely; absence must not mean "enforce".
  const auth = { artifactVersion: '0.4.0', releaseVersion: '0.4.0' };
  assert.equal(verifyArtifactVersion(auth, '1.1.0').severity, 'warn');
});

test('verifyArtifactVersion is a no-op when the release predates artifactVersion', () => {
  assert.equal(verifyArtifactVersion({ artifactVersion: null }, '1.1.0'), null);
  assert.equal(verifyArtifactVersion(null, '1.1.0'), null);
});

test('verifyArtifactVersion is a no-op when the package version is unreadable', () => {
  assert.equal(verifyArtifactVersion({ artifactVersion: '1.0.0' }, null), null);
});

test('readPackageVersion reads the running package manifest', () => {
  const version = readPackageVersion(PKG_ROOT);
  assert.match(version, /^\d+\.\d+\.\d+/);
});

test('readPackageVersion returns null when there is no manifest', () => {
  const repo = makeRepo({ 'other.txt': 'x' });
  try {
    assert.equal(readPackageVersion(repo), null);
  } finally {
    cleanup(repo);
  }
});

test('an authorization carries artifactVersion through for enforcement', async () => {
  const repo = makeGitRepo();
  try {
    process.env.APEX_URL = 'https://apex.example.com';
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        authorized: true,
        reason: 'authorized',
        repo: 'MaxView',
        apexProject: 'maxview',
        version: '0.4.0',
        artifactVersion: '1.0.0',
        skills: ['to-prd'],
        message: 'Authorized.',
      }),
    });

    const check = await checkApexAuthorization({ repoRoot: repo });
    assert.equal(check.authorization.artifactVersion, '1.0.0');
  } finally {
    cleanup(repo);
  }
});
