import { db } from '../db/drizzle';
import { projectSkillSettings } from '../db/schema';
import { eq } from 'drizzle-orm';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';

export async function getSkillConfig(project: string): Promise<ProjectSkillConfig | null> {
  const rows = await db
    .select()
    .from(projectSkillSettings)
    .where(eq(projectSkillSettings.project, project))
    .limit(1);
  return rows[0] ?? null;
}

export async function listSkillConfigs(): Promise<ProjectSkillConfig[]> {
  return db.select().from(projectSkillSettings).orderBy(projectSkillSettings.project);
}

export async function upsertSkillConfig(
  project: string,
  skillRepo: string,
  skillBranch: string,
  updatedBy?: string,
  interviewSkillPath?: string | null,
  prdSkillPath?: string | null,
  designDocSkillPath?: string | null,
  interviewModel?: string | null,
  prdModel?: string | null,
  designDocModel?: string | null,
  designDocQaSkillPath?: string | null,
  designDocQaModel?: string | null,
  designDocAssistantSkillPath?: string | null,
  designDocAssistantModel?: string | null,
): Promise<ProjectSkillConfig> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(projectSkillSettings)
    .values({
      project,
      skillRepo,
      skillBranch,
      updatedBy,
      interviewSkillPath: interviewSkillPath ?? null,
      prdSkillPath: prdSkillPath ?? null,
      designDocSkillPath: designDocSkillPath ?? null,
      designDocQaSkillPath: designDocQaSkillPath ?? null,
      designDocAssistantSkillPath: designDocAssistantSkillPath ?? null,
      interviewModel: interviewModel ?? null,
      prdModel: prdModel ?? null,
      designDocModel: designDocModel ?? null,
      designDocQaModel: designDocQaModel ?? null,
      designDocAssistantModel: designDocAssistantModel ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: projectSkillSettings.project,
      set: {
        skillRepo,
        skillBranch,
        updatedBy,
        interviewSkillPath: interviewSkillPath ?? null,
        prdSkillPath: prdSkillPath ?? null,
        designDocSkillPath: designDocSkillPath ?? null,
        designDocQaSkillPath: designDocQaSkillPath ?? null,
        designDocAssistantSkillPath: designDocAssistantSkillPath ?? null,
        interviewModel: interviewModel ?? null,
        prdModel: prdModel ?? null,
        designDocModel: designDocModel ?? null,
        designDocQaModel: designDocQaModel ?? null,
        designDocAssistantModel: designDocAssistantModel ?? null,
        updatedAt: now,
      },
    })
    .returning();
  return rows[0];
}

export async function deleteSkillConfig(project: string): Promise<void> {
  await db.delete(projectSkillSettings).where(eq(projectSkillSettings.project, project));
}
