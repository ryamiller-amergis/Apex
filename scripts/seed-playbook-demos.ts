/**
 * Publishes the two Phase 0 demo Playbook definitions, A and B.
 *
 * In `scripts/` rather than `migrations/` for two reasons, and the second is the load-bearing one.
 * A migration would seed these into every environment it ran against, and a demo fixture belongs
 * only where the demo happens. More importantly, exit criterion E3 — "definition B runs with zero
 * lines of code changed" — is worth nothing unless B was published exactly the way A was. So this
 * goes through `publishVersion`, which runs TBI-023's structural guards, rather than inserting a
 * row with `status = 'published'` already set. A direct insert would skip the validation A passed
 * and leave E3 proving something weaker than it appears to.
 *
 * Idempotent, because TBI-027's non-functional requirement is that the rehearsal repeats without
 * hand-run SQL between attempts — a demo that needs a DELETE before the second take is a demo that
 * fails in front of an audience. Idempotence is an upsert on `(project, lower(btrim(name)))`, the
 * unique index the schema already carries, so re-running finds the definition rather than
 * colliding with it.
 *
 * Usage:
 *   npx ts-node --project tsconfig.server.json scripts/seed-playbook-demos.ts [--project Apex]
 */
import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/server/db/drizzle';
import pool from '../src/server/db';
import { playbookDefinitionVersions, playbookDefinitions } from '../src/server/db/schema';
import { publishVersion } from '../src/server/services/playbookDefinitionService';
import type { PlaybookGraph } from '../src/shared/types/playbook';

/**
 * The Skill both demo agent steps run.
 *
 * Answering questions from repo documentation is its whole job, which is why it writes no pipeline
 * artifact — the property TBI-026's fourth criterion asserts by counting rows in the
 * pipeline-artifact tables before and after a full run. It is also already the sole entry in the
 * `cursor-agent` descriptor's allow-list, so neither definition needs a registry change to publish.
 */
const DEMO_SKILL_PATH = '.cursor/skills/app-knowledge/SKILL.md';

export interface DemoDefinition {
  name: string;
  description: string;
  graph: PlaybookGraph;
}

/**
 * Definition A — the composition TBI-026 (a) names: `cursor-agent` → `approval-gate` → `notify`.
 *
 * This is the one the live demo drives, and its shape is chosen for what it lets an audience see:
 * an agent step that takes real time, a gate that visibly parks with an approver and a deadline,
 * and a notification that proves the run resumed and finished.
 */
export const DEFINITION_A: DemoDefinition = {
  name: 'Demo A — Ask, Approve, Notify',
  description:
    'Runs a repo question through the app-knowledge Skill, waits for a person to approve the ' +
    'answer, then notifies the initiator. The definition the Phase 0 live demo drives.',
  graph: {
    nodes: [
      {
        id: 'ask',
        stepType: 'cursor-agent',
        config: {
          skillPath: DEMO_SKILL_PATH,
          prompt:
            'Summarise what the Playbook orchestration feature does, in three sentences, for ' +
            'someone who has not seen it before.',
        },
      },
      {
        id: 'approve',
        stepType: 'approval-gate',
        config: { subject: 'Approve the summary before it is sent' },
      },
      {
        id: 'announce',
        stepType: 'notify',
        config: {
          title: 'Demo A finished',
          body: 'The summary was approved and the run completed.',
        },
      },
    ],
    edges: [
      { from: 'ask', to: 'approve' },
      { from: 'approve', to: 'announce' },
    ],
  },
};

/**
 * Definition B — the same three step types, composed differently.
 *
 * TBI-026 (b) asks for a different order and configuration, and the difference is deliberate rather
 * than cosmetic: B leads with the gate, so the very first thing it does is park. That makes E3 a
 * sharper test than a reordering that still happens to start with an agent step — if any part of
 * the runtime had been written around "runs begin by enqueueing an agent run", B finds it.
 */
export const DEFINITION_B: DemoDefinition = {
  name: 'Demo B — Approve, Ask, Notify',
  description:
    'Gates first, then asks the app-knowledge Skill a different question, then notifies. Same ' +
    'three step types as A in a different composition — the definition exit criterion E3 runs.',
  graph: {
    nodes: [
      {
        id: 'authorise',
        stepType: 'approval-gate',
        config: { subject: 'Authorise the run before any agent work starts' },
      },
      {
        id: 'research',
        stepType: 'cursor-agent',
        config: {
          skillPath: DEMO_SKILL_PATH,
          prompt: 'Which Apex features depend on the notification service? List them.',
        },
      },
      {
        id: 'report',
        stepType: 'notify',
        config: {
          title: 'Demo B finished',
          body: 'The authorised research run completed.',
        },
      },
    ],
    edges: [
      { from: 'authorise', to: 'research' },
      { from: 'research', to: 'report' },
    ],
  },
};

export const DEMO_DEFINITIONS = [DEFINITION_A, DEFINITION_B] as const;

export interface SeedOutcome {
  name: string;
  definitionId: string;
  versionId: string;
  versionNumber: number;
  /** False when a published version of this definition already existed. */
  created: boolean;
}

/**
 * Seeds one definition and returns what it found or made.
 *
 * The published-version check is what makes a second run a no-op rather than a second version. It
 * deliberately looks for a *published* version rather than any version: a draft left behind by an
 * interrupted run should be completed, not skipped, or the script would be idempotent in the sense
 * that it reliably does nothing.
 */
export async function seedDefinition(
  definition: DemoDefinition,
  project: string,
  seededByUserId: string
): Promise<SeedOutcome> {
  const existing = await db.query.playbookDefinitions.findFirst({
    where: and(eq(playbookDefinitions.project, project), eq(playbookDefinitions.name, definition.name)),
    columns: { id: true },
  });

  const definitionId =
    existing?.id ??
    (
      await db
        .insert(playbookDefinitions)
        .values({
          project,
          name: definition.name,
          description: definition.description,
          createdBy: seededByUserId,
        })
        .returning({ id: playbookDefinitions.id })
    )[0].id;

  const published = await db.query.playbookDefinitionVersions.findFirst({
    where: and(
      eq(playbookDefinitionVersions.definitionId, definitionId),
      eq(playbookDefinitionVersions.status, 'published')
    ),
    columns: { id: true, versionNumber: true },
  });

  if (published) {
    return {
      name: definition.name,
      definitionId,
      versionId: published.id,
      versionNumber: published.versionNumber,
      created: false,
    };
  }

  const [draft] = await db
    .insert(playbookDefinitionVersions)
    .values({ definitionId, versionNumber: 1, graph: definition.graph, status: 'draft' })
    .returning({ id: playbookDefinitionVersions.id, versionNumber: playbookDefinitionVersions.versionNumber });

  // The whole point of the script. Publishing through the service runs the structural guards, so a
  // demo definition that violates one fails here rather than halfway through the demo.
  await publishVersion(draft.id, seededByUserId);

  return {
    name: definition.name,
    definitionId,
    versionId: draft.id,
    versionNumber: draft.versionNumber,
    created: true,
  };
}

export async function seedDemoPlaybooks(
  project: string,
  seededByUserId: string
): Promise<SeedOutcome[]> {
  const outcomes: SeedOutcome[] = [];
  for (const definition of DEMO_DEFINITIONS) {
    outcomes.push(await seedDefinition(definition, project, seededByUserId));
  }
  return outcomes;
}

/** Any real user. The definitions need a `created_by` that satisfies the foreign key. */
async function resolveSeedUser(explicit?: string): Promise<string> {
  if (explicit) return explicit;

  const someone = await db.query.appUsers.findFirst({ columns: { oid: true } });
  if (!someone) {
    throw new Error(
      'No users exist in this database, so there is nobody to attribute the demo definitions to. ' +
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
  const seededByUserId = await resolveSeedUser(argValue('--user'));

  const outcomes = await seedDemoPlaybooks(project, seededByUserId);

  console.log(`Seeded demo Playbooks into project "${project}":`);
  for (const outcome of outcomes) {
    const state = outcome.created ? 'published' : 'already present';
    console.log(`  ${outcome.name} — v${outcome.versionNumber} (${state})`);
    console.log(`    definitionId ${outcome.definitionId}`);
  }
  console.log(
    '\nBoth went through the real publish path, so the structural guards ran against them.' +
      '\nRe-running this script is safe and will not create a second copy.'
  );
}

// Guarded so the tests can import the definitions and `seedDemoPlaybooks` without running main.
if (require.main === module) {
  main()
    .then(() => pool.end())
    .catch(async (error: Error) => {
      console.error('Seeding failed:', error.message);
      await pool.end().catch(() => undefined);
      process.exit(1);
    });
}
