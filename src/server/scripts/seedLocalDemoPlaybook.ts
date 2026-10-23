/**
 * One-off local seed. Not part of the app. Deleted after it runs.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { appUsers, featureFlags, featureFlagRules } from '../db/schema';
import { createDefinition, publishDraft } from '../services/playbookDefinitionService';
import { replaceDraftVersionLayout } from '../services/playbookVersionLayoutService';
import type { PlaybookGraph } from '../../shared/types/playbook';
import pool from '../db';

const PROJECT = 'MaxView';
const NAME = 'Demo: ask, approve, notify';

const graph: PlaybookGraph = {
  nodes: [
    {
      id: 'ask',
      stepType: 'cursor-agent',
      config: {
        skillPath: '.cursor/skills/app-knowledge/SKILL.md',
        prompt: 'Explain what a Playbook is in this repo, in a few sentences.',
        mcpProfile: 'repository-read-only',
      },
    },
    {
      id: 'approve',
      stepType: 'approval-gate',
      config: {
        subject: 'Approve the agent answer',
        approverPool: 'prd',
        gatedStepId: 'ask',
      },
    },
    {
      id: 'tell',
      stepType: 'notify',
      config: {
        title: 'Demo playbook finished',
        body: 'The agent answered and a person approved it.',
      },
    },
  ],
  edges: [
    { from: 'ask', to: 'approve' },
    { from: 'approve', to: 'tell' },
  ],
};

async function enableCanvasFlag(): Promise<void> {
  const flag = await db.query.featureFlags.findFirst({
    where: eq(featureFlags.key, 'playbooks-authoring-canvas'),
  });
  if (!flag) {
    console.log('canvas-flag missing');
    return;
  }
  if (!flag.enabled) {
    await db.update(featureFlags).set({ enabled: true, updatedAt: new Date().toISOString() }).where(eq(featureFlags.id, flag.id));
  }
  const rules = await db.query.featureFlagRules.findMany({
    where: eq(featureFlagRules.flagId, flag.id),
  });
  if (!rules.some((rule) => rule.type === 'everyone')) {
    await db.insert(featureFlagRules).values({ flagId: flag.id, type: 'everyone' });
  }
  console.log('canvas-flag on');
}

async function main(): Promise<void> {
  const user = await db.query.appUsers.findFirst({
    where: eq(appUsers.email, 'mojubile@amergis.com'),
    columns: { oid: true },
  });
  if (!user) throw new Error('No local user mojubile@amergis.com');

  await enableCanvasFlag();

  const created = await createDefinition({
    project: PROJECT,
    name: NAME,
    description:
      'A sample you can open. An agent answers a question, a person approves that answer, then Apex sends a notification.',
    graph,
    createdByUserId: user.oid,
  });

  await replaceDraftVersionLayout({
    project: PROJECT,
    definitionId: created.definition.id,
    versionId: created.draft.id,
    positions: {
      ask: { x: 40, y: 160 },
      approve: { x: 380, y: 160 },
      tell: { x: 720, y: 160 },
    },
  });

  const published = await publishDraft({
    project: PROJECT,
    definitionId: created.definition.id,
    publishedByUserId: user.oid,
    expectedDraftUpdatedAt: created.draft.updatedAt,
  });

  console.log(JSON.stringify({
    definitionId: created.definition.id,
    publishedVersionId: published.currentPublishedVersionId,
  }));
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await pool.end();
    process.exit(1);
  });
