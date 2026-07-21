#!/usr/bin/env node
/**
 * @apex/skills CLI. Runs identically on PowerShell, Git Bash, cmd, and POSIX
 * shells with Node 18+. Delegates to lib/commands.mjs.
 *
 * Usage:
 *   npx @apex/skills doctor [--feed]
 *   npx @apex/skills validate [--package <dir>]
 *   npx @apex/skills install [skills...] [--dry-run] [--enrich] [--cwd <dir>]
 *   npx @apex/skills bootstrap [skills...] [--explain] [--enrich] [--cwd <dir>]
 *   npx @apex/skills check [--cwd <dir>]
 *   npx @apex/skills update [skills...]        (alias: re-runs install)
 */
import {
  cmdDoctor, cmdValidate, cmdInstall, cmdCheck, cmdBootstrap,
} from '../lib/commands.mjs';

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--enrich') opts.enrich = true;
    else if (a === '--explain') opts.explain = true;
    else if (a === '--feed') opts.feed = true;
    else if (a === '--package') opts.package = argv[++i];
    else if (a === '--cwd') opts.cwd = argv[++i];
    else if (a.startsWith('--')) opts[a.slice(2)] = true;
    else opts._.push(a);
  }
  return opts;
}

const HELP = `apex-skills <command> [options]

Commands:
  doctor              Verify prerequisites (Node/npm/git[/feed with --feed])
  validate            Validate the foundation-skills package
  install [skills]    Vendor foundations + scaffold pre-filled adapters (repo-local)
  bootstrap [skills]  (Re)generate adapter drafts; --explain shows evidence sources
  check               Report installed vs available suite version + compatibility
  update [skills]     Re-run install to move to the current suite

Options:
  --dry-run           Plan only, write nothing
  --enrich            Enable optional AI prose enrichment (default off)
  --explain           Print evidence + source for each filled slot (bootstrap)
  --package <dir>     Package root (defaults to the installed @apex/skills)
  --cwd <dir>         Target repo root (defaults to current directory)`;

function main() {
  const [, , command, ...rest] = process.argv;
  const opts = parseArgs(rest);
  const log = (msg) => process.stdout.write(String(msg) + '\n');

  let code = 0;
  switch (command) {
    case 'doctor': code = cmdDoctor(opts, log); break;
    case 'validate': code = cmdValidate(opts, log); break;
    case 'install': code = cmdInstall(opts, log); break;
    case 'bootstrap': code = cmdBootstrap(opts, log); break;
    case 'check': code = cmdCheck(opts, log); break;
    case 'update': code = cmdInstall(opts, log); break;
    case undefined:
    case 'help':
    case '--help':
    case '-h': log(HELP); break;
    default:
      log(`Unknown command: ${command}\n\n${HELP}`);
      code = 1;
  }
  process.exit(code);
}

main();
