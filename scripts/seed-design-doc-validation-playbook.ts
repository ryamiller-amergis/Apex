/**
 * Publishes the canonical design-doc validation Playbook into a project.
 *
 * `publishDesignDocValidationPlaybook` in the service is the release entry point, but it calls
 * `createDefinition` unconditionally and so collides with the unique index on
 * `(project, lower(btrim(name)))` the second time it runs. A demo has to survive its second take,
 * so this reuses the Phase 0 seeder's retained-draft upsert instead: the graph is rebuilt from
 * current project settings, compared against what is published, and only republished when it
 * actually differs.
 *
 * The graph itself still comes from `buildDesignDocValidationPlaybookGraph`, and publishing still
 * goes through `publishDraft`, so the structural guards and the read-only-MCP refusal run against
 * this definition exactly as they do in production. Seeding a row with `status = 'published'`
 * already set would skip both.
 *
 * Usage:
 *   npx ts-node --project tsconfig.server.json scripts/seed-design-doc-validation-playbook.ts [--project Apex] [--user <oid>]
 */
import 'dotenv/config';
import { db } from '../src/server/db/drizzle';
import pool from '../src/server/db';
import {
  DESIGN_DOC_VALIDATION_PLAYBOOK_DESCRIPTION,
  DESIGN_DOC_VALIDATION_PLAYBOOK_NAME,
  buildDesignDocValidationPlaybookGraph,
} from '../src/server/services/designDocValidationPlaybookService';
import { isFeatureEnabled } from '../src/server/services/featureFlagService';
import { getSkillConfig } from '../src/server/services/projectSettingsService';
import { seedDefinition } from './seed-playbook-demos';

const FLAG_KEY = 'playbooks-production-adapters';

/** Any real user. The definition needs a `created_by` that satisfies the foreign key. */
async function resolveSeedUser(explicit?: string): Promise<string> {
  if (explicit) return explicit;

  const someone = await db.query.appUsers.findFirst({ columns: { oid: true } });
  if (!someone) {
    throw new Error(
      'No users exist in this database, so there is nobody to attribute the definition to. ' +
        'Sign in once, or pass --user <oid>.'
    );
  }
  return someone.oid;
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const project = argValue('--project') ?? 'Apex';
  const publishedByUserId = await resolveSeedUser(argValue('--user'));

  // Both checks mirror the service's own preconditions, so the script fails with the same reason
  // the runtime would rather than publishing a definition nothing can start.
  const enabled = await isFeatureEnabled(FLAG_KEY, { userId: publishedByUserId, project });
  if (!enabled) {
    throw new Error(
      `${FLAG_KEY} is disabled for project "${project}". Enable it in Platform Admin -> Feature ` +
        'Flags first, or the published Playbook cannot be started.'
    );
  }

  const settings = await getSkillConfig(project);
  const skillPath = settings?.designDocValidationSkillPath?.trim();
  if (!skillPath) {
    throw new Error(
      `Project "${project}" has no design-doc validation Skill configured. Set it in Project ` +
        'Admin -> Skills (for example .cursor/skills/design-doc-validation/SKILL.md).'
    );
  }

  const outcome = await seedDefinition(
    {
      name: DESIGN_DOC_VALIDATION_PLAYBOOK_NAME,
      description: DESIGN_DOC_VALIDATION_PLAYBOOK_DESCRIPTION,
      graph: buildDesignDocValidationPlaybookGraph({
        skillPath,
        model: settings?.designDocValidationModel,
      }),
    },
    project,
    publishedByUserId
  );

  console.log(`Seeded the canonical Playbook into project "${project}":`);
  console.log(
    `  ${outcome.name} - v${outcome.versionNumber} (${outcome.created ? 'published' : 'already present'})`
  );
  console.log(`    definitionId ${outcome.definitionId}`);
  console.log(`    scoring Skill ${skillPath}`);
  console.log(
    '\nStart it from a design doc you own, in Design Doc Review. Re-running is safe: a matching' +
      '\ncurrent version is reused, and published versions stay immutable.'
  );
}

if (require.main === module) {
  main()
    .then(() => pool.end())
    .catch(async (error: Error) => {
      console.error('Seeding failed:', error.message);
      await pool.end().catch(() => undefined);
      process.exit(1);
    });
}
