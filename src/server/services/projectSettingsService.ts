import { db } from '../db/drizzle';
import {
  projectSkillSettings,
  projectApprovers,
  projectApproverGroups,
  projectApprovalModes,
  appGroupMembers,
  appGroups,
  appUsers,
} from '../db/schema';
import { eq, and, asc, desc } from 'drizzle-orm';
import * as groupService from './groupService';
import type {
  ProjectSkillConfig,
  ProjectApprover,
  QuickSkillPill,
  QuickMcpPill,
  InterviewSkillOption,
  ApproverPoolResponse,
  SkillProvider,
  PrototypeEngine,
  RepositoryCheckoutStatus,
} from '../../shared/types/projectSettings';
import type { GroupWithMembers } from '../../shared/types/groups';
import type {
  ApprovalMode,
  ModuleApprovalModes,
  ReviewerDocumentType,
} from '../../shared/types/approvals';
import { emitGroundingActiveSetChanged } from './groundingMaintenanceEvents';
import { isProjectRepositoryCheckoutReadinessEnabled } from './featureFlagService';

function toSkillConfig(row: Record<string, unknown>): ProjectSkillConfig {
  return {
    ...row,
    approvalMode: row.approvalMode as ApprovalMode | undefined,
    repositoryCheckoutStatus:
      (row.repositoryCheckoutStatus as RepositoryCheckoutStatus | undefined) ??
      'not_cloned',
  } as ProjectSkillConfig;
}

function repositoryIdentityChanged(
  previous: {
    skillProvider: string;
    skillRepo: string;
    skillBranch: string;
  },
  next: {
    skillProvider: string;
    skillRepo: string;
    skillBranch: string;
  },
): boolean {
  return (
    previous.skillProvider !== next.skillProvider ||
    previous.skillRepo.trim() !== next.skillRepo.trim() ||
    previous.skillBranch.trim() !== next.skillBranch.trim()
  );
}

const CHECKOUT_RESET = {
  repositoryCheckoutStatus: 'not_cloned' as const,
  repositoryCheckoutSha: null,
  repositoryCheckoutError: null,
  repositoryCheckoutStartedAt: null,
  repositoryCheckoutCompletedAt: null,
};

/** Returns the **default** config for a project (back-compat for existing callers). */
export async function getSkillConfig(
  project: string
): Promise<ProjectSkillConfig | null> {
  const rows = await db
    .select()
    .from(projectSkillSettings)
    .where(
      and(
        eq(projectSkillSettings.project, project),
        eq(projectSkillSettings.isDefault, true)
      )
    )
    .limit(1);
  return rows[0] ? toSkillConfig(rows[0]) : null;
}

export async function getSkillConfigById(
  id: string
): Promise<ProjectSkillConfig | null> {
  const rows = await db
    .select()
    .from(projectSkillSettings)
    .where(eq(projectSkillSettings.id, id))
    .limit(1);
  return rows[0] ? toSkillConfig(rows[0]) : null;
}

export async function listSkillConfigsForProject(
  project: string
): Promise<ProjectSkillConfig[]> {
  const rows = await db
    .select()
    .from(projectSkillSettings)
    .where(eq(projectSkillSettings.project, project))
    .orderBy(
      desc(projectSkillSettings.isDefault),
      asc(projectSkillSettings.friendlyName)
    );
  return rows.map(toSkillConfig);
}

export async function resolveSkillConfig(opts: {
  project: string;
  settingsId?: string;
}): Promise<ProjectSkillConfig | null> {
  if (opts.settingsId) return getSkillConfigById(opts.settingsId);
  return getSkillConfig(opts.project);
}

export async function listSkillConfigs(): Promise<ProjectSkillConfig[]> {
  const rows = await db
    .select()
    .from(projectSkillSettings)
    .orderBy(projectSkillSettings.project);
  return rows.map(toSkillConfig);
}

export async function getSkillSettingsName(
  settingsId: string | null | undefined
): Promise<string | null> {
  if (!settingsId) return null;
  const row = await db.query.projectSkillSettings.findFirst({
    where: eq(projectSkillSettings.id, settingsId),
    columns: { friendlyName: true },
  });
  return row?.friendlyName ?? null;
}

// ── Upsert / Delete ──────────────────────────────────────────────────────────

export interface UpsertSkillConfigOptions {
  id?: string;
  project: string;
  friendlyName: string;
  skillProvider?: SkillProvider;
  skillRepo: string;
  skillBranch: string;
  isDefault?: boolean;
  updatedBy?: string;
  interviewSkillPath?: string | null;
  prdSkillPath?: string | null;
  adrInterviewSkillPath?: string | null;
  adrFinalizeSkillPath?: string | null;
  adrAssistantSkillPath?: string | null;
  designDocSkillPath?: string | null;
  designDocAssistantSkillPath?: string | null;
  designPrototypeSkillPath?: string | null;
  testCaseSkillPath?: string | null;
  designDocValidationSkillPath?: string | null;
  prdValidationSkillPath?: string | null;
  interviewModel?: string | null;
  prdModel?: string | null;
  adrModel?: string | null;
  designDocModel?: string | null;
  designDocAssistantModel?: string | null;
  designPrototypeModel?: string | null;
  testCaseModel?: string | null;
  designDocValidationModel?: string | null;
  prdAssistantSkillPath?: string | null;
  prdAssistantModel?: string | null;
  prdValidationModel?: string | null;
  defaultModel?: string | null;
  prdReviewBedrockModelId?: string | null;
  prdReviewBedrockMaxTokens?: number | null;
  designPrototypeBedrockModelId?: string | null;
  designPrototypeBedrockMaxTokens?: number | null;
  designPrototypeBedrockTimeoutMs?: number | null;
  designPrototypeRegenBedrockModelId?: string | null;
  designPrototypeRegenBedrockMaxTokens?: number | null;
  designPlanBedrockModelId?: string | null;
  designPlanBedrockMaxTokens?: number | null;
  developmentSkillPath?: string | null;
  developmentModel?: string | null;
  featureRequestSkillPath?: string | null;
  featureRequestModel?: string | null;
  technicalSkillPath?: string | null;
  technicalModel?: string | null;
  issueSkillPath?: string | null;
  issueModel?: string | null;
  prdValidationScoreThreshold?: number | null;
  designDocValidationScoreThreshold?: number | null;
  uiLabBedrockModelId?: string | null;
  uiLabBedrockMaxTokens?: number | null;
  uiLabBedrockTimeoutMs?: number | null;
  uiLabRegenBedrockModelId?: string | null;
  uiLabRegenBedrockMaxTokens?: number | null;
  uiLabBedrockTemperature?: number | null;
  uiLabSkillPath?: string | null;
  calendarAssistantSkillPath?: string | null;
  calendarAssistantModel?: string | null;
  loadTestGenerationSkillPath?: string | null;
  loadTestGenerationModel?: string | null;
  designModuleSkillPath?: string | null;
  designModuleModel?: string | null;
  designModuleScopingSkillPath?: string | null;
  designModuleScopingModel?: string | null;
  quickSkillPills?: QuickSkillPill[] | null;
  quickMcpPills?: QuickMcpPill[] | null;
  interviewSkillOptions?: InterviewSkillOption[] | null;
  prototypeStageEnabled?: boolean;
  interviewWebResearchEnabled?: boolean;
  interviewWebMcp?: QuickMcpPill | null;
  prototypeEngine?: PrototypeEngine;
  prototypeDesignSystemPath?: string | null;
  screenInventoryPath?: string | null;
  prototypeWebReferencesEnabled?: boolean;
  approvalMode?: ApprovalMode;
  approvalModes?: Partial<ModuleApprovalModes>;
}

export async function upsertSkillConfig(
  opts: UpsertSkillConfigOptions
): Promise<ProjectSkillConfig> {
  const now = new Date().toISOString();
  const providedApprovalModes = validateApprovalModeEntries(
    opts.approvalModes ?? {}
  );
  const approvalModeValue =
    opts.approvalModes?.prd ?? opts.approvalMode ?? 'any_one';

  const values = {
    project: opts.project,
    friendlyName: opts.friendlyName,
    skillProvider: opts.skillProvider ?? 'ado',
    skillRepo: opts.skillRepo,
    skillBranch: opts.skillBranch,
    isDefault: opts.isDefault ?? false,
    updatedBy: opts.updatedBy,
    interviewSkillPath: opts.interviewSkillPath ?? null,
    prdSkillPath: opts.prdSkillPath ?? null,
    adrInterviewSkillPath: opts.adrInterviewSkillPath ?? null,
    adrFinalizeSkillPath: opts.adrFinalizeSkillPath ?? null,
    adrAssistantSkillPath: opts.adrAssistantSkillPath ?? null,
    designDocSkillPath: opts.designDocSkillPath ?? null,
    designDocAssistantSkillPath: opts.designDocAssistantSkillPath ?? null,
    designPrototypeSkillPath: opts.designPrototypeSkillPath ?? null,
    testCaseSkillPath: opts.testCaseSkillPath ?? null,
    designDocValidationSkillPath: opts.designDocValidationSkillPath ?? null,
    prdAssistantSkillPath: opts.prdAssistantSkillPath ?? null,
    interviewModel: opts.interviewModel ?? null,
    prdModel: opts.prdModel ?? null,
    adrModel: opts.adrModel ?? null,
    designDocModel: opts.designDocModel ?? null,
    designDocAssistantModel: opts.designDocAssistantModel ?? null,
    designPrototypeModel: opts.designPrototypeModel ?? null,
    testCaseModel: opts.testCaseModel ?? null,
    designDocValidationModel: opts.designDocValidationModel ?? null,
    prdAssistantModel: opts.prdAssistantModel ?? null,
    prdValidationSkillPath: opts.prdValidationSkillPath ?? null,
    prdValidationModel: opts.prdValidationModel ?? null,
    prdReviewBedrockModelId: opts.prdReviewBedrockModelId ?? null,
    prdReviewBedrockMaxTokens: opts.prdReviewBedrockMaxTokens ?? null,
    designPrototypeBedrockModelId: opts.designPrototypeBedrockModelId ?? null,
    designPrototypeBedrockMaxTokens:
      opts.designPrototypeBedrockMaxTokens ?? null,
    designPrototypeBedrockTimeoutMs:
      opts.designPrototypeBedrockTimeoutMs ?? null,
    designPrototypeRegenBedrockModelId:
      opts.designPrototypeRegenBedrockModelId ?? null,
    designPrototypeRegenBedrockMaxTokens:
      opts.designPrototypeRegenBedrockMaxTokens ?? null,
    designPlanBedrockModelId: opts.designPlanBedrockModelId ?? null,
    designPlanBedrockMaxTokens: opts.designPlanBedrockMaxTokens ?? null,
    developmentSkillPath: opts.developmentSkillPath ?? null,
    developmentModel: opts.developmentModel ?? null,
    featureRequestSkillPath: opts.featureRequestSkillPath ?? null,
    featureRequestModel: opts.featureRequestModel ?? null,
    technicalSkillPath: opts.technicalSkillPath ?? null,
    technicalModel: opts.technicalModel ?? null,
    issueSkillPath: opts.issueSkillPath ?? null,
    issueModel: opts.issueModel ?? null,
    prdValidationScoreThreshold: opts.prdValidationScoreThreshold ?? null,
    designDocValidationScoreThreshold:
      opts.designDocValidationScoreThreshold ?? null,
    uiLabBedrockModelId: opts.uiLabBedrockModelId ?? null,
    uiLabBedrockMaxTokens: opts.uiLabBedrockMaxTokens ?? null,
    uiLabBedrockTimeoutMs: opts.uiLabBedrockTimeoutMs ?? null,
    uiLabRegenBedrockModelId: opts.uiLabRegenBedrockModelId ?? null,
    uiLabRegenBedrockMaxTokens: opts.uiLabRegenBedrockMaxTokens ?? null,
    uiLabBedrockTemperature: opts.uiLabBedrockTemperature ?? null,
    uiLabSkillPath: opts.uiLabSkillPath ?? null,
    calendarAssistantSkillPath: opts.calendarAssistantSkillPath ?? null,
    calendarAssistantModel: opts.calendarAssistantModel ?? null,
    loadTestGenerationSkillPath: opts.loadTestGenerationSkillPath ?? null,
    loadTestGenerationModel: opts.loadTestGenerationModel ?? null,
    designModuleSkillPath: opts.designModuleSkillPath ?? null,
    designModuleModel: opts.designModuleModel ?? null,
    designModuleScopingSkillPath: opts.designModuleScopingSkillPath ?? null,
    designModuleScopingModel: opts.designModuleScopingModel ?? null,
    quickSkillPills: opts.quickSkillPills ?? null,
    quickMcpPills: opts.quickMcpPills ?? null,
    interviewSkillOptions: opts.interviewSkillOptions ?? null,
    prototypeStageEnabled: opts.prototypeStageEnabled ?? true,
    interviewWebResearchEnabled: opts.interviewWebResearchEnabled ?? false,
    interviewWebMcp: opts.interviewWebMcp ?? null,
    prototypeEngine: opts.prototypeEngine ?? 'bedrock',
    prototypeDesignSystemPath: opts.prototypeDesignSystemPath ?? null,
    screenInventoryPath: opts.screenInventoryPath ?? null,
    prototypeWebReferencesEnabled: opts.prototypeWebReferencesEnabled ?? false,
    defaultModel: opts.defaultModel ?? null,
    approvalMode: approvalModeValue,
    updatedAt: now,
  };

  const result = await db.transaction(async (tx) => {
    if (values.isDefault) {
      await tx
        .update(projectSkillSettings)
        .set({ isDefault: false })
        .where(
          and(
            eq(projectSkillSettings.project, opts.project),
            eq(projectSkillSettings.isDefault, true)
          )
        );
    }

    if (opts.id) {
      const existingRows = await tx
        .select()
        .from(projectSkillSettings)
        .where(eq(projectSkillSettings.id, opts.id))
        .limit(1);
      const existing = existingRows[0];
      const resetCheckout =
        existing &&
        repositoryIdentityChanged(
          {
            skillProvider: existing.skillProvider,
            skillRepo: existing.skillRepo,
            skillBranch: existing.skillBranch,
          },
          {
            skillProvider: values.skillProvider,
            skillRepo: values.skillRepo,
            skillBranch: values.skillBranch,
          },
        );

      const rows = await tx
        .update(projectSkillSettings)
        .set(resetCheckout ? { ...values, ...CHECKOUT_RESET } : values)
        .where(eq(projectSkillSettings.id, opts.id))
        .returning();
      const row = rows[0];
      await writeApprovalModeRows(
        tx,
        row.id,
        providedApprovalModes,
        now,
        false
      );
      return row;
    }

    // INSERT — if it's the first config for the project, force isDefault = true
    // New configs start not_cloned via column default / explicit reset fields.
    const existing = await tx
      .select({ id: projectSkillSettings.id })
      .from(projectSkillSettings)
      .where(eq(projectSkillSettings.project, opts.project))
      .limit(1);
    if (existing.length === 0) {
      values.isDefault = true;
    }

    const rows = await tx
      .insert(projectSkillSettings)
      .values({ ...values, ...CHECKOUT_RESET })
      .returning();
    const row = rows[0];
    const initialModes: ModuleApprovalModes = {
      prd: approvalModeValue,
      design_doc: approvalModeValue,
      design_prototype: approvalModeValue,
      test_case: approvalModeValue,
      adr: 'any_one',
      ...opts.approvalModes,
    };
    await writeApprovalModeRows(
      tx,
      row.id,
      validateApprovalModeEntries(initialModes),
      now,
      false
    );
    return row;
  });

  await groupService.seedDefaultGroupsForProject(opts.project, opts.updatedBy);
  const repository = opts.skillRepo.trim();
  const provider =
    (opts.skillProvider ?? 'ado') === 'github' ? 'github' : 'azure_devops';
  // Deployment B: admin-managed checkouts do not need settings→prewarm. Skip
  // the active-set emit when checkout readiness is ON for this project.
  // @feature-flag:project-repository-checkout-readiness start winner=enabled
  let checkoutReadinessEnabled = false;
  try {
    checkoutReadinessEnabled =
      await isProjectRepositoryCheckoutReadinessEnabled({
        userId: opts.updatedBy ?? 'system',
        project: opts.project,
        caller: 'project-settings',
      });
  } catch {
    checkoutReadinessEnabled = false;
  }
  if (!checkoutReadinessEnabled) {
    // @feature-flag:project-repository-checkout-readiness disabled-start
    emitGroundingActiveSetChanged({
      provider,
      project: opts.project,
      repository:
        provider === 'github'
          ? repository.split('/').pop() || repository
          : repository,
      branch: opts.skillBranch.trim(),
    });
    // @feature-flag:project-repository-checkout-readiness disabled-end
  }
  // @feature-flag:project-repository-checkout-readiness end
  return toSkillConfig(result);
}

/**
 * Persist admin clone/refresh lifecycle fields for a skill-settings row.
 * Used by projectRepositoryCheckoutService — not a public admin CRUD API.
 */
export async function updateRepositoryCheckoutState(
  skillSettingsId: string,
  state: {
    status: RepositoryCheckoutStatus;
    sha?: string | null;
    error?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
  },
): Promise<ProjectSkillConfig | null> {
  const rows = await db
    .update(projectSkillSettings)
    .set({
      repositoryCheckoutStatus: state.status,
      ...(state.sha !== undefined
        ? { repositoryCheckoutSha: state.sha }
        : {}),
      ...(state.error !== undefined
        ? { repositoryCheckoutError: state.error }
        : {}),
      ...(state.startedAt !== undefined
        ? { repositoryCheckoutStartedAt: state.startedAt }
        : {}),
      ...(state.completedAt !== undefined
        ? { repositoryCheckoutCompletedAt: state.completedAt }
        : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(projectSkillSettings.id, skillSettingsId))
    .returning();
  return rows[0] ? toSkillConfig(rows[0]) : null;
}

export async function deleteSkillConfig(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(projectSkillSettings)
      .where(eq(projectSkillSettings.id, id))
      .limit(1);

    if (rows.length === 0) return;
    const row = rows[0];

    const siblings = await tx
      .select({ id: projectSkillSettings.id })
      .from(projectSkillSettings)
      .where(eq(projectSkillSettings.project, row.project));

    if (siblings.length <= 1) {
      throw new Error('Cannot delete the only repo config for a project');
    }

    await tx
      .delete(projectSkillSettings)
      .where(eq(projectSkillSettings.id, id));

    if (row.isDefault) {
      const oldest = await tx
        .select({ id: projectSkillSettings.id })
        .from(projectSkillSettings)
        .where(eq(projectSkillSettings.project, row.project))
        .orderBy(asc(projectSkillSettings.createdAt))
        .limit(1);

      if (oldest.length > 0) {
        await tx
          .update(projectSkillSettings)
          .set({ isDefault: true })
          .where(eq(projectSkillSettings.id, oldest[0].id));
      }
    }
  });
}

// ── Approver Management ──────────────────────────────────────────────────────

export async function listApprovers(
  settingsId: string
): Promise<ProjectApprover[]> {
  const rows = await db
    .select({
      id: projectApprovers.id,
      settingsId: projectApprovers.settingsId,
      userId: projectApprovers.userId,
      displayName: appUsers.displayName,
      email: appUsers.email,
      documentType: projectApprovers.documentType,
      assignedBy: projectApprovers.assignedBy,
      assignedAt: projectApprovers.assignedAt,
    })
    .from(projectApprovers)
    .innerJoin(appUsers, eq(projectApprovers.userId, appUsers.oid))
    .where(eq(projectApprovers.settingsId, settingsId));

  return rows.map((r) => ({
    ...r,
    documentType: r.documentType as ReviewerDocumentType,
  }));
}

export async function listApproversForAllProjects(): Promise<
  Record<string, ProjectApprover[]>
> {
  let rows: Array<{
    id: string;
    settingsId: string;
    userId: string;
    displayName: string | null;
    email: string | null;
    documentType: string;
    assignedBy: string | null;
    assignedAt: string;
  }>;
  try {
    rows = await db
      .select({
        id: projectApprovers.id,
        settingsId: projectApprovers.settingsId,
        userId: projectApprovers.userId,
        displayName: appUsers.displayName,
        email: appUsers.email,
        documentType: projectApprovers.documentType,
        assignedBy: projectApprovers.assignedBy,
        assignedAt: projectApprovers.assignedAt,
      })
      .from(projectApprovers)
      .innerJoin(appUsers, eq(projectApprovers.userId, appUsers.oid));
  } catch {
    // Table may not exist on fresh local environments; return empty gracefully.
    return {};
  }

  const grouped: Record<string, ProjectApprover[]> = {};
  for (const r of rows) {
    const approver: ProjectApprover = {
      ...r,
      documentType: r.documentType as ReviewerDocumentType,
    };
    if (!grouped[r.settingsId]) grouped[r.settingsId] = [];
    grouped[r.settingsId].push(approver);
  }
  return grouped;
}

export async function setApprovers(
  settingsId: string,
  documentType: ReviewerDocumentType,
  userIds: string[],
  assignedBy?: string
): Promise<ProjectApprover[]> {
  await db.transaction(async (tx) => {
    await tx
      .delete(projectApprovers)
      .where(
        and(
          eq(projectApprovers.settingsId, settingsId),
          eq(projectApprovers.documentType, documentType)
        )
      );

    if (userIds.length > 0) {
      await tx.insert(projectApprovers).values(
        userIds.map((userId) => ({
          settingsId,
          userId,
          documentType,
          assignedBy: assignedBy ?? null,
        }))
      );
    }
  });

  return getApproversForDocument(settingsId, documentType);
}

export async function getApproversForDocument(
  settingsId: string,
  documentType: ReviewerDocumentType
): Promise<ProjectApprover[]> {
  const rows = await db
    .select({
      id: projectApprovers.id,
      settingsId: projectApprovers.settingsId,
      userId: projectApprovers.userId,
      displayName: appUsers.displayName,
      email: appUsers.email,
      documentType: projectApprovers.documentType,
      assignedBy: projectApprovers.assignedBy,
      assignedAt: projectApprovers.assignedAt,
    })
    .from(projectApprovers)
    .innerJoin(appUsers, eq(projectApprovers.userId, appUsers.oid))
    .where(
      and(
        eq(projectApprovers.settingsId, settingsId),
        eq(projectApprovers.documentType, documentType)
      )
    );

  return rows.map((r) => ({
    ...r,
    documentType: r.documentType as ReviewerDocumentType,
  }));
}

export async function setApproverGroups(
  settingsId: string,
  documentType: ReviewerDocumentType,
  groupIds: string[],
  assignedBy?: string
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(projectApproverGroups)
      .where(
        and(
          eq(projectApproverGroups.settingsId, settingsId),
          eq(projectApproverGroups.documentType, documentType)
        )
      );

    if (groupIds.length > 0) {
      await tx.insert(projectApproverGroups).values(
        groupIds.map((groupId) => ({
          settingsId,
          groupId,
          documentType,
          assignedBy: assignedBy ?? null,
        }))
      );
    }
  });
}

export interface ApproverPoolReplacement {
  individuals: string[];
  groups: string[];
}

/**
 * Replaces every supplied module's individual and group pools in one
 * transaction. Omitted modules remain unchanged.
 */
export async function replaceApproverPools(
  settingsId: string,
  pools: Partial<Record<ReviewerDocumentType, ApproverPoolReplacement>>,
  assignedBy?: string
): Promise<void> {
  const entries = Object.entries(pools);
  for (const [documentType, pool] of entries) {
    if (!isReviewerDocumentType(documentType)) {
      throw new Error(`Unsupported reviewer document type: ${documentType}`);
    }
    if (
      !pool ||
      !Array.isArray(pool.individuals) ||
      !pool.individuals.every((value) => typeof value === 'string') ||
      !Array.isArray(pool.groups) ||
      !pool.groups.every((value) => typeof value === 'string')
    ) {
      throw new Error(`Invalid approver pool for ${documentType}`);
    }
  }

  if (entries.length === 0) return;

  await db.transaction(async (tx) => {
    for (const [documentType, pool] of entries) {
      const typedDocumentType = documentType as ReviewerDocumentType;
      const typedPool = pool as ApproverPoolReplacement;

      await tx
        .delete(projectApprovers)
        .where(
          and(
            eq(projectApprovers.settingsId, settingsId),
            eq(projectApprovers.documentType, typedDocumentType)
          )
        );
      await tx
        .delete(projectApproverGroups)
        .where(
          and(
            eq(projectApproverGroups.settingsId, settingsId),
            eq(projectApproverGroups.documentType, typedDocumentType)
          )
        );

      if (typedPool.individuals.length > 0) {
        await tx.insert(projectApprovers).values(
          typedPool.individuals.map((userId) => ({
            settingsId,
            userId,
            documentType: typedDocumentType,
            assignedBy: assignedBy ?? null,
          }))
        );
      }
      if (typedPool.groups.length > 0) {
        await tx.insert(projectApproverGroups).values(
          typedPool.groups.map((groupId) => ({
            settingsId,
            groupId,
            documentType: typedDocumentType,
            assignedBy: assignedBy ?? null,
          }))
        );
      }
    }
  });
}

export async function getApproverPool(
  settingsId: string,
  documentType: ReviewerDocumentType
): Promise<ApproverPoolResponse> {
  const individuals = await getApproversForDocument(settingsId, documentType);

  const groupRefs = await db
    .select({
      id: projectApproverGroups.id,
      settingsId: projectApproverGroups.settingsId,
      groupId: projectApproverGroups.groupId,
      documentType: projectApproverGroups.documentType,
      assignedBy: projectApproverGroups.assignedBy,
      assignedAt: projectApproverGroups.assignedAt,
      groupName: appGroups.name,
      groupDescription: appGroups.description,
      groupProject: appGroups.project,
      groupIsDefault: appGroups.isDefault,
      groupCreatedBy: appGroups.createdBy,
      groupCreatedAt: appGroups.createdAt,
    })
    .from(projectApproverGroups)
    .innerJoin(appGroups, eq(projectApproverGroups.groupId, appGroups.id))
    .where(
      and(
        eq(projectApproverGroups.settingsId, settingsId),
        eq(projectApproverGroups.documentType, documentType)
      )
    );

  const groups: Array<
    GroupWithMembers & { documentType: ReviewerDocumentType }
  > = [];
  for (const ref of groupRefs) {
    const memberRows = await db
      .select({
        groupId: appGroupMembers.groupId,
        userId: appGroupMembers.userId,
        displayName: appUsers.displayName,
        email: appUsers.email,
        addedBy: appGroupMembers.addedBy,
        addedAt: appGroupMembers.addedAt,
      })
      .from(appGroupMembers)
      .innerJoin(appUsers, eq(appGroupMembers.userId, appUsers.oid))
      .where(eq(appGroupMembers.groupId, ref.groupId));

    groups.push({
      id: ref.groupId,
      name: ref.groupName,
      description: ref.groupDescription,
      project: ref.groupProject,
      isDefault: ref.groupIsDefault,
      createdBy: ref.groupCreatedBy,
      createdAt: ref.groupCreatedAt,
      documentType: ref.documentType as ReviewerDocumentType,
      members: memberRows,
    });
  }

  return { individuals, groups };
}

export async function getApproverUserIds(
  settingsId: string,
  documentType: ReviewerDocumentType
): Promise<string[]> {
  const pool = await getApproverPool(settingsId, documentType);
  const userIds = new Set<string>();
  for (const ind of pool.individuals) {
    userIds.add(ind.userId);
  }
  for (const group of pool.groups) {
    for (const member of group.members) {
      userIds.add(member.userId);
    }
  }
  return [...userIds];
}

/** Back-compat wrapper: resolves the default config for a project, then fetches approver user IDs. */
export async function getApproverUserIdsForProject(
  project: string,
  documentType: ReviewerDocumentType
): Promise<string[]> {
  const config = await getSkillConfig(project);
  if (!config?.id) return [];
  return getApproverUserIds(config.id, documentType);
}

/** Back-compat wrapper: resolves the default config for a project, then fetches the approver pool. */
export async function getApproverPoolForProject(
  project: string,
  documentType: ReviewerDocumentType
): Promise<ApproverPoolResponse> {
  const config = await getSkillConfig(project);
  if (!config?.id) return { individuals: [], groups: [] };
  return getApproverPool(config.id, documentType);
}

/** Back-compat wrapper: resolves the default config for a project, then fetches approvers for a document type. */
export async function getApproversForDocumentByProject(
  project: string,
  documentType: ReviewerDocumentType
): Promise<ProjectApprover[]> {
  const config = await getSkillConfig(project);
  if (!config?.id) return [];
  return getApproversForDocument(config.id, documentType);
}

export async function listApproverGroupsForProject(
  settingsId: string
): Promise<
  Array<{ groupId: string; groupName: string; documentType: string }>
> {
  const rows = await db
    .select({
      groupId: projectApproverGroups.groupId,
      groupName: appGroups.name,
      documentType: projectApproverGroups.documentType,
    })
    .from(projectApproverGroups)
    .innerJoin(appGroups, eq(projectApproverGroups.groupId, appGroups.id))
    .where(eq(projectApproverGroups.settingsId, settingsId));
  return rows;
}

export async function listApproverGroupsForAllProjects(): Promise<
  Record<
    string,
    Array<{ groupId: string; groupName: string; documentType: string }>
  >
> {
  let rows: Array<{
    settingsId: string;
    groupId: string;
    groupName: string;
    documentType: string;
  }>;
  try {
    rows = await db
      .select({
        settingsId: projectApproverGroups.settingsId,
        groupId: projectApproverGroups.groupId,
        groupName: appGroups.name,
        documentType: projectApproverGroups.documentType,
      })
      .from(projectApproverGroups)
      .innerJoin(appGroups, eq(projectApproverGroups.groupId, appGroups.id));
  } catch {
    // Table may not exist on fresh local environments; return empty gracefully.
    return {};
  }

  const grouped: Record<
    string,
    Array<{ groupId: string; groupName: string; documentType: string }>
  > = {};
  for (const r of rows) {
    if (!grouped[r.settingsId]) grouped[r.settingsId] = [];
    grouped[r.settingsId].push({
      groupId: r.groupId,
      groupName: r.groupName,
      documentType: r.documentType,
    });
  }
  return grouped;
}

// ── Approval Modes (per reviewer module) ─────────────────────────────────────

/** Every module that carries a reviewer pool and an approval mode. */
export const REVIEWER_DOCUMENT_TYPES: readonly ReviewerDocumentType[] = [
  'prd',
  'design_doc',
  'design_prototype',
  'test_case',
  'adr',
];

export const APPROVAL_MODES: readonly ApprovalMode[] = [
  'any_one',
  'all_required',
];

export function isReviewerDocumentType(
  value: unknown
): value is ReviewerDocumentType {
  return (
    typeof value === 'string' &&
    REVIEWER_DOCUMENT_TYPES.includes(value as ReviewerDocumentType)
  );
}

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return (
    typeof value === 'string' &&
    APPROVAL_MODES.includes(value as ApprovalMode)
  );
}

function assertReviewerDocumentType(
  value: string
): asserts value is ReviewerDocumentType {
  if (!isReviewerDocumentType(value)) {
    throw new Error(`Unsupported reviewer document type: ${value}`);
  }
}

function assertApprovalMode(value: string): asserts value is ApprovalMode {
  if (!isApprovalMode(value)) {
    throw new Error(`Unsupported approval mode: ${value}`);
  }
}

function validateApprovalModeEntries(
  modes: Partial<ModuleApprovalModes>
): Array<[ReviewerDocumentType, ApprovalMode]> {
  const entries = Object.entries(modes);
  for (const [documentType, mode] of entries) {
    if (!isReviewerDocumentType(documentType)) {
      throw new Error(`Unsupported reviewer document type: ${documentType}`);
    }
    if (!isApprovalMode(mode)) {
      throw new Error(`Unsupported approval mode: ${String(mode)}`);
    }
  }
  return entries as Array<[ReviewerDocumentType, ApprovalMode]>;
}

async function writeApprovalModeRows(
  tx: Pick<typeof db, 'insert' | 'update'>,
  settingsId: string,
  entries: Array<[ReviewerDocumentType, ApprovalMode]>,
  now: string,
  mirrorPrdLegacy: boolean
): Promise<void> {
  for (const [documentType, mode] of entries) {
    await tx
      .insert(projectApprovalModes)
      .values({ settingsId, documentType, mode, updatedAt: now })
      .onConflictDoUpdate({
        target: [
          projectApprovalModes.settingsId,
          projectApprovalModes.documentType,
        ],
        set: { mode, updatedAt: now },
      });
  }

  const prdMode = entries.find(([documentType]) => documentType === 'prd')?.[1];
  if (mirrorPrdLegacy && prdMode !== undefined) {
    await tx
      .update(projectSkillSettings)
      .set({ approvalMode: prdMode, updatedAt: now })
      .where(eq(projectSkillSettings.id, settingsId));
  }
}

/**
 * Mode to use when no per-module row exists yet. The four pre-existing modules
 * inherit the legacy project-wide column so partially migrated databases keep
 * resolving the mode an admin already configured; `adr` has no legacy value and
 * starts permissive.
 */
function fallbackApprovalMode(
  documentType: ReviewerDocumentType,
  legacyMode: ApprovalMode | null | undefined
): ApprovalMode {
  if (documentType === 'adr') return 'any_one';
  return legacyMode ?? 'any_one';
}

/** Reads the stored per-module mode, or null when the module has no row yet. */
async function readStoredApprovalMode(
  settingsId: string,
  documentType: ReviewerDocumentType
): Promise<ApprovalMode | null> {
  const rows = await db
    .select({ mode: projectApprovalModes.mode })
    .from(projectApprovalModes)
    .where(
      and(
        eq(projectApprovalModes.settingsId, settingsId),
        eq(projectApprovalModes.documentType, documentType)
      )
    )
    .limit(1);
  return rows[0]?.mode ?? null;
}

async function readLegacyApprovalMode(
  settingsId: string
): Promise<ApprovalMode | null> {
  const rows = await db
    .select({ approvalMode: projectSkillSettings.approvalMode })
    .from(projectSkillSettings)
    .where(eq(projectSkillSettings.id, settingsId))
    .limit(1);
  return rows[0]?.approvalMode ?? null;
}

/**
 * Approval mode for one module of one settings config. Falls back to the legacy
 * project-wide column (or `any_one` for `adr`) when the module row is missing;
 * the fallback is never written back to storage.
 */
export async function getApprovalMode(
  settingsId: string,
  documentType: ReviewerDocumentType
): Promise<ApprovalMode> {
  assertReviewerDocumentType(documentType);

  const stored = await readStoredApprovalMode(settingsId, documentType);
  if (stored) return stored;

  // `adr` has no legacy column to inherit, so skip that read entirely.
  const legacyMode =
    documentType === 'adr' ? null : await readLegacyApprovalMode(settingsId);
  return fallbackApprovalMode(documentType, legacyMode);
}

/**
 * Complete module→mode map for a settings config. Missing rows resolve through
 * the same fallback as {@link getApprovalMode}, so a partially migrated database
 * still yields a mode for every module without a write.
 */
export async function getApprovalModes(
  settingsId: string
): Promise<ModuleApprovalModes> {
  const rows = await db
    .select({
      documentType: projectApprovalModes.documentType,
      mode: projectApprovalModes.mode,
    })
    .from(projectApprovalModes)
    .where(eq(projectApprovalModes.settingsId, settingsId));

  const stored = new Map<string, ApprovalMode>(
    rows.map((r) => [r.documentType, r.mode])
  );

  const needsLegacy = REVIEWER_DOCUMENT_TYPES.some(
    (documentType) => documentType !== 'adr' && !stored.has(documentType)
  );
  const legacyMode = needsLegacy
    ? await readLegacyApprovalMode(settingsId)
    : null;

  const modes = {} as ModuleApprovalModes;
  for (const documentType of REVIEWER_DOCUMENT_TYPES) {
    modes[documentType] =
      stored.get(documentType) ??
      fallbackApprovalMode(documentType, legacyMode);
  }
  return modes;
}

/**
 * Writes one module's approval mode. `prd` is the canonical mirror for the
 * retained legacy project-wide column, so a PRD write updates both rows in one
 * transaction; writes to any other module leave the legacy column alone.
 */
export async function setApprovalMode(
  settingsId: string,
  documentType: ReviewerDocumentType,
  mode: ApprovalMode
): Promise<void> {
  assertReviewerDocumentType(documentType);
  assertApprovalMode(mode);

  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    await tx
      .insert(projectApprovalModes)
      .values({ settingsId, documentType, mode, updatedAt: now })
      .onConflictDoUpdate({
        target: [
          projectApprovalModes.settingsId,
          projectApprovalModes.documentType,
        ],
        set: { mode, updatedAt: now },
      });

    if (documentType === 'prd') {
      await tx
        .update(projectSkillSettings)
        .set({ approvalMode: mode, updatedAt: now })
        .where(eq(projectSkillSettings.id, settingsId));
    }
  });
}

/**
 * Writes a partial module map in one transaction. All keys and values are
 * validated before the transaction starts; omitted modules remain unchanged.
 */
export async function setApprovalModes(
  settingsId: string,
  modes: Partial<ModuleApprovalModes>
): Promise<void> {
  const entries = validateApprovalModeEntries(modes);

  if (entries.length === 0) return;
  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    await writeApprovalModeRows(tx, settingsId, entries, now, true);
  });
}

/** Back-compat wrapper: resolves the default config for a project, then reads that module's mode. */
export async function getApprovalModeForProject(
  project: string,
  documentType: ReviewerDocumentType
): Promise<ApprovalMode> {
  assertReviewerDocumentType(documentType);

  const config = await getSkillConfig(project);
  if (!config?.id) return fallbackApprovalMode(documentType, null);

  const stored = await readStoredApprovalMode(config.id, documentType);
  return stored ?? fallbackApprovalMode(documentType, config.approvalMode);
}
