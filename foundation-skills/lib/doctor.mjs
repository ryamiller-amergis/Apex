/**
 * Prerequisite self-check. Verifies Node >= 18, npm/npx, git, Cursor project
 * presence, project @apex registry config, and Azure Artifacts feed reachability.
 * Returns structured results so `install` can gate on hard failures and print
 * actionable remediation (including a ready-to-paste .npmrc).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PACKAGE_NAME = '@apex/skills';

function tryCmd(cmd, args, { cwd } = {}) {
  try {
    // shell:true so Windows resolves .cmd/.bat shims (npm.cmd, git via PATH).
    const res = spawnSync(cmd, args, {
      encoding: 'utf8',
      shell: true,
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (res.status !== 0 || !res.stdout) return null;
    return res.stdout.trim();
  } catch {
    return null;
  }
}

/** Org/feed placeholders — prefer env so remediation matches the team's feed. */
function feedCoords() {
  const org = process.env.AZURE_ARTIFACTS_ORG?.trim() || '{ORG}';
  const feed = process.env.AZURE_ARTIFACTS_FEED?.trim() || '{FEED}';
  const registry =
    `https://pkgs.dev.azure.com/${org}/_packaging/${feed}/npm/registry/`;
  return { org, feed, registry };
}

/** Multi-line remediation: init-registry from template + auth + verify. */
export function apexRegistryRemediation(repoRoot = process.cwd()) {
  const { org, feed, registry } = feedCoords();
  const tokenHost = `//pkgs.dev.azure.com/${org}/_packaging/${feed}/npm/registry/`;
  const templatePath = path.join(path.resolve(repoRoot), '.npmrc.template');
  const hasTemplate = fs.existsSync(templatePath);

  return [
    'The @apex scope must resolve to the private Azure Artifacts feed — not registry.npmjs.org.',
    '',
    'Repos typically gitignore .npmrc (tokens) and commit .npmrc.template (URLs only).',
    '',
    '1) Create/merge local .npmrc from the template (or defaults):',
    '',
    hasTemplate
      ? '   npx @apex/skills init-registry'
      : '   npx @apex/skills init-registry --org ' + org + ' --feed ' + feed,
    '',
    hasTemplate
      ? '   (found .npmrc.template — init-registry will copy it and ensure @apex:registry)'
      : '   Tip: commit .npmrc.template with registry URLs so teammates get this after clone.',
    '',
    '   Expected @apex line:',
    '   @apex:registry=' + registry,
    '',
    '2) Authenticate on your machine (token stays local / in CI secrets):',
    '',
    '   npx vsts-npm-auth -config .npmrc',
    '',
    '   # or:',
    `   npm config set ${tokenHost}:_authToken "%AZURE_ARTIFACTS_PAT%"`,
    '',
    '3) Verify, then re-run doctor / install:',
    '',
    `   npm view ${PACKAGE_NAME} version`,
    '   npx @apex/skills doctor',
    '   npx @apex/skills install',
  ].join('\n');
}

/**
 * Walk from repoRoot upward (stopping at .git) collecting .npmrc paths,
 * then parse the first @apex:registry= assignment found.
 */
export function resolveApexRegistry(repoRoot) {
  let dir = path.resolve(repoRoot);
  for (;;) {
    const npmrcPath = path.join(dir, '.npmrc');
    if (fs.existsSync(npmrcPath)) {
      try {
        const text = fs.readFileSync(npmrcPath, 'utf8');
        const match = text.match(/^\s*@apex:registry\s*=\s*(\S+)/m);
        if (match?.[1]) {
          return { registry: match[1].trim(), source: npmrcPath };
        }
      } catch {
        // ignore unreadable .npmrc
      }
    }
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const fromNpm = tryCmd('npm', ['config', 'get', '@apex:registry'], { cwd: repoRoot });
  if (fromNpm && fromNpm !== 'undefined' && fromNpm !== 'null' && fromNpm !== '') {
    return { registry: fromNpm, source: 'npm config (@apex:registry)' };
  }
  return null;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.packageName]
 * @param {boolean} [opts.requireRegistry=true] Hard-fail when @apex registry is missing
 * @param {boolean} [opts.requireFeed=true] Hard-fail when the package is not reachable via npm
 * @param {boolean} [opts.checkFeed] Deprecated alias — when false, skips feed (and if
 *   requireRegistry not set, also skips registry). Prefer requireRegistry/requireFeed.
 */
export function runDoctor({
  checkFeed,
  packageName = PACKAGE_NAME,
  repoRoot = process.cwd(),
  requireRegistry,
  requireFeed,
} = {}) {
  // Backward compat: older callers used checkFeed:false to skip network checks.
  const legacySkip = checkFeed === false;
  const wantRegistry = requireRegistry ?? !legacySkip;
  const wantFeed = requireFeed ?? (checkFeed === true ? true : !legacySkip);

  const checks = [];
  const root = path.resolve(repoRoot);

  // ── Runtime ──────────────────────────────────────────────────────────────────
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    id: 'node',
    ok: nodeMajor >= 18,
    hard: true,
    detail: `node ${process.versions.node}`,
    remediation: 'Install Node.js 18+ (nodejs.org, "winget install OpenJS.NodeJS.LTS", or nvm).',
  });

  const npmV = tryCmd('npm', ['-v']);
  checks.push({
    id: 'npm',
    ok: Boolean(npmV),
    hard: true,
    detail: npmV ? `npm ${npmV}` : 'npm not found',
    remediation: 'npm ships with Node.js; ensure Node is on PATH.',
  });

  const gitV = tryCmd('git', ['--version']);
  checks.push({
    id: 'git',
    ok: Boolean(gitV),
    hard: false,
    detail: gitV ?? 'git not found',
    remediation: 'Install Git (git-scm.com or "winget install Git.Git"). Required for update/PR flow.',
  });

  // ── Project context ───────────────────────────────────────────────────────────
  const hasCursorDir = fs.existsSync(path.join(root, '.cursor'));
  checks.push({
    id: 'cursor-project',
    ok: hasCursorDir,
    hard: false,
    detail: hasCursorDir ? '.cursor/ directory found' : '.cursor/ directory not found',
    remediation: 'Open this repository in Cursor IDE at least once, or create a .cursor/ directory manually.',
  });

  const hasPackageJson = fs.existsSync(path.join(root, 'package.json'));
  checks.push({
    id: 'node-project',
    ok: true, // non-Node repos are fully supported — this is info only
    hard: false,
    detail: hasPackageJson
      ? 'package.json found — Node.js project'
      : 'No package.json — non-Node project (skills still work; only this installer requires Node)',
    remediation: hasPackageJson
      ? null
      : 'No action needed. The skill files (.md) work in any language repo. ' +
        'Node.js is only required to run this CLI installer.',
  });

  const lockPath = path.join(root, 'apex-skills.lock.json');
  const hasLock = fs.existsSync(lockPath);
  let installedVersion = null;
  if (hasLock) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      installedVersion = lock.suiteVersion ?? null;
    } catch { /* ignore */ }
  }
  checks.push({
    id: 'install-status',
    ok: true, // informational only
    hard: false,
    detail: hasLock
      ? `apex-skills.lock.json found — suite ${installedVersion ?? 'unknown'} installed`
      : 'No apex-skills.lock.json — first-time install',
    remediation: null,
  });

  // ── Private feed (@apex registry + reachability) ────────────────────────────
  let registryInfo = null;
  if (wantRegistry || wantFeed) {
    registryInfo = resolveApexRegistry(root);
  }

  if (wantRegistry) {
    const hasTemplate = fs.existsSync(path.join(root, '.npmrc.template'));
    checks.push({
      id: 'apex-registry',
      ok: Boolean(registryInfo?.registry),
      hard: true,
      detail: registryInfo
        ? `@apex:registry → ${registryInfo.registry} (${registryInfo.source})`
        : hasTemplate
          ? 'No local .npmrc with @apex:registry (found .npmrc.template — run init-registry)'
          : 'No @apex:registry in project .npmrc or npm config',
      remediation: apexRegistryRemediation(root),
    });
  }

  if (wantFeed) {
    // Only attempt network check when registry is configured — otherwise the
    // registry FAIL already explains what to do, and npm view would hit public npm.
    if (registryInfo?.registry) {
      const view = tryCmd('npm', ['view', packageName, 'version'], { cwd: root });
      checks.push({
        id: 'feed',
        ok: Boolean(view),
        hard: true,
        detail: view
          ? `${packageName}@${view} reachable via configured registry`
          : `${packageName} not reachable — auth missing, wrong feed, or package not published`,
        remediation: [
          'Registry is configured but the package could not be resolved.',
          '',
          '  npx vsts-npm-auth -config .npmrc',
          `  npm view ${packageName} version`,
          '',
          'Confirm the feed has a Release (or Local) view with this package, and your PAT has Packaging Read.',
          '',
          apexRegistryRemediation(root),
        ].join('\n'),
      });
    } else if (!wantRegistry) {
      // Feed requested without registry gate — still report soft/hard failure.
      checks.push({
        id: 'feed',
        ok: false,
        hard: true,
        detail: `${packageName} not checked — @apex:registry is not configured`,
        remediation: apexRegistryRemediation(root),
      });
    }
  }

  const hardFailures = checks.filter((c) => c.hard && !c.ok);
  const isFirstInstall = !hasLock;
  return { checks, ok: hardFailures.length === 0, hardFailures, isFirstInstall, installedVersion };
}

export function formatDoctor(result, { showNextSteps = true } = {}) {
  const lines = result.checks.map((c) => {
    const mark = c.ok ? 'PASS' : c.hard ? 'FAIL' : 'WARN';
    let rem = '';
    if (!c.ok && c.remediation) {
      const remLines = String(c.remediation).split('\n');
      rem = '\n' + remLines.map((l) => `       ${l}`).join('\n');
    }
    return `  [${mark}] ${c.id}: ${c.detail}${rem}`;
  });

  if (!result.ok) {
    lines.push('\nHard prerequisites missing — fix the FAIL items above, then re-run:');
    lines.push('  npx @apex/skills doctor');
    lines.push('  npx @apex/skills install <skill…>   (copy from APEX Getting started banner)');
    return lines.join('\n');
  }

  lines.push('\nAll hard prerequisites satisfied.');

  if (showNextSteps) {
    if (result.isFirstInstall) {
      lines.push(`
Next steps — first-time setup:
  1. Commit .npmrc (@apex:registry) if you just added it — never commit auth tokens
  2. npx @apex/skills install <skill…>   Copy command from APEX Getting started (names your project's selected skills)
                                          Or: npx @apex/skills install --all  (installs every skill in the package)
  3. npx @apex/skills bootstrap <skill…> Scoped to the same list; defaults to locked skills if no names given
                                          Re-fills adapters from repo evidence — install already scaffolds them
  4. Review .cursor/skills/<skill>/       Verify adapter content, then commit

File layout per skill:
  .apex/foundation/<skill>/    Foundation files (managed; never hand-edit)
  .cursor/skills/<skill>/      Adapter files (team-owned; ~2 files per skill)
  .apex/config.json            Records the APEX release that authorized this install (commit this)
  apex-skills.lock.json        Records installed skills and file hashes (commit this)

Note: skills are plain Markdown — they work in any language repo. Only this CLI requires Node.`);
    } else {
      lines.push(`
Next steps — apply the update:
  1. npx @apex/skills update [<skill…>]   Pull latest foundation files (adapters are never overwritten)
  2. npx @apex/skills bootstrap [<skill…>] Refresh adapters; defaults to locked skills if no names given
  3. Review and commit changes`);
    }
  }

  return lines.join('\n');
}
