/**
 * Publishes the nightly MaxView self-healing Playbook and a paused 01:00 UTC schedule.
 *
 * The graph is the one discussed for the proof: a read-only investigation, one approval,
 * one Bug, then the cloud agent. The schedule is saved disabled so starting the local
 * server does not dispatch today's already-passed occurrence.
 *
 * Usage:
 *   npx dotenv -e .env -- npx ts-node --project tsconfig.server.json scripts/seed-self-healing-playbook.ts [--project MaxView] [--user <oid>]
 */
import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/server/db/drizzle';
import pool from '../src/server/db';
import { appUsers, playbookTriggerSubscriptions, userProjectAssignments } from '../src/server/db/schema';
import { createPlaybookTrigger } from '../src/server/services/playbookTriggerSubscriptionService';
import type { PlaybookGraph } from '../src/shared/types/playbook';
import { seedDefinition, type DemoDefinition } from './seed-playbook-demos';

const SKILL_PATH = 'foundation-skills/foundation/maxview-incident-investigation/SKILL.md';
const TRIGGER_NAME = 'Nightly at 01:00 UTC';

export const SELF_HEALING_PLAYBOOK: DemoDefinition = {
  name: 'Nightly MaxView self-healing',
  description:
    'Each night, scan production MaxView telemetry for one issue, wait for one approval, ' +
    'file one Bug, and start a cloud agent on that Bug. A second run waits while one is active.',
  graph: {
    nodes: [
      {
        id: 'scan',
        stepType: 'cursor-agent',
        config: {
          skillPath: SKILL_PATH,
          mcpProfile: 'repository-read-only',
          prompt:
            'No clue was given. Follow the Unattended Runs section. Scan production for the last ' +
            '24 hours, rank one candidate, and stop. Write the full finding, including the ' +
            'recommended next action, to review-scorecard.md in the output directory so the next ' +
            'step can read it. If you recommend no action, write that recommendation in the same ' +
            'file. Do not create an Azure DevOps work item.',
        },
      },
      {
        id: 'approve',
        stepType: 'approval-gate',
        config: {
          subject: 'Approve filing this finding as one Bug and starting the cloud agent',
        },
      },
      {
        id: 'file',
        stepType: 'apex-action',
        config: {
          operation: 'create-work-item',
          parameters: {
            workItemType: 'Bug',
            title: 'Nightly MaxView finding',
            description: 'Finding from the nightly production scan.\n\n${steps.scan.reportMd}',
          },
        },
      },
      {
        id: 'fix',
        stepType: 'cloud-agent',
        config: {
          workItemId: '${steps.file.workItemId}',
          workItemType: 'Bug',
          state: 'New',
        },
      },
    ],
    edges: [
      { from: 'scan', to: 'approve' },
      { from: 'approve', to: 'file' },
      { from: 'file', to: 'fix' },
    ],
  } satisfies PlaybookGraph,
};

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function resolveUser(explicit?: string): Promise<{ oid: string; email: string | null }> {
  if (explicit) {
    const named = await db.query.appUsers.findFirst({
      where: eq(appUsers.oid, explicit),
      columns: { oid: true, email: true },
    });
    if (!named) throw new Error(`No app user with oid ${explicit}.`);
    return named;
  }

  const preferred = await db.query.appUsers.findFirst({
    where: eq(appUsers.email, 'matalbot@amergis.com'),
    columns: { oid: true, email: true },
  });
  if (preferred) return preferred;

  const someone = await db.query.appUsers.findFirst({ columns: { oid: true, email: true } });
  if (!someone) {
    throw new Error('No users exist in this database. Sign in once, or pass --user <oid>.');
  }
  return someone;
}

async function resolveProject(userId: string, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const assignments = await db
    .select({ project: userProjectAssignments.project })
    .from(userProjectAssignments)
    .where(eq(userProjectAssignments.userId, userId));
  const names = assignments.map((row) => row.project);
  if (names.includes('MaxView')) return 'MaxView';
  if (names.includes('Apex')) return 'Apex';
  return names[0] ?? 'Apex';
}

async function main(): Promise<void> {
  const user = await resolveUser(argValue('--user'));
  const project = await resolveProject(user.oid, argValue('--project'));
  const outcome = await seedDefinition(SELF_HEALING_PLAYBOOK, project, user.oid);

  const existing = await db.query.playbookTriggerSubscriptions.findFirst({
    where: and(
      eq(playbookTriggerSubscriptions.project, project),
      eq(playbookTriggerSubscriptions.definitionId, outcome.definitionId),
      eq(playbookTriggerSubscriptions.name, TRIGGER_NAME),
    ),
    columns: { id: true, enabled: true },
  });

  let triggerId = existing?.id;
  let triggerCreated = false;
  if (!existing) {
    const created = await createPlaybookTrigger({
      project,
      definitionId: outcome.definitionId,
      actorUserId: user.oid,
      body: {
        name: TRIGGER_NAME,
        enabled: false,
        kind: 'schedule',
        scheduleHour: 1,
        scheduleMinute: 0,
        versionPolicy: 'current_published',
        concurrencyPolicy: 'skip_if_active',
        dedupeKeyTemplate: 'nightly-maxview-self-healing:{occurrence}',
        runInputTemplate: {},
        inputMapping: [],
      },
    });
    triggerId = created.id;
    triggerCreated = true;
  }

  const state = outcome.created ? 'published' : 'already present';
  console.log(`Project: ${project}`);
  console.log(`Initiator: ${user.email ?? user.oid}`);
  console.log(`${outcome.name} — v${outcome.versionNumber} (${state})`);
  console.log(`definitionId ${outcome.definitionId}`);
  console.log(
    `Schedule "${TRIGGER_NAME}" ${triggerCreated ? 'created' : 'already present'} ` +
      `(${existing?.enabled ? 'enabled' : 'paused'}) id ${triggerId}`,
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
