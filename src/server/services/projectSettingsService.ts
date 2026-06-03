import { db } from '../db/drizzle';
import { projectSkillSettings, projectApprovers, appUsers } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import type { ProjectSkillConfig, ProjectApprover, QuickSkillPill, QuickMcpPill } from '../../shared/types/projectSettings';
import type { ApprovalMode } from '../../shared/types/approvals';

function toSkillConfig(row: Record<string, unknown>): ProjectSkillConfig {
  return { ...row, approvalMode: row.approvalMode as ApprovalMode | undefined } as ProjectSkillConfig;
}

export async function getSkillConfig(project: string): Promise<ProjectSkillConfig | null> {
  const rows = await db
    .select()
    .from(projectSkillSettings)
    .where(eq(projectSkillSettings.project, project))
    .limit(1);
  return rows[0] ? toSkillConfig(rows[0]) : null;
}

export async function listSkillConfigs(): Promise<ProjectSkillConfig[]> {
  const rows = await db.select().from(projectSkillSettings).orderBy(projectSkillSettings.project);
  return rows.map(toSkillConfig);
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
  designDocValidationSkillPath?: string | null,
  designDocValidationModel?: string | null,
  quickSkillPills?: QuickSkillPill[] | null | undefined,
  defaultModel?: string | null,
  approvalMode?: ApprovalMode,
  quickMcpPills?: QuickMcpPill[] | null | undefined,
): Promise<ProjectSkillConfig> {
  const now = new Date().toISOString();
  const approvalModeValue = approvalMode ?? 'any_one';
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
      designDocValidationSkillPath: designDocValidationSkillPath ?? null,
      interviewModel: interviewModel ?? null,
      prdModel: prdModel ?? null,
      designDocModel: designDocModel ?? null,
      designDocQaModel: designDocQaModel ?? null,
      designDocAssistantModel: designDocAssistantModel ?? null,
      designDocValidationModel: designDocValidationModel ?? null,
      quickSkillPills: quickSkillPills ?? null,
      quickMcpPills: quickMcpPills ?? null,
      defaultModel: defaultModel ?? null,
      approvalMode: approvalModeValue,
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
        designDocValidationSkillPath: designDocValidationSkillPath ?? null,
        interviewModel: interviewModel ?? null,
        prdModel: prdModel ?? null,
        designDocModel: designDocModel ?? null,
        designDocQaModel: designDocQaModel ?? null,
        designDocAssistantModel: designDocAssistantModel ?? null,
        designDocValidationModel: designDocValidationModel ?? null,
        quickSkillPills: quickSkillPills ?? null,
        quickMcpPills: quickMcpPills ?? null,
        defaultModel: defaultModel ?? null,
        approvalMode: approvalModeValue,
        updatedAt: now,
      },
    })
    .returning();
  return toSkillConfig(rows[0]);
}

export async function deleteSkillConfig(project: string): Promise<void> {
  await db.delete(projectSkillSettings).where(eq(projectSkillSettings.project, project));
}

// ── Approver Management ──────────────────────────────────────────────────────

export async function listApprovers(project: string): Promise<ProjectApprover[]> {
  const rows = await db
    .select({
      id: projectApprovers.id,
      project: projectApprovers.project,
      userId: projectApprovers.userId,
      displayName: appUsers.displayName,
      email: appUsers.email,
      documentType: projectApprovers.documentType,
      assignedBy: projectApprovers.assignedBy,
      assignedAt: projectApprovers.assignedAt,
    })
    .from(projectApprovers)
    .innerJoin(appUsers, eq(projectApprovers.userId, appUsers.oid))
    .where(eq(projectApprovers.project, project));

  return rows.map((r) => ({
    ...r,
    documentType: r.documentType as 'design_doc' | 'prd',
  }));
}

export async function listApproversForAllProjects(): Promise<Record<string, ProjectApprover[]>> {
  const rows = await db
    .select({
      id: projectApprovers.id,
      project: projectApprovers.project,
      userId: projectApprovers.userId,
      displayName: appUsers.displayName,
      email: appUsers.email,
      documentType: projectApprovers.documentType,
      assignedBy: projectApprovers.assignedBy,
      assignedAt: projectApprovers.assignedAt,
    })
    .from(projectApprovers)
    .innerJoin(appUsers, eq(projectApprovers.userId, appUsers.oid));

  const grouped: Record<string, ProjectApprover[]> = {};
  for (const r of rows) {
    const approver: ProjectApprover = {
      ...r,
      documentType: r.documentType as 'design_doc' | 'prd',
    };
    if (!grouped[r.project]) grouped[r.project] = [];
    grouped[r.project].push(approver);
  }
  return grouped;
}

export async function setApprovers(
  project: string,
  documentType: 'design_doc' | 'prd',
  userIds: string[],
  assignedBy?: string,
): Promise<ProjectApprover[]> {
  await db.transaction(async (tx) => {
    await tx
      .delete(projectApprovers)
      .where(and(eq(projectApprovers.project, project), eq(projectApprovers.documentType, documentType)));

    if (userIds.length > 0) {
      await tx.insert(projectApprovers).values(
        userIds.map((userId) => ({
          project,
          userId,
          documentType,
          assignedBy: assignedBy ?? null,
        })),
      );
    }
  });

  return getApproversForDocument(project, documentType);
}

export async function getApproversForDocument(
  project: string,
  documentType: 'design_doc' | 'prd',
): Promise<ProjectApprover[]> {
  const rows = await db
    .select({
      id: projectApprovers.id,
      project: projectApprovers.project,
      userId: projectApprovers.userId,
      displayName: appUsers.displayName,
      email: appUsers.email,
      documentType: projectApprovers.documentType,
      assignedBy: projectApprovers.assignedBy,
      assignedAt: projectApprovers.assignedAt,
    })
    .from(projectApprovers)
    .innerJoin(appUsers, eq(projectApprovers.userId, appUsers.oid))
    .where(and(eq(projectApprovers.project, project), eq(projectApprovers.documentType, documentType)));

  return rows.map((r) => ({
    ...r,
    documentType: r.documentType as 'design_doc' | 'prd',
  }));
}
