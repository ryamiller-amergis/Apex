/**
 * Prerequisite self-check. Verifies Node >= 18, npm/npx, git, and (softly)
 * Azure Artifacts feed reachability. Returns structured results so `install`
 * can gate on hard failures and print actionable remediation.
 */
import { spawnSync } from 'node:child_process';

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

export function runDoctor({ checkFeed = false, packageName = '@apex/skills' } = {}) {
  const checks = [];

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
  return { checks, ok: hardFailures.length === 0, hardFailures };
}

export function formatDoctor(result) {
  const lines = result.checks.map((c) => {
    const mark = c.ok ? 'PASS' : c.hard ? 'FAIL' : 'WARN';
    const rem = c.ok ? '' : `\n       -> ${c.remediation}`;
    return `  [${mark}] ${c.id}: ${c.detail}${rem}`;
  });
  lines.push(result.ok ? '\nAll hard prerequisites satisfied.' : '\nHard prerequisites missing — see remediation above.');
  return lines.join('\n');
}
