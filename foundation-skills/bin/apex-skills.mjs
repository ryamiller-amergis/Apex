#!/usr/bin/env node
/**
 * @apex/skills CLI entry point
 *
 * Usage:
 *   npx @apex/skills doctor
 *   npx @apex/skills init-registry [--org] [--feed] [--dry-run]
 *   npx @apex/skills install <skill...> [--dry-run] [--fill]
 *   npx @apex/skills check
 *   npx @apex/skills update [<skill...>]
 *   npx @apex/skills validate
 *   npx @apex/skills bootstrap [<skill...>] [--explain]
 *
 * Must run identically on PowerShell, Git Bash, cmd, and POSIX shells with Node 18+.
 */

import { parseArgs } from 'node:util';
import { doctor }    from '../lib/commands/doctor.mjs';
import { initRegistryCommand } from '../lib/commands/init-registry.mjs';
import { install }   from '../lib/commands/install.mjs';
import { check }     from '../lib/commands/check.mjs';
import { update }    from '../lib/commands/update.mjs';
import { validate }  from '../lib/commands/validate.mjs';
import { bootstrap } from '../lib/commands/bootstrap.mjs';

const [,, command, ...rest] = process.argv;

const USAGE = `
APEX Foundation Skills CLI

Commands:
  doctor                   Health check (Node, Git, @apex registry .npmrc, feed auth)
    --skip-feed            Skip Azure Artifacts reachability check (local maintainers)
  init-registry            Create/merge local .npmrc from .npmrc.template (+ @apex scope)
    --org <name>           Azure DevOps org (default: amergis / AZURE_ARTIFACTS_ORG)
    --feed <name>          Artifacts feed (default: apex-skills / AZURE_ARTIFACTS_FEED)
    --project <name>       Optional project-scoped feed
    --dry-run              Preview without writing .npmrc
  install <skill...>       Install selected skill foundations + scaffold adapters
                           (refuses until doctor hard checks pass; skill names required)
    --all                  Install every skill in the package (use named skills instead)
    --dry-run              Preview what would be written without writing anything
    --fill                 Re-run the bootstrap adapter pre-fill (for existing installs)
    --enrich               Opt-in: use AI to improve adapter prose within evidence bounds
  check                    Report which installed foundations have available updates
  update [<skill...>]      Update foundations; never overwrites existing adapters
  validate                 Validate catalog coverage, contracts, and lockfile integrity
  bootstrap [<skill...>]   Re-run adapter pre-fill for named skills (or installed skills)
    --all                  Bootstrap every skill in the package regardless of lockfile
    --explain              Print evidence + source file/line for each filled slot
    --enrich               Opt-in: AI-enriched prose within evidence bounds
  help                     Print this message
`.trim();

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  try {
    switch (command) {
      case 'doctor': {
        const { values } = parseArgs({
          args: rest,
          options: {
            'skip-feed': { type: 'boolean', default: false },
          },
          allowPositionals: true,
        });
        await doctor({
          requireRegistry: true,
          requireFeed: !values['skip-feed'],
        });
        break;
      }

      case 'init-registry': {
        const { values } = parseArgs({
          args: rest,
          options: {
            org:       { type: 'string' },
            feed:      { type: 'string' },
            project:   { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
          },
          allowPositionals: true,
        });
        await initRegistryCommand({
          org: values.org,
          feed: values.feed,
          project: values.project,
          dryRun: values['dry-run'],
        });
        break;
      }

      case 'install': {
        const { values, positionals } = parseArgs({
          args: rest,
          options: {
            'dry-run': { type: 'boolean', default: false },
            fill:      { type: 'boolean', default: false },
            enrich:    { type: 'boolean', default: false },
            all:       { type: 'boolean', default: false },
          },
          allowPositionals: true,
        });
        const skills = positionals.length > 0 ? positionals : null;
        await install({ skills, all: values.all, dryRun: values['dry-run'], fill: values.fill, enrich: values.enrich });
        break;
      }

      case 'check':
        await check();
        break;

      case 'update': {
        const { positionals } = parseArgs({ args: rest, options: {}, allowPositionals: true });
        const skills = positionals.length > 0 ? positionals : null;
        await update({ skills });
        break;
      }

      case 'validate':
        await validate();
        break;

      case 'bootstrap': {
        const { values, positionals } = parseArgs({
          args: rest,
          options: {
            explain: { type: 'boolean', default: false },
            enrich:  { type: 'boolean', default: false },
            all:     { type: 'boolean', default: false },
          },
          allowPositionals: true,
        });
        const skills = positionals.length > 0 ? positionals : null;
        await bootstrap({ skills, all: values.all, explain: values.explain, enrich: values.enrich });
        break;
      }

      default:
        console.error(`Unknown command: "${command}"\n\n${USAGE}`);
        process.exit(1);
    }
  } catch (err) {
    console.error(`[apex-skills] Fatal error: ${err.message}`);
    if (process.env.APEX_SKILLS_DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
