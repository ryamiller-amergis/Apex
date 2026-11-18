#!/usr/bin/env node
/**
 * Run one read-only Azure CLI command.
 *
 * Usage (from repo root):
 *   node .cursor/skills/issue-rca/scripts/readonly-az.js monitor app-insights query --app <name> -g <rg> --analytics-query "<kusto>" -o json
 *
 * The positional command must be on the allowlist (show, list, or query).
 * Flag values are not inspected, so a Kusto string may contain any word.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');

const ALLOWED = new Set([
  'account show',
  'monitor app-insights query',
  'monitor metrics list',
  'monitor log-analytics query',
  'monitor activity-log list',
  'resource show',
  'resource list',
  'postgres flexible-server show',
  'postgres flexible-server db show',
  'servicebus queue show',
  'redis show',
  'containerapp show',
  'containerapp revision list',
  'containerapp job show',
  'containerapp job execution list',
  'storage account show',
  'webapp show',
]);

function fail(message) {
  console.error(message);
  process.exit(2);
}

function positionals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && i + 1 < argv.length && !argv[i + 1].startsWith('-')) i += 1;
      continue;
    }
    out.push(arg.toLowerCase());
  }
  return out;
}

function resolveAz() {
  const candidates = process.platform === 'win32'
    ? ['az.cmd', 'az', 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd']
    : ['az'];
  for (const candidate of candidates) {
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [candidate], {
      encoding: 'utf8',
    });
    const found = (probe.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (probe.status === 0 && found) return found;
  }
  fail('Azure CLI (az) not found on PATH');
}

const args = process.argv.slice(2);
if (args.length === 0) {
  fail('Usage: node readonly-az.js <allowlisted az command> [flags]');
}

const command = positionals(args).join(' ');
if (!ALLOWED.has(command)) {
  fail(`Refusing az command "${command}". Allowed: ${[...ALLOWED].join('; ')}`);
}

function quoteForCmd(arg) {
  if (/[\r\n%]/.test(arg)) {
    fail('Arguments containing newlines or % are not allowed');
  }
  return `"${arg.replace(/"/g, '""')}"`;
}

function runAz(az, azArgs) {
  if (process.platform !== 'win32') {
    return spawnSync(az, azArgs, { encoding: 'utf8', shell: false });
  }
  // .cmd files cannot be spawned directly. /s strips one outer quote pair,
  // so the command line is quoted as a whole and each argument is quoted again.
  const inner = [quoteForCmd(az), ...azArgs.map(quoteForCmd)].join(' ');
  // windowsVerbatimArguments stops Node from turning our quotes into \", which
  // cmd.exe would treat as a broken path.
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${inner}"`], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
}

const az = resolveAz();
const result = runAz(az, args);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) fail(result.error.message);
process.exit(result.status === null ? 1 : result.status);
