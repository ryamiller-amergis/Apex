/**
 * Publishes the two Phase 0 demo Playbook definitions, A and B.
 *
 * In `scripts/` rather than `migrations/` for two reasons, and the second is the load-bearing one.
 * A migration would seed these into every environment it ran against, and a demo fixture belongs
 * only where the demo happens. More importantly, exit criterion E3 — "definition B runs with zero
 * lines of code changed" — is worth nothing unless B was published exactly the way A was. So this
 * goes through FEAT-007's retained-draft lifecycle, which runs the structural guards, rather than
 * inserting a row with `status = 'published'` already set. A direct insert would skip the
 * validation A passed and leave E3 proving something weaker than it appears to.
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
import { isDeepStrictEqual } from 'util';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../src/server/db/drizzle';
import pool from '../src/server/db';
import { playbookDefinitionVersions, playbookDefinitions } from '../src/server/db/schema';
import {
  createDefinition,
  publishDraft,
  updateDraft,
} from '../src/server/services/playbookDefinitionService';
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
 * Definition A — the FEAT-008-safe composition: `approval-gate` → `cursor-agent` → `notify`.
 *
 * This is the one the live demo drives, and its shape is chosen for what it lets an audience see:
 * a gate that visibly parks with an approver and a deadline before anything leaves Apex, an agent
 * step that takes real time, and a notification that proves the run resumed and finished.
 */
export const DEFINITION_A: DemoDefinition = {
  name: 'Demo A — Ask, Approve, Notify',
  description:
    'Runs a repo question through the app-knowledge Skill, waits for a person to approve the ' +
    'answer, then notifies the initiator. The definition the Phase 0 live demo drives.',
  graph: {
    nodes: [
      {
        id: 'approve',
        stepType: 'approval-gate',
        config: { subject: 'Approve the run before the agent sends work outside Apex' },
      },
      {
        id: 'ask',
        stepType: 'cursor-agent',
        config: {
          skillPath: DEMO_SKILL_PATH,
          mcpProfile: 'repository-read-only',
          prompt:
            'Summarise what the Playbook orchestration feature does, in three sentences, for ' +
            'someone who has not seen it before.',
        },
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
      { from: 'approve', to: 'ask' },
      { from: 'ask', to: 'announce' },
    ],
  },
};

/**
 * Definition B — the same safe three-step order with different configuration.
 *
 * B already led with a gate, so FEAT-008 does not need to version it forward. Its distinct ids,
 * prompt, approval subject, and notification still prove that execution comes from stored graph
 * configuration rather than a code path for Demo A.
 */
export const DEFINITION_B: DemoDefinition = {
  name: 'Demo B — Approve, Ask, Notify',
  description:
    'Gates first, then asks the app-knowledge Skill a different question, then notifies. Same ' +
    'safe step order as A with different stored configuration — the definition exit criterion E3 runs.',
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
          mcpProfile: 'repository-read-only',
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
  /** False when the current published version already had the requested graph. */
  created: boolean;
}

function graphsMatch(left: unknown, right: unknown): boolean {
  // PostgreSQL jsonb does not preserve object-key order, so string comparison would publish an
  // identical graph again after every database round trip.
  return isDeepStrictEqual(left, right);
}

/**
 * Seeds one definition and returns what it found or made.
 *
 * New definitions use FEAT-007's create/update/publish lifecycle, so v1 is immutable history and v2
 * remains the retained draft. Existing Demo A installations may have the old ungated v1. That row
 * is never edited: the retained draft is corrected and copied to a new immutable version. Comparing
 * the current published graph before publishing makes the correction idempotent.
 */
export async function seedDefinition(
  definition: DemoDefinition,
  project: string,
  seededByUserId: string
): Promise<SeedOutcome> {
  const existing = await db.query.playbookDefinitions.findFirst({
    where: and(eq(playbookDefinitions.project, project), eq(playbookDefinitions.name, definition.name)),
    columns: { id: true, name: true, description: true },
  });

  if (!existing) {
    const created = await createDefinition({
      project,
      name: definition.name,
      description: definition.description,
      graph: definition.graph,
      createdByUserId: seededByUserId,
    });
    const published = await publishDraft({
      project,
      definitionId: created.definition.id,
      publishedByUserId: seededByUserId,
      expectedDraftUpdatedAt: created.draft.updatedAt,
    });
    return {
      name: definition.name,
      definitionId: created.definition.id,
      versionId: published.publishedVersion.id,
      versionNumber: published.publishedVersion.versionNumber,
      created: true,
    };
  }

  const currentPublished = await db.query.playbookDefinitionVersions.findFirst({
    where: and(
      eq(playbookDefinitionVersions.definitionId, existing.id),
      eq(playbookDefinitionVersions.status, 'published')
    ),
    columns: { id: true, versionNumber: true, graph: true },
    orderBy: [desc(playbookDefinitionVersions.versionNumber)],
  });

  const draft = await db.query.playbookDefinitionVersions.findFirst({
    where: and(
      eq(playbookDefinitionVersions.definitionId, existing.id),
      eq(playbookDefinitionVersions.status, 'draft')
    ),
    columns: { graph: true, updatedAt: true },
  });
  if (!draft) {
    throw new Error(
      `Demo definition "${definition.name}" has no retained draft. ` +
        'Apply the FEAT-007 lifecycle migration before seeding.'
    );
  }

  let draftUpdatedAt = draft.updatedAt;
  if (
    !graphsMatch(draft.graph, definition.graph) ||
    existing.name !== definition.name ||
    existing.description !== definition.description
  ) {
    const updated = await updateDraft({
      project,
      definitionId: existing.id,
      name: definition.name,
      description: definition.description,
      graph: definition.graph,
      expectedDraftUpdatedAt: draft.updatedAt,
    });
    draftUpdatedAt = updated.draft.updatedAt;
  }

  if (currentPublished && graphsMatch(currentPublished.graph, definition.graph)) {
    return {
      name: definition.name,
      definitionId: existing.id,
      versionId: currentPublished.id,
      versionNumber: currentPublished.versionNumber,
      created: false,
    };
  }

  // Publishing copies the corrected draft. Existing published rows remain immutable.
  const published = await publishDraft({
    project,
    definitionId: existing.id,
    publishedByUserId: seededByUserId,
    expectedDraftUpdatedAt: draftUpdatedAt,
  });

  return {
    name: definition.name,
    definitionId: existing.id,
    versionId: published.publishedVersion.id,
    versionNumber: published.publishedVersion.versionNumber,
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
    '\nBoth went through the retained-draft publish path, so the structural guards ran against them.' +
      '\nRe-running is safe: a matching current version is reused, while legacy Demo A v1 remains immutable.'
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
