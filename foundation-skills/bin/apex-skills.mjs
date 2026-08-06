#!/usr/bin/env node
/**
 * @apex/skills CLI entry point
 *
 * Usage:
 *   npx @apex/skills doctor
 *   npx @apex/skills init-registry [--org] [--feed] [--dry-run]
 *   npx @apex/skills install <skill...> [--dry-run] [--fill] [--skip-apex-check]
 *   npx @apex/skills check
 *   npx @apex/skills update [<skill...>] [--skip-apex-check]
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
  doctor                   Health check (Node, Git, @apex registry, feed auth, APEX entitlement)
    --skip-feed            Skip Azure Artifacts reachability check (local maintainers)
    --skip-apex-check      Skip the APEX entitlement check (maintainers / air-gapped)
  init-registry            Create/merge local .npmrc from .npmrc.template (+ @apex scope)
    --org <name>           Azure DevOps org (default: amergis / AZURE_ARTIFACTS_ORG)
    --feed <name>          Artifacts feed (default: apex-skills / AZURE_ARTIFACTS_FEED)
    --project <name>       Optional project-scoped feed
    --dry-run              Preview without writing .npmrc
  install <skill...>       Install selected skill foundations + scaffold adapters
                           (refuses until doctor hard checks pass; skill names required)
    --all                  Install every skill your APEX release ships to this project
    --dry-run              Preview what would be written without writing anything
    --fill                 Re-run the bootstrap adapter pre-fill (for existing installs)
    --enrich               Opt-in: use AI to improve adapter prose within evidence bounds
    --skip-feed            Skip registry/feed checks for a pre-verified local artifact
    --skip-apex-check      Skip the APEX entitlement check (maintainers / air-gapped)
  check                    Report which installed foundations have available updates
  update [<skill...>]      Update foundations; never overwrites existing adapters
    --skip-apex-check      Skip the APEX entitlement check (maintainers / air-gapped)
  validate                 Validate catalog coverage, contracts, and lockfile integrity
  bootstrap [<skill...>]   Re-run adapter pre-fill for named skills (or installed skills)
    --all                  Bootstrap every authorized skill already in the lockfile
    --explain              Print evidence + source file/line for each filled slot
    --enrich               Opt-in: AI-enriched prose within evidence bounds
    --skip-apex-check      Skip the APEX entitlement check (maintainers / air-gapped)
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
            'skip-apex-check': { type: 'boolean', default: false },
          },
          allowPositionals: true,
        });
        await doctor({
          requireRegistry: true,
          requireFeed: !values['skip-feed'],
          skipApexCheck: values['skip-apex-check'],
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
            'skip-feed': { type: 'boolean', default: false },
            'skip-apex-check': { type: 'boolean', default: false },
          },
          allowPositionals: true,
        });
        const skills = positionals.length > 0 ? positionals : null;
        await install({
          skills,
          all: values.all,
          dryRun: values['dry-run'],
          fill: values.fill,
          enrich: values.enrich,
          skipFeed: values['skip-feed'],
          skipApexCheck: values['skip-apex-check'],
        });
        break;
      }

      case 'check':
        await check();
        break;

      case 'update': {
        const { values, positionals } = parseArgs({
          args: rest,
          options: {
            'skip-apex-check': { type: 'boolean', default: false },
          },
          allowPositionals: true,
        });
        const skills = positionals.length > 0 ? positionals : null;
        await update({ skills, skipApexCheck: values['skip-apex-check'] });
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
            'skip-apex-check': { type: 'boolean', default: false },
          },
          allowPositionals: true,
        });
        const skills = positionals.length > 0 ? positionals : null;
        await bootstrap({
          skills,
          all: values.all,
          explain: values.explain,
          enrich: values.enrich,
          skipApexCheck: values['skip-apex-check'],
        });
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
