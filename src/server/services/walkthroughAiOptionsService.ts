import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { walkthroughAiOptions } from '../db/schema';
import {
  defaultWalkthroughAiOptionsRecord,
  validateSaveWalkthroughAiOptionsCommand,
  WALKTHROUGH_AI_OPTIONS_SINGLETON_ID,
  type SaveWalkthroughAiOptionsCommand,
  type WalkthroughAiOptionsRecord,
} from '../../shared/types/walkthroughAiOptions';

function mapRow(row: typeof walkthroughAiOptions.$inferSelect): WalkthroughAiOptionsRecord {
  return {
    id: WALKTHROUGH_AI_OPTIONS_SINGLETON_ID,
    walkthroughGenerationSkillPath: row.walkthroughGenerationSkillPath,
    walkthroughGenerationModel: row.walkthroughGenerationModel ?? '',
    anchorSmartTaggingSkillPath: row.anchorSmartTaggingSkillPath,
    anchorSmartTaggingModel: row.anchorSmartTaggingModel ?? '',
    createdBy: row.createdBy,
    createdByDisplayName: row.createdByDisplayName,
    createdAt: row.createdAt,
    updatedBy: row.updatedBy,
    updatedByDisplayName: row.updatedByDisplayName,
    updatedAt: row.updatedAt,
  };
}

export async function getWalkthroughAiOptions(): Promise<WalkthroughAiOptionsRecord> {
  const rows = await db
    .select()
    .from(walkthroughAiOptions)
    .where(eq(walkthroughAiOptions.id, WALKTHROUGH_AI_OPTIONS_SINGLETON_ID))
    .limit(1);
  if (!rows[0]) {
    return defaultWalkthroughAiOptionsRecord();
  }
  return mapRow(rows[0]);
}

export async function saveWalkthroughAiOptions(
  body: unknown,
  actor: { id: string; displayName: string },
): Promise<WalkthroughAiOptionsRecord> {
  const command: SaveWalkthroughAiOptionsCommand =
    validateSaveWalkthroughAiOptionsCommand(body);
  const now = new Date().toISOString();

  await db
    .insert(walkthroughAiOptions)
    .values({
      id: WALKTHROUGH_AI_OPTIONS_SINGLETON_ID,
      walkthroughGenerationSkillPath: command.walkthroughGenerationSkillPath,
      walkthroughGenerationModel: command.walkthroughGenerationModel ?? '',
      anchorSmartTaggingSkillPath: command.anchorSmartTaggingSkillPath,
      anchorSmartTaggingModel: command.anchorSmartTaggingModel ?? '',
      createdBy: actor.id,
      createdByDisplayName: actor.displayName,
      createdAt: now,
      updatedBy: actor.id,
      updatedByDisplayName: actor.displayName,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: walkthroughAiOptions.id,
      set: {
        walkthroughGenerationSkillPath: command.walkthroughGenerationSkillPath,
        walkthroughGenerationModel: command.walkthroughGenerationModel ?? '',
        anchorSmartTaggingSkillPath: command.anchorSmartTaggingSkillPath,
        anchorSmartTaggingModel: command.anchorSmartTaggingModel ?? '',
        updatedBy: actor.id,
        updatedByDisplayName: actor.displayName,
        updatedAt: now,
      },
    });

  return getWalkthroughAiOptions();
}
