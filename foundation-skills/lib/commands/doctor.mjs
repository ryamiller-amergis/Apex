/**
 * doctor — prerequisite verification gate
 *
 * Checks:
 *   - Node.js >= 18
 *   - npm / npx available
 *   - Azure Artifacts feed reachable + authenticated (npm view @apex/skills)
 *   - Git 2.x present
 *   - Current directory is a git working tree (warning, not error)
 */

import { execSync } from 'node:child_process';
import { semverGte } from '../semver.mjs';

const PASS = '\u2713';
const FAIL = '\u2717';
const WARN = '\u26a0';

/**
 * @param {object} [opts]
 * @param {boolean} [opts.quiet]   suppress output (for programmatic use)
 * @param {boolean} [opts.strict]  treat feed-check as hard failure (default: soft warn)
 * @returns {{ ok: boolean, checks: Array<{name: string, ok: boolean, message: string}> }}
 */
export async function doctor({ quiet = false, strict = false } = {}) {
  const results = [];

  function record(name, ok, message) {
    results.push({ name, ok, message });
    if (!quiet) {
      const icon = ok ? PASS : FAIL;
      console.log(`  ${icon} ${name}: ${message}`);
    }
  }

  function warn(name, message) {
    results.push({ name, ok: true, warning: message });
    if (!quiet) console.log(`  ${WARN} ${name}: ${message}`);
  }

  if (!quiet) console.log('\nAPEX Skills — environment check\n');

  // Node.js version
  const nodeVersion = process.version.replace(/^v/, '');
  if (semverGte(nodeVersion, '18.0.0')) {
    record('Node.js', true, `${process.version} (>= 18 required)`);
  } else {
    record('Node.js', false,
      `${process.version} is below the minimum. Install Node 18+ from https://nodejs.org or via winget install OpenJS.NodeJS.LTS`);
  }

  // npm / npx
  try {
    const npmVersion = execSync('npm --version', { stdio: 'pipe' }).toString().trim();
    record('npm', true, `v${npmVersion}`);
  } catch {
    record('npm', false, 'npm not found — ensure Node.js is installed and on PATH');
  }

  // Git
  try {
    const gitVersion = execSync('git --version', { stdio: 'pipe' }).toString().trim();
    const match = gitVersion.match(/(\d+\.\d+)/);
    const vStr = match ? match[1] : '?';
    if (match && semverGte(vStr + '.0', '2.0.0')) {
      record('Git', true, gitVersion);
    } else {
      record('Git', false, `git version too old (${gitVersion}). Install Git 2+ from https://git-scm.com`);
    }
  } catch {
    record('Git', false, 'git not found. Install from https://git-scm.com or winget install Git.Git');
  }

  // Git working tree (soft warn)
  try {
    execSync('git rev-parse --git-dir', { stdio: 'pipe' });
    record('Git repo', true, 'current directory is inside a git working tree');
  } catch {
    warn('Git repo',
      'current directory is not a git working tree — the install will write files but the update/PR flow will not work');
  }

  // Azure Artifacts feed auth (soft warn by default; hard fail if --strict)
  try {
    execSync('npm view @apex/skills version --silent', { stdio: 'pipe', timeout: 10_000 });
    record('Feed auth', true, '@apex/skills is accessible from the configured npm registry');
  } catch {
    const msg = 'Cannot reach @apex/skills in the configured npm registry. Ensure your .npmrc points at the Azure Artifacts feed and a PAT is valid (run vsts-npm-auth -config .npmrc on Windows, or set NPM_TOKEN).';
    if (strict) {
      record('Feed auth', false, msg);
    } else {
      warn('Feed auth', msg + ' (non-fatal for local install from --local path)');
    }
  }

  const allOk = results.every(r => r.ok !== false);

  if (!quiet) {
    console.log('');
    if (allOk) {
      console.log('All checks passed. Run: npx @apex/skills install <skill...>');
    } else {
      const failed = results.filter(r => r.ok === false).map(r => r.name);
      console.log(`${FAIL} ${failed.length} check(s) failed: ${failed.join(', ')}`);
      console.log('Fix the issues above, then retry.');
    }
    console.log('');
  }

  return { ok: allOk, checks: results };
}
