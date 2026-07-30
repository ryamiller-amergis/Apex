/**
 * Prerequisite self-check. Verifies Node >= 18, npm/npx, git, Cursor project
 * presence, and (softly) Azure Artifacts feed reachability. Returns structured
 * results so `install` can gate on hard failures and print actionable remediation.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function tryCmd(cmd, args) {
  try {
    // shell:true so Windows resolves .cmd/.bat shims (npm.cmd, git via PATH).
    const res = spawnSync(cmd, args, {
      encoding: 'utf8',
      shell: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (res.status !== 0 || !res.stdout) return null;
    return res.stdout.trim();
  } catch {
    return null;
  }
}

export function runDoctor({ checkFeed = false, packageName = '@apex/skills', repoRoot = process.cwd() } = {}) {
  const checks = [];

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
  const hasCursorDir = fs.existsSync(path.join(repoRoot, '.cursor'));
  checks.push({
    id: 'cursor-project',
    ok: hasCursorDir,
    hard: false,
    detail: hasCursorDir ? '.cursor/ directory found' : '.cursor/ directory not found',
    remediation: 'Open this repository in Cursor IDE at least once, or create a .cursor/ directory manually.',
  });

  const hasPackageJson = fs.existsSync(path.join(repoRoot, 'package.json'));
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

  const lockPath = path.join(repoRoot, 'apex-skills.lock.json');
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

  if (checkFeed) {
    const view = tryCmd('npm', ['view', packageName, 'version']);
    checks.push({
      id: 'feed',
      ok: Boolean(view),
      hard: false,
      detail: view ? `${packageName}@${view} reachable` : 'feed/package not reachable or not authenticated',
      remediation: 'Configure .npmrc with the Azure Artifacts feed + PAT (vsts-npm-auth or npm config).',
    });
  }

  const hardFailures = checks.filter((c) => c.hard && !c.ok);
  const isFirstInstall = !hasLock;
  return { checks, ok: hardFailures.length === 0, hardFailures, isFirstInstall, installedVersion };
}

export function formatDoctor(result, { showNextSteps = true } = {}) {
  const lines = result.checks.map((c) => {
    const mark = c.ok ? 'PASS' : c.hard ? 'FAIL' : 'WARN';
    const rem = (!c.ok && c.remediation) ? `\n       -> ${c.remediation}` : '';
    return `  [${mark}] ${c.id}: ${c.detail}${rem}`;
  });

  if (!result.ok) {
    lines.push('\nHard prerequisites missing — see remediation above.');
    return lines.join('\n');
  }

  lines.push('\nAll hard prerequisites satisfied.');

  if (showNextSteps) {
    if (result.isFirstInstall) {
      lines.push(`
Next steps — first-time setup:
  1. npx @apex/skills install        Install all 30 foundation skill files
  2. npx @apex/skills bootstrap      Teach the skills your repo (scans codebase, fills adapter templates)
  3. Review .cursor/skills/<skill>/  Verify adapter content, then commit

Note: skills are plain Markdown — they work in any language repo. Only this CLI requires Node.`);
    } else {
      lines.push(`
Next steps — apply the update:
  1. npx @apex/skills update         Pull latest foundation files (existing adapters preserved)
  2. npx @apex/skills bootstrap      Refresh adapters with updated repo knowledge
  3. Review and commit changes`);
    }
  }

  return lines.join('\n');
}
