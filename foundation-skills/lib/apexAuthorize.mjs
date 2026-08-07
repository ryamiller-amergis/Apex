/**
 * APEX install authorization.
 *
 * Before vendoring foundation files, the CLI asks APEX whether this repo is
 * entitled to them. Entitlement is derived from the repo's git remote — the
 * developer supplies nothing, so there is no project name to guess or mistype.
 *
 * The answer is recorded in `.apex/config.json` as an audit trail of what was
 * granted and when. It is NOT a cache: every install and update re-asks APEX, so
 * that revoking a project's entitlement takes effect on the next run rather than
 * whenever a stale record happens to be replaced.
 *
 * Design notes:
 *   - Fails closed. No answer means no install, with `--skip-apex-check` as the
 *     documented escape hatch for maintainers and air-gapped environments.
 *   - Credentials embedded in a remote URL are stripped before the URL leaves
 *     this machine.
 *   - Node built-ins only, so `npx` still needs no install step.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const CONFIG_REL_PATH = '.apex/config.json';

const DEFAULT_TIMEOUT_MS = 10000;

/** Strip `user:token@` / `user@` so tokens never leave the machine. */
export function sanitizeRemote(remoteUrl) {
  const raw = String(remoteUrl ?? '').trim();
  if (!raw) return '';
  // Scheme-based URLs: drop the userinfo segment between :// and the host.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
  }
  // scp-style (git@host:path) — the user part is structural, keep as-is.
  return raw;
}

/** `origin` remote URL for the repo at repoRoot, or null when there is none. */
export function detectGitRemote(repoRoot = process.cwd()) {
  const res = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (res.status !== 0 || !res.stdout?.trim()) return null;
  return sanitizeRemote(res.stdout.trim());
}

export function configPath(repoRoot) {
  return path.join(path.resolve(repoRoot), CONFIG_REL_PATH);
}

/** Parsed `.apex/config.json`, or null when absent/unreadable/corrupt. */
export function readApexConfig(repoRoot) {
  try {
    const text = fs.readFileSync(configPath(repoRoot), 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Persist the authorization record. Written with a trailing newline and stable
 * key order so it produces a clean, reviewable diff in the consumer repo.
 */
export function writeApexConfig(repoRoot, data) {
  const target = configPath(repoRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const ordered = {
    apexProject: data.apexProject ?? null,
    apexUrl: data.apexUrl ?? null,
    repo: data.repo ?? null,
    releaseVersion: data.releaseVersion ?? null,
    artifactVersion: data.artifactVersion ?? null,
    authorizedSkills: [...(data.authorizedSkills ?? [])].sort(),
    authorizedAt: data.authorizedAt ?? new Date().toISOString(),
  };
  fs.writeFileSync(target, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
  return target;
}

/**
 * APEX base URL, in precedence order:
 *   1. APEX_URL env var (what the Getting started banner tells teams to set)
 *   2. apexUrl recorded in .apex/config.json by a previous authorization
 */
export function resolveApexUrl(repoRoot) {
  const fromEnv = process.env.APEX_URL?.trim();
  if (fromEnv) return { url: fromEnv.replace(/\/+$/, ''), source: 'APEX_URL env var' };

  const cfg = readApexConfig(repoRoot);
  if (cfg?.apexUrl) {
    return { url: String(cfg.apexUrl).replace(/\/+$/, ''), source: CONFIG_REL_PATH };
  }
  return null;
}

/** Query APEX for this remote's entitlement. Throws only on transport failure. */
export async function fetchAuthorization(
  apexUrl,
  remote,
  { timeoutMs = DEFAULT_TIMEOUT_MS, packageVersion = null } = {},
) {
  const endpoint =
    `${apexUrl}/api/internal/foundation-skills/authorize` +
    `?remote=${encodeURIComponent(remote)}` +
    (packageVersion
      ? `&artifactVersion=${encodeURIComponent(packageVersion)}`
      : '');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* non-JSON body */ }
      const err = new Error(
        `APEX returned HTTP ${res.status}` +
        `${parsed?.error ? ` — ${parsed.error}` : body ? ` — ${body.slice(0, 200)}` : ''}`,
      );
      // Lets the caller separate "APEX answered, but is degraded" from a
      // transport failure, which need very different remediation.
      err.status = res.status;
      err.code = parsed?.code ?? null;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function remediation(lines) {
  return lines.filter((l) => l !== undefined).join('\n');
}

/**
 * Resolve the `apex-authorization` doctor check for this repo.
 *
 * Returns a check object in the same shape as lib/doctor.mjs checks so callers
 * can append it to a doctor result and format it uniformly. `authorization` on
 * the returned object carries the APEX payload when the check passed, so
 * install can record it in `.apex/config.json`.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {boolean} [opts.skip=false] Honour --skip-apex-check
 */
export async function checkApexAuthorization({
  repoRoot,
  skip = false,
  packageVersion = null,
} = {}) {
  if (skip) {
    return {
      id: 'apex-authorization',
      ok: true,
      hard: false,
      detail: 'skipped (--skip-apex-check)',
      remediation: null,
      authorization: null,
    };
  }

  const remote = detectGitRemote(repoRoot);
  const apex = resolveApexUrl(repoRoot);

  if (!apex) {
    return {
      id: 'apex-authorization',
      ok: false,
      hard: true,
      detail: `APEX_URL is not set and no apexUrl is recorded in ${CONFIG_REL_PATH}`,
      remediation: remediation([
        'The CLI does not know which APEX instance to verify this repo against.',
        '',
        'Set APEX_URL to your APEX instance, then re-run:',
        '',
        '  $env:APEX_URL="https://your-apex-host"      # PowerShell',
        '  export APEX_URL="https://your-apex-host"     # bash / zsh',
        '',
        '  npx @apex/skills doctor',
        '',
        'The exact value is shown in APEX under Getting started.',
        'Maintainers working on the package itself can bypass this with --skip-apex-check.',
      ]),
      authorization: null,
    };
  }

  if (!remote) {
    return {
      id: 'apex-authorization',
      ok: false,
      hard: true,
      detail: 'no git "origin" remote found — cannot identify this repo to APEX',
      remediation: remediation([
        'APEX identifies your project from the repo\'s origin remote.',
        '',
        'Confirm one is configured:',
        '',
        '  git remote -v',
        '',
        'If this is a fresh or local-only repo, add the hosted remote first.',
      ]),
      authorization: null,
    };
  }

  let payload;
  try {
    payload = await fetchAuthorization(
      apex.url,
      remote,
      { packageVersion },
    );
  } catch (err) {
    // Deliberately does NOT fall back to a recorded .apex/config.json. Accepting
    // a cached grant here made the gate bypassable in one step (point APEX_URL at
    // a dead port, or drop the apexUrl key) and let a de-targeted project keep
    // installing indefinitely. Offline use must be explicit instead.
    const degraded = err.code === 'authorization-unavailable';
    return {
      id: 'apex-authorization',
      ok: false,
      hard: true,
      detail: degraded
        ? `APEX at ${apex.url} is reachable but could not answer — ${err.message}`
        : `could not reach APEX at ${apex.url} — ${err.message}`,
      remediation: remediation(
        degraded
          ? [
              'APEX is reachable, but its authorization service did not respond in',
              'time. This is an APEX-side problem — your network and APEX_URL are',
              'fine, so there is nothing to fix on this machine.',
              '',
              `  Endpoint: ${apex.url}/api/internal/foundation-skills/authorize`,
              '',
              'Wait a moment and re-run the same command. If it keeps failing,',
              'report it to the APEX team rather than working around it.',
            ]
          : [
              `APEX could not be reached to verify this repo's entitlement.`,
              '',
              `  Endpoint: ${apex.url}/api/internal/foundation-skills/authorize`,
              `  Source:   ${apex.source}`,
              '',
              'Check that APEX_URL is correct and reachable from this machine (VPN?).',
              '',
              'A previous authorization is not accepted as a substitute — the check must',
              'reach APEX so that revoked entitlements actually take effect.',
              '',
              'For genuinely air-gapped or maintainer use, bypass it explicitly:',
              '',
              '  npx @apex/skills install <skill…> --skip-apex-check',
            ],
      ),
      authorization: null,
    };
  }

  if (!payload?.authorized) {
    return {
      id: 'apex-authorization',
      ok: false,
      hard: true,
      detail: `not authorized (${payload?.reason ?? 'unknown'})`,
      remediation: remediation([
        payload?.message ?? 'APEX did not authorize this repository.',
        '',
        `  Repo detected:  ${payload?.repo ?? 'unknown'}`,
        `  Apex project:   ${payload?.apexProject ?? 'not registered'}`,
        `  APEX instance:  ${apex.url}`,
        '',
        'Foundation skills are distributed per project. Once an APEX admin',
        'publishes a release targeting your project, re-run:',
        '',
        '  npx @apex/skills doctor',
      ]),
      authorization: null,
    };
  }

  return {
    id: 'apex-authorization',
    ok: true,
    hard: true,
    detail:
      `authorized for "${payload.apexProject}" via release ${payload.version} ` +
      `(${payload.skills.length} skill${payload.skills.length === 1 ? '' : 's'})`,
    remediation: null,
    authorization: {
      apexProject: payload.apexProject,
      apexUrl: apex.url,
      repo: payload.repo,
      releaseVersion: payload.version,
      artifactVersion: payload.artifactVersion ?? null,
      artifactVersionVerified: payload.artifactVersionVerified === true,
      authorizedSkills: payload.skills ?? [],
    },
  };
}

/** The `@apex/skills` version actually executing, read from the package manifest. */
export function readPackageVersion(pkgRoot) {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'),
    );
    return manifest?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Confirm the running package is the one the authorizing release shipped.
 *
 * Without this, `npx @apex/skills` resolves whatever is newest on the feed, so a
 * project could vendor content from a release it was never granted — and APEX
 * would still record it as installed under the older authorized version.
 *
 * Enforcement is deliberately conditional. APEX only proves an artifactVersion
 * exists when Azure Artifacts is configured at publish time; without it the
 * value was typed by hand and never validated. Blocking on an unvalidated value
 * would lock a team out over an APEX-side data gap they cannot fix themselves,
 * so an unverified mismatch warns and an verified one blocks. Enforcement
 * therefore tightens on its own once the feed is configured.
 *
 * Returns null when they agree or there is nothing to compare, otherwise
 * `{ severity, message }`.
 */
export function verifyArtifactVersion(authorization, packageVersion) {
  const expected = authorization?.artifactVersion;
  // Releases created before artifactVersion was surfaced have nothing to check.
  if (!expected || !packageVersion) return null;
  if (expected === packageVersion) return null;

  const header =
    [
      `  Running package:    @apex/skills@${packageVersion}`,
      `  Release authorizes: @apex/skills@${expected} (release ${authorization.releaseVersion})`,
    ].join('\n');

  if (authorization?.artifactVersionVerified !== true) {
    return {
      severity: 'warn',
      message: [
        `[apex-skills] Version mismatch — continuing anyway.`,
        '',
        header,
        '',
        'APEX never verified that this version exists on the feed, so the mismatch',
        'is more likely a gap in the release record than a real entitlement problem.',
        'Proceeding with the running package.',
        '',
        'Ask an APEX admin to confirm the release points at a published version.',
      ].join('\n'),
    };
  }

  return {
    severity: 'error',
    message: [
      `[apex-skills] Version mismatch — refusing to install.`,
      '',
      header,
      '',
      `Your project is entitled to release ${authorization.releaseVersion}, which ships`,
      `@apex/skills@${expected}. Install that exact version:`,
      '',
      `  npx @apex/skills@${expected} install <skill…>`,
      '',
      'If you expected a newer release, ask an APEX admin to publish one targeting',
      'your project, then re-run doctor.',
    ].join('\n'),
  };
}

/**
 * Reject skills the release does not ship to this project.
 * Returns { allowed, rejected } — callers decide whether to warn or refuse.
 */
export function partitionRequestedSkills(requested, authorizedSkills) {
  if (!authorizedSkills?.length) return { allowed: [...requested], rejected: [] };
  const allowedSet = new Set(authorizedSkills);
  const allowed = [];
  const rejected = [];
  for (const name of requested) {
    if (allowedSet.has(name)) {
      allowed.push(name);
    } else {
      rejected.push(name);
    }
  }
  return { allowed, rejected };
}
