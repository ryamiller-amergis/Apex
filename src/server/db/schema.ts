import { bigint, bigserial, boolean, check, date, index, integer, jsonb, numeric, pgTable, primaryKey, real, smallint, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import type { RepoProvider, RepoRole, RunType } from '../../shared/types/runGrounding';
import type { BuildAllowlistAuditAction } from '../../shared/types/buildAccess';
import type {
  OverlayTextBox,
  PageManifestEntry,
  PdfConversionStatus,
  PdfFileMetadata,
  PdfJobType,
  PdfSessionStatus,
  PdfSignatureState,
  PdfTextFormValue,
} from '../../shared/types/pdf';
import type {
  WorkItemHierarchyNode,
  WorkItemChangeSet,
  WorkItemProposalStatus,
  WorkItemAssistantSessionStatus,
  WorkItemApplyItemResult,
} from '../../shared/types/calendarWorkItemAssistant';
import type {
  AgentRunCancelEvent,
  AgentRunEventStatus,
  AgentRunEventType,
  AgentRunPhase,
  ChatThreadKickoff,
  SseEvent,
} from '../../shared/types/chat';
import type { McpServerOperation } from '../../shared/types/mcpServers';
import type {
  AgentRunCancelState,
  AgentRunExecutionSnapshot,
  AgentRunLane,
  AgentRunStatus,
  AgentRunTerminalReason,
  AgentRunWorkflowClass,
  RunCheckResult,
} from '../../shared/types/agentRunLifecycle';
import type {
  DurableInteractiveTurnSpecification,
  InteractiveClass,
} from '../../shared/types/durableInteractiveTurn';
import type {
  AiControlPlaneLeaseKey,
  AiRunArtifactStatus,
  AiRunBlobRef,
  AiRunTransportVersion,
  AiRunV2AttemptStatus,
  AiRunV2FailureCategory,
} from '../../shared/types/aiRunV2';
import type {
  WorkflowEvaluationCriteriaScores,
  WorkflowEvaluationJobEvaluator,
  WorkflowEvaluationJobResultBlobRefs,
  WorkflowEvaluationJobStatus,
  WorkflowEvaluationOutcome,
  WorkflowEvaluationReasonCode,
  WorkflowEvaluationRubric,
  WorkflowEvaluationSubjectType,
} from '../../shared/types/workflowEvaluation';
import type { ContentSnapshot, DesignDocValidationOverride, PrdReadinessOverride, PrdValidationBaseline, TestCaseCoverageSummary, ValidationScorecard } from '../../shared/types/interview';
import type { DesignPrototypeHistoryEntry } from '../../shared/types/designPrototype';
import type { UiLabHistoryEntry } from '../../shared/types/uiLab';
import type { DevSessionSetupPhase, LeftoverWorkSummary } from '../../shared/types/devWorkbench';
import type { DesignPlanFeature, DesignPlanHistoryEntry } from '../../shared/types/designPlan';
import type { QuickSkillPill, QuickMcpPill, InterviewSkillOption, PrototypeEngine } from '../../shared/types/projectSettings';
import type { EffortLevel } from '../../shared/types/effort';
import type { ApprovalMode, OwnerApprovalStatus, ReviewerDocumentType } from '../../shared/types/approvals';
import type { MenuItemKey } from '../../shared/types/menuSettings';
import type { ArtifactDoneEventType } from '../../shared/types/homeDashboard';
import type { ProjectAccessRequestStatus } from '../../shared/types/platformAdmin';
import type { FlagLifecycle, FlagRuleType, FlagAuditAction } from '../../shared/types/featureFlags';
import type { WorkItemType } from '../../shared/types/featureRequest';
import type { DesignModuleIconKey } from '../../shared/types/designModule';
import type {
  LoadProfile,
  LoadTestEngine,
  LoadTestExecutionSnapshot,
  LoadTestFlowType,
  LoadTestRunSource,
  LoadTestScriptSource,
  FlowStep,
  RunStatus,
  Threshold,
  ThresholdResult,
  ArtifactRef,
} from '../../shared/types/loadTest';
import type {
  BuildClassification,
  BuildCorrelationKind,
  BuildDeploymentStatus,
  BuildEventSeverity,
  BuildProfile,
  BuildQualityManifestSnapshot,
  BuildRequirement,
  BuildReuseEntry,
  BuildRiskDecision,
  BuildRunStatus,
  BuildSkillSnapshot,
  BuildSupportContact,
  BuildSuspendReason,
  BuildTaskRole,
  BuildTaskRunMode,
  BuildTaskStatus,
  BuildTestEvidence,
  BuildTestRef,
  BuildTestTier,
  BuildVerificationKind,
  BuildVerificationStatus,
} from '../../shared/types/build';
import type {
  DiagramShareAccess,
  ExcalidrawScene,
} from '../../shared/types/diagram';
import type {
  InterviewProfileSnapshot,
  InterviewStepMode,
  PlaybookGraph,
  PlaybookLayoutPositions,
  PlaybookRunStatus,
  PlaybookStepBlobRef,
  PlaybookStepRunStatus,
  PlaybookVersionStatus,
} from '../../shared/types/playbook';
import type {
  InterviewBriefSections,
  InterviewBriefStatus,
  InterviewSpecialistReviewStatus,
} from '../../shared/types/interview';
import type { ApiKeyCadence, ApiKeyScope } from '../../shared/types/apiKey';
import type { SafeTraceDetails, TraceEventType } from '../../shared/types/observability';
import type {
  WalkthroughAnchorPlacement,
  WalkthroughGenerationProvenance,
  WalkthroughLifecycle,
  WalkthroughProgressStatus,
  WalkthroughTargetRuleType,
} from '../../shared/types/walkthrough';
import type {
  WalkthroughAnchorAiProvenance,
  WalkthroughAnchorReviewStatus,
  WalkthroughAnchorSourceKind,
  WalkthroughAnchorSourceLocation,
} from '../../shared/types/walkthroughAnchorRegistry';
import type { WalkthroughRegistryPlacement } from '../../shared/walkthroughAnchors';
import { WALKTHROUGH_AI_OPTIONS_SINGLETON_ID } from '../../shared/types/walkthroughAiOptions';

// ── Tables ────────────────────────────────────────────────────────────────────

export const chatThreads = pgTable('chat_threads', {
  id: uuid('id').primaryKey(),
  userId: text('user_id').notNull(),
  status: text('status').notNull().default('idle'),
  kickoff: jsonb('kickoff').$type<ChatThreadKickoff>().notNull(),
  cursorAgentId: text('cursor_agent_id'),
  groundingMode: text('grounding_mode'),
  groundedSha: text('grounded_sha'),
  workspaceDir: text('workspace_dir'),
  lastError: text('last_error'),
  savedWikiUrl: text('saved_wiki_url'),
  title: text('title'),
  flagged: boolean('flagged').notNull().default(false),
  flaggedAt: timestamp('flagged_at', { withTimezone: true, mode: 'string' }),
  activeRunId: text('active_run_id'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const chatMessages = pgTable('chat_messages', {
  id: uuid('id').primaryKey(),
  threadId: uuid('thread_id').notNull(),
  role: text('role').notNull(),
  text: text('text').notNull(),
  toolName: text('tool_name'),
  hidden: boolean('hidden').notNull().default(false),
  ts: timestamp('ts', { withTimezone: true, mode: 'string' }).notNull(),
});

export const chatMessageAttachments = pgTable('chat_message_attachments', {
  id: uuid('id').primaryKey(),
  messageId: uuid('message_id').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull().default('text/plain'),
  size: integer('size').notNull(),
  path: text('path'),
  blobRef: jsonb('blob_ref').$type<AiRunBlobRef>(),
  sha256: text('sha256'),
}, (t) => ({
  sha256Check: check(
    'chat_message_attachments_sha256_check',
    sql`${t.sha256} IS NULL OR ${t.sha256} ~ '^[0-9a-f]{64}$'`,
  ),
}));

// ── Relations (enable db.query.* relational API) ──────────────────────────────

export const threadsRelations = relations(chatThreads, ({ many }) => ({
  messages: many(chatMessages),
  interviews: many(interviews),
  prds: many(prds),
  testCases: many(testCases),
  designDocs: many(designDocs, { relationName: 'designDocChatThread' }),
}));

export const messagesRelations = relations(chatMessages, ({ one, many }) => ({
  thread: one(chatThreads, {
    fields: [chatMessages.threadId],
    references: [chatThreads.id],
  }),
  attachments: many(chatMessageAttachments),
}));

export const attachmentsRelations = relations(chatMessageAttachments, ({ one }) => ({
  message: one(chatMessages, {
    fields: [chatMessageAttachments.messageId],
    references: [chatMessages.id],
  }),
}));

// ── Dev Sessions ──────────────────────────────────────────────────────────────

export const devSessions = pgTable('dev_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workItemId: integer('work_item_id'),
  project: text('project').notNull(),
  chatThreadId: uuid('chat_thread_id').references(() => chatThreads.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull(),
  branchName: text('branch_name'),
  prdId: uuid('prd_id').references(() => prds.id, { onDelete: 'set null' }),
  featureId: text('feature_id'),
  // status values: setting_up | in_progress | conflict | closed | failed
  status: text('status').notNull().default('setting_up'),
  setupError: text('setup_error'),
  setupPhase: text('setup_phase').$type<DevSessionSetupPhase>(),
  setupDetail: text('setup_detail'),
  setupProgressAt: timestamp('setup_progress_at', { withTimezone: true, mode: 'string' }),
  prUrl: text('pr_url'),
  cachedDiffText: text('cached_diff_text'),
  cachedChangedFiles: jsonb('cached_changed_files').$type<string[]>().default([]),
  branchPushed: boolean('branch_pushed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  // Soft pointer to agent_runs.id (text). No FK — avoids a circular reference
  // with agent_runs.dev_session_id.
  currentRunId: text('current_run_id'),
  currentRunPrUrl: text('current_run_pr_url'),
  currentRunPrStatus: text('current_run_pr_status').$type<'none' | 'open' | 'abandoned' | 'merged'>().default('none'),
  leftoverWork: jsonb('leftover_work').$type<LeftoverWorkSummary>(),
}, (t) => ({
  currentRunPrStatusCheck: check(
    'dev_sessions_current_run_pr_status_check',
    sql`${t.currentRunPrStatus} IS NULL OR ${t.currentRunPrStatus} IN ('none', 'open', 'abandoned', 'merged')`,
  ),
}));

export const devSessionsRelations = relations(devSessions, ({ one }) => ({
  chatThread: one(chatThreads, {
    fields: [devSessions.chatThreadId],
    references: [chatThreads.id],
  }),
}));

export const repoCacheLeases = pgTable('repo_cache_leases', {
  cacheKey: text('cache_key').primaryKey(),
  ownerId: text('owner_id').notNull(),
  generation: integer('generation').notNull().default(1),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  expiresAtIdx: index('idx_repo_cache_leases_expires_at').on(t.expiresAt),
}));

export const groundingProfiles = pgTable('grounding_profiles', {
  idHash: text('id_hash').primaryKey(),
  runRef: text('run_ref').notNull(),
  provider: text('provider').notNull(),
  project: text('project').notNull(),
  repo: text('repo').notNull(),
  sha: text('sha').notNull(),
  checkoutPath: text('checkout_path').notNull(),
  mirrorPath: text('mirror_path'),
  caller: text('caller'),
  ownerUserId: text('owner_user_id').notNull(),
  ownerRunRef: text('owner_run_ref').notNull(),
  ownerProject: text('owner_project').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  expiresAtIdx: index('idx_grounding_profiles_expires_at').on(t.expiresAt),
}));

export const runGroundings = pgTable('run_groundings', {
  id: uuid('id').primaryKey().defaultRandom(),
  runType: text('run_type').$type<RunType>().notNull(),
  runId: text('run_id').notNull(),
  repoRole: text('repo_role').$type<RepoRole>().notNull(),
  provider: text('provider').$type<RepoProvider>().notNull(),
  project: text('project').notNull(),
  repository: text('repository').notNull(),
  branch: text('branch').notNull(),
  groundedSha: text('grounded_sha').notNull(),
  groundedAt: timestamp('grounded_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  runTypeCheck: check(
    'run_groundings_run_type_check',
    sql`${t.runType} IN ('chat', 'one_shot', 'service')`,
  ),
  repoRoleCheck: check(
    'run_groundings_repo_role_check',
    sql`${t.repoRole} IN ('target', 'skill')`,
  ),
  providerCheck: check(
    'run_groundings_provider_check',
    sql`${t.provider} IN ('github', 'azure_devops')`,
  ),
  runLookupIdx: index('idx_run_groundings_run_lookup').on(t.runType, t.runId),
  activeRepoBranchIdx: index('idx_run_groundings_active_repo_branch')
    .on(t.provider, t.project, t.repository, t.branch)
    .where(sql`${t.isActive}`),
  activeRunRoleUq: uniqueIndex('uq_run_groundings_active_run_role')
    .on(t.runType, t.runId, t.repoRole)
    .where(sql`${t.isActive}`),
}));

// ── RBAC Tables ───────────────────────────────────────────────────────────────

export const appUsers = pgTable('app_users', {
  oid: text('oid').primaryKey(),
  displayName: text('display_name'),
  email: text('email'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'string' }),
  lastSeenChangelogVersion: text('last_seen_changelog_version'),
  showChangelogOnLogin: boolean('show_changelog_on_login').notNull().default(true),
  dismissedBetaProdAnnouncement: boolean('dismissed_beta_prod_announcement').notNull().default(false),
  generationSoundEnabled: boolean('generation_sound_enabled').notNull().default(false),
  generationSoundId: text('generation_sound_id').notNull().default('chime'),
});

/**
 * One-to-one personal profile content keyed by Azure AD object ID.
 * Optional bio and avatar metadata live here — not on app_users (RBAC identity cache).
 */
export const userProfiles = pgTable('user_profiles', {
  userOid: text('user_oid').primaryKey().references(() => appUsers.oid, { onDelete: 'cascade' }),
  bio: text('bio'),
  avatarBlobKey: text('avatar_blob_key'),
  avatarUpdatedAt: timestamp('avatar_updated_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  userOidIdx: index('idx_user_profiles_user_oid').on(t.userOid),
}));

export const appRoles = pgTable('app_roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').unique().notNull(),
  description: text('description'),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const appPermissions = pgTable('app_permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').unique().notNull(),
  description: text('description'),
  category: text('category'),
});

export const appRolePermissions = pgTable('app_role_permissions', {
  roleId: uuid('role_id').notNull().references(() => appRoles.id, { onDelete: 'cascade' }),
  permissionId: uuid('permission_id').notNull().references(() => appPermissions.id, { onDelete: 'cascade' }),
}, (t) => ({
  pk: primaryKey({ columns: [t.roleId, t.permissionId] }),
}));

export const appUserRoles = pgTable('app_user_roles', {
  userId: text('user_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  roleId: uuid('role_id').notNull().references(() => appRoles.id, { onDelete: 'cascade' }),
  assignedBy: text('assigned_by'),
  assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.roleId] }),
}));

export const appUserProjectRoles = pgTable('app_user_project_roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  project: text('project').notNull(),
  roleId: uuid('role_id').notNull().references(() => appRoles.id, { onDelete: 'cascade' }),
  assignedBy: text('assigned_by'),
  assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  userProjectRoleUniq: unique('app_user_project_roles_user_project_role_key').on(t.userId, t.project, t.roleId),
  userProjectIdx: index('idx_app_user_project_roles_user_project').on(t.userId, t.project),
}));

// ── RBAC Relations ────────────────────────────────────────────────────────────

export const appUsersRelations = relations(appUsers, ({ many, one }) => ({
  userRoles: many(appUserRoles),
  projectRoles: many(appUserProjectRoles),
  groupMemberships: many(appGroupMembers),
  projectAssignments: many(userProjectAssignments),
  projectAccessRequests: many(projectAccessRequests),
  featureRequests: many(featureRequests),
  profile: one(userProfiles, {
    fields: [appUsers.oid],
    references: [userProfiles.userOid],
  }),
}));

export const userProfilesRelations = relations(userProfiles, ({ one }) => ({
  user: one(appUsers, {
    fields: [userProfiles.userOid],
    references: [appUsers.oid],
  }),
}));

export const appRolesRelations = relations(appRoles, ({ many }) => ({
  userRoles: many(appUserRoles),
  projectRoles: many(appUserProjectRoles),
  rolePermissions: many(appRolePermissions),
}));

export const appPermissionsRelations = relations(appPermissions, ({ many }) => ({
  rolePermissions: many(appRolePermissions),
}));

export const appRolePermissionsRelations = relations(appRolePermissions, ({ one }) => ({
  role: one(appRoles, { fields: [appRolePermissions.roleId], references: [appRoles.id] }),
  permission: one(appPermissions, { fields: [appRolePermissions.permissionId], references: [appPermissions.id] }),
}));

export const appUserRolesRelations = relations(appUserRoles, ({ one }) => ({
  user: one(appUsers, { fields: [appUserRoles.userId], references: [appUsers.oid] }),
  role: one(appRoles, { fields: [appUserRoles.roleId], references: [appRoles.id] }),
}));

export const appUserProjectRolesRelations = relations(appUserProjectRoles, ({ one }) => ({
  user: one(appUsers, { fields: [appUserProjectRoles.userId], references: [appUsers.oid] }),
  role: one(appRoles, { fields: [appUserProjectRoles.roleId], references: [appRoles.id] }),
}));

// ── User Project Assignments ──────────────────────────────────────────────────

export const userProjectAssignments = pgTable('user_project_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  project: text('project').notNull(),
  assignedBy: text('assigned_by'),
  assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  uniq: unique().on(t.userId, t.project),
}));

export const userProjectAssignmentsRelations = relations(userProjectAssignments, ({ one }) => ({
  user: one(appUsers, {
    fields: [userProjectAssignments.userId],
    references: [appUsers.oid],
  }),
}));

// ── Pending Project Assignments ───────────────────────────────────────────────

export const pendingProjectAssignments = pgTable('pending_project_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  project: text('project').notNull(),
  assignedBy: text('assigned_by'),
  assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  uniq: unique().on(t.email, t.project),
}));

// ── Restricted User Access ────────────────────────────────────────────────────

export const restrictedUserAccess = pgTable('restricted_user_access', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  roleId: uuid('role_id').notNull().references(() => appRoles.id, { onDelete: 'restrict' }),
  modules: jsonb('modules').$type<MenuItemKey[]>().notNull().default([]),
  enabled: boolean('enabled').notNull().default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const restrictedUserAccessRelations = relations(restrictedUserAccess, ({ one }) => ({
  role: one(appRoles, {
    fields: [restrictedUserAccess.roleId],
    references: [appRoles.id],
  }),
}));

// Emails a platform admin has approved to sign in on the dev site.
// Platform admins themselves are admitted from the super-admin list and are not stored here.
export const devEnvAllowlist = pgTable('dev_env_allowlist', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const buildAllowlist = pgTable('build_allowlist', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').notNull(),
  repository: text('repository').notNull(),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  projectRepositoryKey: unique('build_allowlist_project_repository_key').on(t.project, t.repository),
}));

export const buildAllowlistAudit = pgTable('build_allowlist_audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  action: text('action').$type<BuildAllowlistAuditAction>().notNull(),
  project: text('project').notNull(),
  repository: text('repository').notNull(),
  actorId: text('actor_id').notNull(),
  actorLabel: text('actor_label'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  actionCheck: check('build_allowlist_audit_action_check', sql`${t.action} IN ('added', 'removed')`),
  createdAtIdx: index('build_allowlist_audit_created_at_idx').on(t.createdAt),
}));

export const projectAccessRequests = pgTable('project_access_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  project: text('project').notNull(),
  status: text('status').$type<ProjectAccessRequestStatus>().notNull().default('pending'),
  requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'string' }),
  reviewNote: text('review_note'),
}, (t) => ({
  userIdx: index('idx_project_access_requests_user_id').on(t.userId),
  statusIdx: index('idx_project_access_requests_status').on(t.status),
  projectIdx: index('idx_project_access_requests_project').on(t.project),
}));

export const projectAccessRequestsRelations = relations(projectAccessRequests, ({ one }) => ({
  user: one(appUsers, {
    fields: [projectAccessRequests.userId],
    references: [appUsers.oid],
  }),
}));

// ── Groups Tables ─────────────────────────────────────────────────────────────
// Reusable, organizational user groups (e.g. Developers, Product, UI/UX).
// Fully separate from RBAC app_roles, which are permission-based.

export const appGroups = pgTable('app_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  project: text('project'),
  isDefault: boolean('is_default').notNull().default(false),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const appGroupMembers = pgTable('app_group_members', {
  groupId: uuid('group_id').notNull().references(() => appGroups.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  addedBy: text('added_by'),
  addedAt: timestamp('added_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.groupId, t.userId] }),
}));

// ── Groups Relations ──────────────────────────────────────────────────────────

export const appGroupsRelations = relations(appGroups, ({ many }) => ({
  members: many(appGroupMembers),
  projectApproverGroups: many(projectApproverGroups),
}));

export const appGroupMembersRelations = relations(appGroupMembers, ({ one }) => ({
  group: one(appGroups, { fields: [appGroupMembers.groupId], references: [appGroups.id] }),
  user: one(appUsers, { fields: [appGroupMembers.userId], references: [appUsers.oid] }),
}));

// ── Interview Tables ───────────────────────────────────────────────────────────

export const interviews = pgTable('interviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  chatThreadId: uuid('chat_thread_id').notNull().unique(),
  authorId: text('author_id').notNull(),
  title: text('title').notNull().default('Untitled Interview'),
  project: text('project').notNull(),
  repo: text('repo').notNull(),
  model: text('model'),
  effort: text('effort').$type<EffortLevel>(),
  prdOwnerId: text('prd_owner_id').references(() => appUsers.oid, { onDelete: 'set null' }),
  designDocOwnerId: text('design_doc_owner_id').references(() => appUsers.oid, { onDelete: 'set null' }),
  designPrototypeOwnerId: text('design_prototype_owner_id').references(() => appUsers.oid, { onDelete: 'set null' }),
  testCaseOwnerId: text('test_case_owner_id').references(() => appUsers.oid, { onDelete: 'set null' }),
  discoveryAssigneeId: text('discovery_assignee_id').references(() => appUsers.oid, { onDelete: 'set null' }),
  deliveryAssigneeId: text('delivery_assignee_id').references(() => appUsers.oid, { onDelete: 'set null' }),
  technicalAssigneeId: text('technical_assignee_id').references(() => appUsers.oid, { onDelete: 'set null' }),
  prdApproverIds: jsonb('prd_approver_ids').$type<string[]>(),
  designDocApproverIds: jsonb('design_doc_approver_ids').$type<string[]>(),
  designPrototypeApproverIds: jsonb('design_prototype_approver_ids').$type<string[]>(),
  testCaseApproverIds: jsonb('test_case_approver_ids').$type<string[]>(),
  skillSettingsId: uuid('skill_settings_id'),
  prototypeStageEnabled: boolean('prototype_stage_enabled').notNull().default(true),
  testCasesEnabled: boolean('test_cases_enabled').notNull().default(true),
  status: text('status').notNull().default('in_progress'),
  /** Set together when a Playbook interview step started this interview. Ordinary interviews leave them null. */
  playbookRunId: uuid('playbook_run_id').references(() => playbookRuns.id, { onDelete: 'restrict' }),
  playbookStepRunId: uuid('playbook_step_run_id').references(() => playbookStepRuns.id, { onDelete: 'restrict' }),
  playbookInterviewMode: text('playbook_interview_mode').$type<InterviewStepMode>(),
  playbookProfileKey: text('playbook_profile_key'),
  playbookProfileSnapshot: jsonb('playbook_profile_snapshot').$type<InterviewProfileSnapshot>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  playbookStepRunUq: uniqueIndex('uq_interviews_playbook_step_run')
    .on(t.playbookStepRunId)
    .where(sql`${t.playbookStepRunId} IS NOT NULL`),
  playbookRunIdx: index('idx_interviews_playbook_run')
    .on(t.playbookRunId)
    .where(sql`${t.playbookRunId} IS NOT NULL`),
  playbookInterviewModeCheck: check(
    'interviews_playbook_interview_mode_check',
    sql`${t.playbookInterviewMode} IS NULL OR ${t.playbookInterviewMode} IN ('human_led', 'multi_agent_assisted')`,
  ),
  playbookLinkageCheck: check(
    'interviews_playbook_linkage_check',
    sql`(
      (${t.playbookRunId} IS NULL
        AND ${t.playbookStepRunId} IS NULL
        AND ${t.playbookInterviewMode} IS NULL
        AND ${t.playbookProfileKey} IS NULL
        AND ${t.playbookProfileSnapshot} IS NULL)
      OR
      (${t.playbookRunId} IS NOT NULL
        AND ${t.playbookStepRunId} IS NOT NULL
        AND ${t.playbookInterviewMode} IS NOT NULL
        AND ${t.playbookProfileKey} IS NOT NULL
        AND length(btrim(${t.playbookProfileKey})) > 0
        AND ${t.playbookProfileSnapshot} IS NOT NULL
        AND jsonb_typeof(${t.playbookProfileSnapshot}) = 'object')
    )`,
  ),
}));

/** Typed Interview ↔ ADR grounding links (FEAT-001). */
export const interviewAdrLinks = pgTable('interview_adr_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  interviewId: uuid('interview_id').notNull().references(() => interviews.id, { onDelete: 'cascade' }),
  adrId: uuid('adr_id').notNull().references(() => adrs.id, { onDelete: 'cascade' }),
  linkedBy: text('linked_by').notNull(),
  linkedAt: timestamp('linked_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  interviewAdrUq: unique('uq_interview_adr_links_interview_adr').on(t.interviewId, t.adrId),
  interviewIdx: index('idx_interview_adr_links_interview_id').on(t.interviewId),
}));

/** Typed Interview ↔ Design Module grounding links (FEAT-001). */
export const interviewDesignModuleLinks = pgTable('interview_design_module_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  interviewId: uuid('interview_id').notNull().references(() => interviews.id, { onDelete: 'cascade' }),
  designModuleId: uuid('design_module_id').notNull().references(() => designModules.id, { onDelete: 'cascade' }),
  linkedBy: text('linked_by').notNull(),
  linkedAt: timestamp('linked_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  interviewModuleUq: unique('uq_interview_design_module_links_interview_module').on(t.interviewId, t.designModuleId),
  interviewIdx: index('idx_interview_design_module_links_interview_id').on(t.interviewId),
}));

function briefSectionsCheck(sections: AnyPgColumn) {
  return sql`
    jsonb_typeof(${sections}) = 'object'
    AND ${sections} ?& ARRAY['problemAndOutcome','users','scope','businessRules','scenarios','acceptanceCriteria','assumptions','unresolvedItems']
    AND (${sections} - ARRAY['problemAndOutcome','users','scope','businessRules','scenarios','acceptanceCriteria','assumptions','unresolvedItems']) = '{}'::jsonb
    AND jsonb_typeof(${sections} -> 'problemAndOutcome') = 'string'
    AND jsonb_typeof(${sections} -> 'users') = 'string'
    AND jsonb_typeof(${sections} -> 'scope') = 'string'
    AND jsonb_typeof(${sections} -> 'businessRules') = 'string'
    AND jsonb_typeof(${sections} -> 'scenarios') = 'string'
    AND jsonb_typeof(${sections} -> 'acceptanceCriteria') = 'string'
    AND jsonb_typeof(${sections} -> 'assumptions') = 'string'
    AND jsonb_typeof(${sections} -> 'unresolvedItems') = 'array'
  `;
}

/** Current brief for an interview. Revisions keep every prior save. */
export const interviewBriefs = pgTable('interview_briefs', {
  id: uuid('id').primaryKey().defaultRandom(),
  interviewId: uuid('interview_id').notNull().references(() => interviews.id, { onDelete: 'cascade' }),
  status: text('status').$type<InterviewBriefStatus>().notNull().default('draft'),
  version: integer('version').notNull(),
  sections: jsonb('sections').$type<InterviewBriefSections>().notNull(),
  approvedBy: text('approved_by').references(() => appUsers.oid, { onDelete: 'restrict' }),
  approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  interviewUq: unique('uq_interview_briefs_interview').on(t.interviewId),
  statusCheck: check(
    'interview_briefs_status_check',
    sql`${t.status} IN ('draft', 'approved')`,
  ),
  versionCheck: check('interview_briefs_version_check', sql`${t.version} >= 1`),
  approvalCheck: check(
    'interview_briefs_approval_check',
    sql`(
      (${t.status} = 'draft' AND ${t.approvedBy} IS NULL AND ${t.approvedAt} IS NULL)
      OR
      (${t.status} = 'approved' AND ${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL)
    )`,
  ),
  sectionsCheck: check('interview_briefs_sections_check', briefSectionsCheck(t.sections)),
}));

/** Immutable copy of the brief at each save and at approval. No updated_at. */
export const interviewBriefRevisions = pgTable('interview_brief_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  briefId: uuid('brief_id').notNull().references(() => interviewBriefs.id, { onDelete: 'cascade' }),
  interviewId: uuid('interview_id').notNull().references(() => interviews.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  status: text('status').$type<InterviewBriefStatus>().notNull(),
  sections: jsonb('sections').$type<InterviewBriefSections>().notNull(),
  createdBy: text('created_by').notNull().references(() => appUsers.oid, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  briefVersionUq: unique('uq_interview_brief_revisions_brief_version').on(t.briefId, t.version),
  interviewIdx: index('idx_interview_brief_revisions_interview').on(t.interviewId, t.version),
  statusCheck: check(
    'interview_brief_revisions_status_check',
    sql`${t.status} IN ('draft', 'approved')`,
  ),
  versionCheck: check('interview_brief_revisions_version_check', sql`${t.version} >= 1`),
  sectionsCheck: check('interview_brief_revisions_sections_check', briefSectionsCheck(t.sections)),
}));

/** One row per specialist attempt. `result` is structured JSON; chain-of-thought is not stored. */
export const interviewSpecialistReviews = pgTable('interview_specialist_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  interviewId: uuid('interview_id').notNull().references(() => interviews.id, { onDelete: 'cascade' }),
  briefVersion: integer('brief_version').notNull(),
  specialist: text('specialist').notNull(),
  status: text('status').$type<InterviewSpecialistReviewStatus>().notNull(),
  result: jsonb('result').$type<Record<string, unknown>>().notNull(),
  model: text('model'),
  durationMs: integer('duration_ms').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  interviewVersionIdx: index('idx_interview_specialist_reviews_interview_version').on(t.interviewId, t.briefVersion),
  specialistIdx: index('idx_interview_specialist_reviews_specialist').on(t.specialist),
  specialistCheck: check(
    'interview_specialist_reviews_specialist_check',
    sql`length(btrim(${t.specialist})) > 0`,
  ),
  statusCheck: check(
    'interview_specialist_reviews_status_check',
    sql`${t.status} IN ('succeeded', 'failed')`,
  ),
  resultCheck: check(
    'interview_specialist_reviews_result_check',
    sql`jsonb_typeof(${t.result}) = 'object'`,
  ),
  briefVersionCheck: check(
    'interview_specialist_reviews_brief_version_check',
    sql`${t.briefVersion} >= 1`,
  ),
  durationCheck: check(
    'interview_specialist_reviews_duration_check',
    sql`${t.durationMs} >= 0`,
  ),
}));

export const adrs = pgTable('adrs', {
  id: uuid('id').primaryKey().defaultRandom(),
  chatThreadId: uuid('chat_thread_id').notNull().unique().references(() => chatThreads.id, { onDelete: 'cascade' }),
  adrAssistantThreadId: uuid('adr_assistant_thread_id').references(() => chatThreads.id, { onDelete: 'set null' }),
  generationThreadId: uuid('generation_thread_id').references(() => chatThreads.id, { onDelete: 'set null' }),
  authorId: text('author_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  reviewerIds: jsonb('reviewer_ids').$type<string[]>(),
  title: text('title').notNull().default('Untitled ADR'),
  project: text('project').notNull(),
  repo: text('repo').notNull(),
  model: text('model'),
  effort: text('effort').$type<EffortLevel>(),
  skillSettingsId: uuid('skill_settings_id').references(() => projectSkillSettings.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('in_progress'),
  content: text('content').notNull().default(''),
  proposedContent: text('proposed_content'),
  fixCommentId: uuid('fix_comment_id'),
  slug: text('slug'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const prds = pgTable('prds', {
  id: uuid('id').primaryKey().defaultRandom(),
  interviewId: uuid('interview_id'),
  chatThreadId: uuid('chat_thread_id'),
  authorId: text('author_id').notNull(),
  project: text('project').notNull(),
  title: text('title').notNull().default('Untitled PRD'),
  model: text('model'),
  effort: text('effort').$type<EffortLevel>(),
  content: text('content').notNull().default(''),
  backlogJson: jsonb('backlog_json'),
  status: text('status').notNull().default('draft'),
  reviewerId: text('reviewer_id'),
  reviewComment: text('review_comment'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'string' }),
  designDocApproverIds: jsonb('design_doc_approver_ids').$type<string[]>(),
  designPrototypeApproverIds: jsonb('design_prototype_approver_ids').$type<string[]>(),
  prdAssistantThreadId: uuid('prd_assistant_thread_id'),
  proposedContent: text('proposed_content'),
  proposedBacklogJson: jsonb('proposed_backlog_json'),
  fixCommentId: uuid('fix_comment_id'),
  validationThreadId: uuid('validation_thread_id'),
  validationScore: integer('validation_score'),
  validationScorecard: jsonb('validation_scorecard').$type<ValidationScorecard>(),
  validationReportMd: text('validation_report_md'),
  validationPhase: text('validation_phase'),
  fixBaseline: jsonb('fix_baseline').$type<PrdValidationBaseline>(),
  readinessOverride: jsonb('readiness_override').$type<PrdReadinessOverride>(),
  skillSettingsId: uuid('skill_settings_id'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const testCases = pgTable('test_cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  prdId: uuid('prd_id').notNull().references(() => prds.id, { onDelete: 'cascade' }),
  chatThreadId: uuid('chat_thread_id').references(() => chatThreads.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('generating'),
  testCasesJson: jsonb('test_cases_json'),
  testCasesMd: text('test_cases_md'),
  coverageSummary: jsonb('coverage_summary').$type<TestCaseCoverageSummary>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  prdIdx: index('test_cases_prd_id_idx').on(t.prdId),
}));

export const designDocs = pgTable('design_docs', {
  id: uuid('id').primaryKey().defaultRandom(),
  prdId: uuid('prd_id').notNull().references(() => prds.id, { onDelete: 'cascade' }),
  project: text('project').notNull(),
  chatThreadId: uuid('chat_thread_id'),
  designPrototypeId: uuid('design_prototype_id').references(() => designPrototypes.id, { onDelete: 'set null' }),
  featureIndex: integer('feature_index'),
  docAssistantThreadId: uuid('doc_assistant_thread_id'),
  validationThreadId: uuid('validation_thread_id'),
  validationScore: integer('validation_score'),
  validationScorecard: jsonb('validation_scorecard').$type<ValidationScorecard>(),
  validationReportMd: text('validation_report_md'),
  validationPhase: text('validation_phase'),
  fixBaseline: jsonb('fix_baseline').$type<ContentSnapshot>(),
  validationOverride: jsonb('validation_override').$type<DesignDocValidationOverride>(),
  authorId: text('author_id').notNull(),
  title: text('title').notNull().default('Untitled Design Doc'),
  model: text('model'),
  effort: text('effort').$type<EffortLevel>(),
  designContent: text('design_content').notNull().default(''),
  techSpecContent: text('tech_spec_content').notNull().default(''),
  assumptionsContent: text('assumptions_content').notNull().default(''),
  proposedDesignContent: text('proposed_design_content'),
  proposedTechSpecContent: text('proposed_tech_spec_content'),
  proposedAssumptionsContent: text('proposed_assumptions_content'),
  fixCommentId: uuid('fix_comment_id'),
  skillSettingsId: uuid('skill_settings_id'),
  generationError: text('generation_error'),
  status: text('status').notNull().default('draft'),
  reviewerId: text('reviewer_id'),
  reviewComment: text('review_comment'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  directFeatureUq: uniqueIndex('uq_design_docs_prd_direct_feature')
    .on(t.prdId, t.featureIndex)
    .where(sql`${t.designPrototypeId} IS NULL AND ${t.featureIndex} IS NOT NULL`),
  transientUpdatedIdx: index('idx_design_docs_transient_updated')
    .on(t.status, t.updatedAt, t.id)
    .where(sql`${t.status} IN ('generating', 'validating')`),
}));

// ── Interview Relations ────────────────────────────────────────────────────────

export const interviewsRelations = relations(interviews, ({ one, many }) => ({
  chatThread: one(chatThreads, {
    fields: [interviews.chatThreadId],
    references: [chatThreads.id],
  }),
  prdOwner: one(appUsers, {
    fields: [interviews.prdOwnerId],
    references: [appUsers.oid],
    relationName: 'interviewPrdOwner',
  }),
  designDocOwner: one(appUsers, {
    fields: [interviews.designDocOwnerId],
    references: [appUsers.oid],
    relationName: 'interviewDesignDocOwner',
  }),
  designPrototypeOwner: one(appUsers, {
    fields: [interviews.designPrototypeOwnerId],
    references: [appUsers.oid],
    relationName: 'interviewDesignPrototypeOwner',
  }),
  testCaseOwner: one(appUsers, {
    fields: [interviews.testCaseOwnerId],
    references: [appUsers.oid],
    relationName: 'interviewTestCaseOwner',
  }),
  discoveryAssignee: one(appUsers, {
    fields: [interviews.discoveryAssigneeId],
    references: [appUsers.oid],
    relationName: 'interviewDiscoveryAssignee',
  }),
  deliveryAssignee: one(appUsers, {
    fields: [interviews.deliveryAssigneeId],
    references: [appUsers.oid],
    relationName: 'interviewDeliveryAssignee',
  }),
  technicalAssignee: one(appUsers, {
    fields: [interviews.technicalAssigneeId],
    references: [appUsers.oid],
    relationName: 'interviewTechnicalAssignee',
  }),
  prds: many(prds),
  adrLinks: many(interviewAdrLinks),
  designModuleLinks: many(interviewDesignModuleLinks),
  playbookRun: one(playbookRuns, {
    fields: [interviews.playbookRunId],
    references: [playbookRuns.id],
  }),
  playbookStepRun: one(playbookStepRuns, {
    fields: [interviews.playbookStepRunId],
    references: [playbookStepRuns.id],
  }),
  brief: one(interviewBriefs, {
    fields: [interviews.id],
    references: [interviewBriefs.interviewId],
  }),
  briefRevisions: many(interviewBriefRevisions),
  specialistReviews: many(interviewSpecialistReviews),
}));

export const interviewAdrLinksRelations = relations(interviewAdrLinks, ({ one }) => ({
  interview: one(interviews, {
    fields: [interviewAdrLinks.interviewId],
    references: [interviews.id],
  }),
  adr: one(adrs, {
    fields: [interviewAdrLinks.adrId],
    references: [adrs.id],
  }),
}));

export const interviewDesignModuleLinksRelations = relations(interviewDesignModuleLinks, ({ one }) => ({
  interview: one(interviews, {
    fields: [interviewDesignModuleLinks.interviewId],
    references: [interviews.id],
  }),
  designModule: one(designModules, {
    fields: [interviewDesignModuleLinks.designModuleId],
    references: [designModules.id],
  }),
}));

export const interviewBriefsRelations = relations(interviewBriefs, ({ one, many }) => ({
  interview: one(interviews, {
    fields: [interviewBriefs.interviewId],
    references: [interviews.id],
  }),
  revisions: many(interviewBriefRevisions),
}));

export const interviewBriefRevisionsRelations = relations(interviewBriefRevisions, ({ one }) => ({
  brief: one(interviewBriefs, {
    fields: [interviewBriefRevisions.briefId],
    references: [interviewBriefs.id],
  }),
  interview: one(interviews, {
    fields: [interviewBriefRevisions.interviewId],
    references: [interviews.id],
  }),
}));

export const interviewSpecialistReviewsRelations = relations(interviewSpecialistReviews, ({ one }) => ({
  interview: one(interviews, {
    fields: [interviewSpecialistReviews.interviewId],
    references: [interviews.id],
  }),
}));

export const adrsRelations = relations(adrs, ({ one, many }) => ({
  chatThread: one(chatThreads, {
    fields: [adrs.chatThreadId],
    references: [chatThreads.id],
  }),
  assistantThread: one(chatThreads, {
    relationName: 'adrAssistantThread',
    fields: [adrs.adrAssistantThreadId],
    references: [chatThreads.id],
  }),
  author: one(appUsers, {
    fields: [adrs.authorId],
    references: [appUsers.oid],
  }),
  skillSettings: one(projectSkillSettings, {
    fields: [adrs.skillSettingsId],
    references: [projectSkillSettings.id],
  }),
  featureRequestLinks: many(featureRequestAdrs),
  interviewLinks: many(interviewAdrLinks),
}));

export const prdsRelations = relations(prds, ({ one, many }) => ({
  interview: one(interviews, {
    fields: [prds.interviewId],
    references: [interviews.id],
  }),
  chatThread: one(chatThreads, {
    fields: [prds.chatThreadId],
    references: [chatThreads.id],
  }),
  testCases: many(testCases),
  designDocs: many(designDocs),
  designPrototypes: many(designPrototypes),
}));

export const testCasesRelations = relations(testCases, ({ one }) => ({
  prd: one(prds, {
    fields: [testCases.prdId],
    references: [prds.id],
  }),
  chatThread: one(chatThreads, {
    fields: [testCases.chatThreadId],
    references: [chatThreads.id],
  }),
}));

export const designDocsRelations = relations(designDocs, ({ one }) => ({
  prd: one(prds, {
    fields: [designDocs.prdId],
    references: [prds.id],
  }),
  chatThread: one(chatThreads, {
    relationName: 'designDocChatThread',
    fields: [designDocs.chatThreadId],
    references: [chatThreads.id],
  }),
  docAssistantThread: one(chatThreads, {
    relationName: 'designDocAssistantThread',
    fields: [designDocs.docAssistantThreadId],
    references: [chatThreads.id],
  }),
  designPrototype: one(designPrototypes, {
    fields: [designDocs.designPrototypeId],
    references: [designPrototypes.id],
  }),
}));

// ── Project Skill Settings ────────────────────────────────────────────────────

export const projectSkillSettings = pgTable('project_skill_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').notNull(),
  skillRepo: text('skill_repo').notNull(),
  skillBranch: text('skill_branch').notNull(),
  friendlyName: text('friendly_name').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  updatedBy: text('updated_by'),
  defaultModel: text('default_model'),
  defaultEffort: text('default_effort').$type<EffortLevel>(),
  skillProvider: text('skill_provider').notNull().default('ado'),
  interviewSkillOptions: jsonb('interview_skill_options').$type<InterviewSkillOption[]>(),
  prototypeStageEnabled: boolean('prototype_stage_enabled').notNull().default(true),
  interviewWebResearchEnabled: boolean('interview_web_research_enabled').notNull().default(false),
  interviewWebMcp: jsonb('interview_web_mcp').$type<QuickMcpPill>(),
  prototypeEngine: text('prototype_engine').$type<PrototypeEngine>().notNull().default('bedrock'),
  prototypeDesignSystemPath: text('prototype_design_system_path'),
  screenInventoryPath: text('screen_inventory_path'),
  prototypeWebReferencesEnabled: boolean('prototype_web_references_enabled').notNull().default(false),
  quickSkillPills: jsonb('quick_skill_pills').$type<QuickSkillPill[]>(),
  quickMcpPills: jsonb('quick_mcp_pills').$type<QuickMcpPill[]>(),
  approvalMode: text('approval_mode').$type<ApprovalMode>().notNull().default('any_one'),
  cursorApiKeyEnvRef: text('cursor_api_key_env_ref'),
  cursorServiceAccountId: text('cursor_service_account_id'),
  /** Admin-managed checkout readiness for this skill-settings repository identity. */
  repositoryCheckoutStatus: text('repository_checkout_status').notNull().default('not_cloned'),
  repositoryCheckoutSha: text('repository_checkout_sha'),
  repositoryCheckoutError: text('repository_checkout_error'),
  repositoryCheckoutStartedAt: timestamp('repository_checkout_started_at', {
    withTimezone: true,
    mode: 'string',
  }),
  repositoryCheckoutCompletedAt: timestamp('repository_checkout_completed_at', {
    withTimezone: true,
    mode: 'string',
  }),
  /** Null means no Build profile yet. Saved through its own route, never by upsertSkillConfig. */
  buildProfile: jsonb('build_profile').$type<BuildProfile>(),
  buildProfileUpdatedAt: timestamp('build_profile_updated_at', { withTimezone: true, mode: 'string' }),
  buildProfileUpdatedBy: text('build_profile_updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (t) => ({
  buildProfileObjectCheck: check(
    'project_skill_settings_build_profile_object_check',
    sql`${t.buildProfile} IS NULL OR jsonb_typeof(${t.buildProfile}) = 'object'`,
  ),
  // Exactly one default repo config per project.
  oneDefaultPerProject: uniqueIndex('project_skill_settings_one_default_per_project')
    .on(t.project)
    .where(sql`is_default`),
  projectFriendlyName: unique('project_skill_settings_project_friendly_name_key').on(t.project, t.friendlyName),
}));

/**
 * One row per (settings row, workflow). Keys come from PROJECT_SKILL_WORKFLOWS in
 * src/shared/constants/projectSkillWorkflows.ts. A new workflow is a new key here,
 * not a new column on project_skill_settings.
 */
export const projectSkillWorkflowSettings = pgTable('project_skill_workflow_settings', {
  settingsId: uuid('settings_id').notNull().references(() => projectSkillSettings.id, { onDelete: 'cascade' }),
  workflow: text('workflow').notNull(),
  skillPath: text('skill_path'),
  model: text('model'),
  effort: text('effort').$type<EffortLevel>(),
  bedrockModelId: text('bedrock_model_id'),
  bedrockMaxTokens: integer('bedrock_max_tokens'),
  bedrockTimeoutMs: integer('bedrock_timeout_ms'),
  bedrockTemperature: real('bedrock_temperature'),
  regenBedrockModelId: text('regen_bedrock_model_id'),
  regenBedrockMaxTokens: integer('regen_bedrock_max_tokens'),
  scoreThreshold: integer('score_threshold'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.settingsId, t.workflow] }),
}));

export const projectSkillSettingsRelations = relations(projectSkillSettings, ({ many }) => ({
  workflowSettings: many(projectSkillWorkflowSettings),
}));

export const projectSkillWorkflowSettingsRelations = relations(projectSkillWorkflowSettings, ({ one }) => ({
  settings: one(projectSkillSettings, {
    fields: [projectSkillWorkflowSettings.settingsId],
    references: [projectSkillSettings.id],
  }),
}));

export const projectApprovers = pgTable('project_approvers', {
  id: uuid('id').primaryKey().defaultRandom(),
  settingsId: uuid('settings_id').notNull().references(() => projectSkillSettings.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  documentType: text('document_type').notNull(),
  assignedBy: text('assigned_by'),
  assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  uniq: unique().on(t.settingsId, t.userId, t.documentType),
}));

export const projectApproversRelations = relations(projectApprovers, ({ one }) => ({
  projectSkillSetting: one(projectSkillSettings, {
    fields: [projectApprovers.settingsId],
    references: [projectSkillSettings.id],
  }),
  user: one(appUsers, {
    fields: [projectApprovers.userId],
    references: [appUsers.oid],
  }),
}));

// Live group references in a project's approver pool, expanded to members at read time.
export const projectApproverGroups = pgTable('project_approver_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  settingsId: uuid('settings_id').notNull().references(() => projectSkillSettings.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id').notNull().references(() => appGroups.id, { onDelete: 'cascade' }),
  documentType: text('document_type').notNull(),
  assignedBy: text('assigned_by'),
  assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  uniq: unique().on(t.settingsId, t.groupId, t.documentType),
}));

export const projectApproverGroupsRelations = relations(projectApproverGroups, ({ one }) => ({
  projectSkillSetting: one(projectSkillSettings, {
    fields: [projectApproverGroups.settingsId],
    references: [projectSkillSettings.id],
  }),
  group: one(appGroups, {
    fields: [projectApproverGroups.groupId],
    references: [appGroups.id],
  }),
}));

// Approval mode per reviewable module. The project-wide
// project_skill_settings.approval_mode column is retained for the in-flight
// completion read path and for older app builds.
export const projectApprovalModes = pgTable('project_approval_modes', {
  id: uuid('id').primaryKey().defaultRandom(),
  settingsId: uuid('settings_id').notNull().references(() => projectSkillSettings.id, { onDelete: 'cascade' }),
  documentType: text('document_type').notNull(),
  mode: text('mode').$type<ApprovalMode>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  uniq: unique().on(t.settingsId, t.documentType),
}));

export const projectApprovalModesRelations = relations(projectApprovalModes, ({ one }) => ({
  projectSkillSetting: one(projectSkillSettings, {
    fields: [projectApprovalModes.settingsId],
    references: [projectSkillSettings.id],
  }),
}));

// ── Document Approver Assignments ─────────────────────────────────────────────

export const documentApproverAssignments = pgTable('document_approver_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull(),
  documentType: text('document_type').notNull(),
  approverUserId: text('approver_user_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  status: text('status').notNull().default('pending'),
  comment: text('comment'),
  respondedAt: timestamp('responded_at', { withTimezone: true, mode: 'string' }),
  assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  assignedBy: text('assigned_by').notNull(),
}, (t) => ({
  uniq: unique().on(t.documentId, t.documentType, t.approverUserId),
}));

export const documentApproverAssignmentsRelations = relations(documentApproverAssignments, ({ one }) => ({
  approver: one(appUsers, {
    fields: [documentApproverAssignments.approverUserId],
    references: [appUsers.oid],
  }),
}));

// ── Notification Tables ───────────────────────────────────────────────────────

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  link: text('link'),
  read: boolean('read').notNull().default(false),
  /** Optional producer idempotency key (unique when present). FEAT-007. */
  dedupeKey: text('dedupe_key'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  dedupeKeyUq: uniqueIndex('uq_notifications_dedupe_key').on(t.dedupeKey),
}));

export const notificationPreferences = pgTable('notification_preferences', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  notificationType: text('notification_type').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  toastEnabled: boolean('toast_enabled').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  uniq: unique().on(t.userId, t.notificationType),
}));

// ── Notification Relations ────────────────────────────────────────────────────

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(appUsers, {
    fields: [notifications.userId],
    references: [appUsers.oid],
  }),
}));

export const notificationPreferencesRelations = relations(notificationPreferences, ({ one }) => ({
  user: one(appUsers, {
    fields: [notificationPreferences.userId],
    references: [appUsers.oid],
  }),
}));

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

// ── Design Module Architecture Explorer ──────────────────────────────────────

export const designModules = pgTable('design_modules', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').notNull().default('Apex'),
  slug: text('slug').notNull(),
  label: text('label').notNull(),
  description: text('description'),
  iconKey: text('icon_key').$type<DesignModuleIconKey>().notNull().default('default'),
  sourceGlobs: jsonb('source_globs').$type<string[]>().notNull().default([]),
  content: text('content'),
  sourceFingerprint: text('source_fingerprint'),
  sourceCommit: text('source_commit'),
  lastGeneratedAt: timestamp('last_generated_at', { withTimezone: true, mode: 'string' }),
  generatedByModel: text('generated_by_model'),
  scopingThreadId: text('scoping_thread_id'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdBy: text('created_by'),
  updatedBy: text('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  projectSlugUnique: uniqueIndex('design_modules_project_slug_key').on(t.project, t.slug),
  projectIdx: index('idx_design_modules_project').on(t.project),
  sortOrderIdx: index('idx_design_modules_sort_order').on(t.sortOrder, t.label),
}));

export const designModulesRelations = relations(designModules, ({ many }) => ({
  interviewLinks: many(interviewDesignModuleLinks),
}));

export const teamsConversationReferences = pgTable('teams_conversation_references', {
  userOid: text('user_oid').primaryKey().references(() => appUsers.oid, { onDelete: 'cascade' }),
  conversationReference: jsonb('conversation_reference').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const teamsConversationReferencesRelations = relations(teamsConversationReferences, ({ one }) => ({
  user: one(appUsers, {
    fields: [teamsConversationReferences.userOid],
    references: [appUsers.oid],
  }),
}));

// ── Review Comments (Inline Annotations) ──────────────────────────────────────

export const reviewComments = pgTable('review_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull(),
  documentType: text('document_type').notNull(),
  sectionKey: text('section_key').notNull(),
  authorUserId: text('author_user_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  selectorExact: text('selector_exact').notNull(),
  selectorPrefix: text('selector_prefix').notNull().default(''),
  selectorSuffix: text('selector_suffix').notNull().default(''),
  selectorStart: integer('selector_start').notNull(),
  selectorEnd: integer('selector_end').notNull(),
  status: text('status').notNull().default('open'),
  resolvedBy: text('resolved_by'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  uniq: unique().on(t.documentId, t.documentType, t.sectionKey, t.selectorExact, t.selectorStart, t.authorUserId),
}));

export const reviewReplies = pgTable('review_replies', {
  id: uuid('id').primaryKey().defaultRandom(),
  commentId: uuid('comment_id').notNull().references(() => reviewComments.id, { onDelete: 'cascade' }),
  authorUserId: text('author_user_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

// ── Review Comments Relations ─────────────────────────────────────────────────

export const reviewCommentsRelations = relations(reviewComments, ({ one, many }) => ({
  author: one(appUsers, {
    fields: [reviewComments.authorUserId],
    references: [appUsers.oid],
  }),
  replies: many(reviewReplies),
}));

export const reviewRepliesRelations = relations(reviewReplies, ({ one }) => ({
  comment: one(reviewComments, {
    fields: [reviewReplies.commentId],
    references: [reviewComments.id],
  }),
  author: one(appUsers, {
    fields: [reviewReplies.authorUserId],
    references: [appUsers.oid],
  }),
}));

// ── Deployment Outcomes ───────────────────────────────────────────────────────

export const deploymentOutcomes = pgTable('deployment_outcomes', {
  id: uuid('id').primaryKey().defaultRandom(),
  deploymentId: text('deployment_id').notNull(),
  releaseVersion: text('release_version').notNull(),
  environment: text('environment').notNull().default('production'),
  result: text('result').notNull(),
  downtimeMinutes: integer('downtime_minutes'),
  details: text('details'),
  reportedBy: text('reported_by').notNull(),
  reportedAt: timestamp('reported_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  deployedAt: timestamp('deployed_at', { withTimezone: true, mode: 'string' }),
});

// ── Release Epic Orders ───────────────────────────────────────────────────────

export const releaseEpicOrders = pgTable(
  'release_epic_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    project: text('project').notNull(),
    areaPath: text('area_path').notNull(),
    adoEpicId: integer('ado_epic_id').notNull(),
    sortRank: integer('sort_rank').notNull(),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_release_epic_orders_scope_epic').on(t.project, t.areaPath, t.adoEpicId),
    index('idx_release_epic_orders_scope').on(t.project, t.areaPath, t.sortRank),
  ],
);

// ── Project Menu Settings ─────────────────────────────────────────────────────

export const projectMenuSettings = pgTable('project_menu_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').unique().notNull(),
  enabledViews: jsonb('enabled_views').$type<MenuItemKey[]>().notNull().default([]),
  updatedBy: text('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

// ── Design Prototype Tables ───────────────────────────────────────────────────

export const designPrototypes = pgTable('design_prototypes', {
  id: uuid('id').primaryKey().defaultRandom(),
  prdId: uuid('prd_id').notNull().references(() => prds.id, { onDelete: 'cascade' }),
  featureName: text('feature_name').notNull(),
  featureIndex: integer('feature_index').notNull(),
  authorId: text('author_id').notNull(),
  model: text('model'),
  effort: text('effort').$type<EffortLevel>(),
  status: text('status').notNull().default('generating'),
  mockHtml: text('mock_html'),
  mockVersion: integer('mock_version').notNull().default(1),
  history: jsonb('history').$type<DesignPrototypeHistoryEntry[]>().notNull().default([]),
  reviewerId: text('reviewer_id'),
  reviewComment: text('review_comment'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'string' }),
  generationError: text('generation_error'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const designPrototypeComments = pgTable('design_prototype_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  prototypeId: uuid('prototype_id').notNull().references(() => designPrototypes.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull(),
  text: text('text').notNull(),
  pinX: real('pin_x'),
  pinY: real('pin_y'),
  mockVersion: integer('mock_version').notNull(),
  resolved: boolean('resolved').notNull().default(false),
  resolvedBy: text('resolved_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

// ── Design Prototype Relations ────────────────────────────────────────────────

export const designPrototypesRelations = relations(designPrototypes, ({ one, many }) => ({
  prd: one(prds, {
    fields: [designPrototypes.prdId],
    references: [prds.id],
  }),
  comments: many(designPrototypeComments),
  designDocs: many(designDocs),
}));

export const designPrototypeCommentsRelations = relations(designPrototypeComments, ({ one }) => ({
  prototype: one(designPrototypes, {
    fields: [designPrototypeComments.prototypeId],
    references: [designPrototypes.id],
  }),
}));

// ── Design Plan Table ─────────────────────────────────────────────────────────

export const designPlans = pgTable('design_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  prdId: uuid('prd_id').notNull().unique().references(() => prds.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('generating'),
  version: integer('version').notNull().default(1),
  features: jsonb('features').$type<DesignPlanFeature[]>().notNull().default([]),
  backlogHash: text('backlog_hash'),
  history: jsonb('history').$type<DesignPlanHistoryEntry[]>().notNull().default([]),
  generationError: text('generation_error'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const designPlansRelations = relations(designPlans, ({ one }) => ({
  prd: one(prds, {
    fields: [designPlans.prdId],
    references: [prds.id],
  }),
}));

// ── Page Screenshots ──────────────────────────────────────────────────────────

export const pageScreenshots = pgTable('page_screenshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  route: text('route').notNull().unique(),
  displayUrl: text('display_url'),
  imageBase64: text('image_base64').notNull(),
  mediaType: text('media_type').notNull().default('image/png'),
  width: integer('width'),
  height: integer('height'),
  uploadedBy: text('uploaded_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

// ── Document Owner Approvals ──────────────────────────────────────────────────

export const documentOwnerApprovals = pgTable('document_owner_approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull(),
  documentType: text('document_type').notNull(),
  ownerUserId: text('owner_user_id').references(() => appUsers.oid, { onDelete: 'set null' }),
  status: text('status').$type<OwnerApprovalStatus>().notNull().default('pending'),
  comment: text('comment'),
  respondedAt: timestamp('responded_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  uniq: unique().on(t.documentId, t.documentType),
}));

export const documentOwnerApprovalsRelations = relations(documentOwnerApprovals, ({ one }) => ({
  owner: one(appUsers, {
    fields: [documentOwnerApprovals.ownerUserId],
    references: [appUsers.oid],
  }),
}));

// ── ESLint burn-down snapshots (persisted from nightly pipeline artifacts) ────

export const eslintBurnDownSnapshots = pgTable('eslint_burn_down_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  pipelineBuildId: integer('pipeline_build_id').notNull().unique(),
  buildNumber: text('build_number').notNull(),
  definitionName: text('definition_name').notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'string' }).notNull(),
  totalFiles: integer('total_files').notNull().default(0),
  filesWithProblems: integer('files_with_problems').notNull().default(0),
  totalErrors: integer('total_errors').notNull().default(0),
  totalWarnings: integer('total_warnings').notNull().default(0),
  issueCount: integer('issue_count').notNull().default(0),
  fixableCount: integer('fixable_count').notNull().default(0),
  syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  capturedAtIdx: index('idx_eslint_burn_down_snapshots_captured_at').on(t.capturedAt),
}));

// ── Standup Ceremony Tables ───────────────────────────────────────────────────

export const standupConfigs = pgTable('standup_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** @deprecated use groupIds instead — kept nullable for FK integrity of migrated data */
  groupId: uuid('group_id').references(() => appGroups.id, { onDelete: 'set null' }),
  groupIds: jsonb('group_ids').$type<string[]>().notNull().default([]),
  project: text('project').notNull(),
  areaPath: text('area_path'),
  iterationMode: text('iteration_mode').notNull().default('current'),
  iterationPath: text('iteration_path'),
  scheduleTime: text('schedule_time').notNull().default('09:00'),
  timezone: text('timezone').notNull().default('America/New_York'),
  weekdays: jsonb('weekdays').$type<number[]>().notNull().default([1, 2, 3, 4, 5]),
  skillSettingsId: uuid('skill_settings_id').references(() => projectSkillSettings.id, { onDelete: 'set null' }),
  reminderDelayMin: integer('reminder_delay_min').notNull().default(30),
  reminderIntervalMin: integer('reminder_interval_min').notNull().default(60),
  facilitatorDeadlineMin: integer('facilitator_deadline_min').notNull().default(120),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const standupSessions = pgTable('standup_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  configId: uuid('config_id').notNull().references(() => standupConfigs.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id').references(() => appGroups.id, { onDelete: 'set null' }),
  sessionDate: text('session_date').notNull(),
  status: text('status').notNull().default('open'),
  facilitatorThreadId: uuid('facilitator_thread_id').references(() => chatThreads.id, { onDelete: 'set null' }),
  summaryMarkdown: text('summary_markdown'),
  lastRemindedAt: timestamp('last_reminded_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
}, (t) => ({
  configDateUniq: uniqueIndex('idx_standup_sessions_config_date').on(t.configId, t.sessionDate),
}));

export const standupParticipants = pgTable('standup_participants', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => standupSessions.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  threadId: uuid('thread_id').references(() => chatThreads.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('pending'),
  structuredUpdate: jsonb('structured_update').$type<{ yesterday?: string; today?: string; blockers?: string; atRisk?: string; handoffs?: string; capacity?: string }>(),
  adoAccessToken: text('ado_access_token'),
  adoTokenExpiresAt: timestamp('ado_token_expires_at', { withTimezone: true, mode: 'string' }),
  submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'string' }),
});

export const standupFollowups = pgTable('standup_followups', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => standupSessions.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  participantUserIds: jsonb('participant_user_ids').$type<string[]>().notNull().default([]),
  relatedWorkItemIds: jsonb('related_work_item_ids').$type<number[]>().notNull().default([]),
  status: text('status').notNull().default('open'),
  followupThreadId: uuid('followup_thread_id').references(() => chatThreads.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

// ── Standup Relations ─────────────────────────────────────────────────────────

export const standupConfigsRelations = relations(standupConfigs, ({ one, many }) => ({
  group: one(appGroups, { fields: [standupConfigs.groupId], references: [appGroups.id] }),
  skillSettings: one(projectSkillSettings, { fields: [standupConfigs.skillSettingsId], references: [projectSkillSettings.id] }),
  sessions: many(standupSessions),
}));

export const standupSessionsRelations = relations(standupSessions, ({ one, many }) => ({
  config: one(standupConfigs, { fields: [standupSessions.configId], references: [standupConfigs.id] }),
  group: one(appGroups, { fields: [standupSessions.groupId], references: [appGroups.id] }),
  facilitatorThread: one(chatThreads, { fields: [standupSessions.facilitatorThreadId], references: [chatThreads.id] }),
  participants: many(standupParticipants),
  followups: many(standupFollowups),
}));

export const standupParticipantsRelations = relations(standupParticipants, ({ one }) => ({
  session: one(standupSessions, { fields: [standupParticipants.sessionId], references: [standupSessions.id] }),
  user: one(appUsers, { fields: [standupParticipants.userId], references: [appUsers.oid] }),
  thread: one(chatThreads, { fields: [standupParticipants.threadId], references: [chatThreads.id] }),
}));

export const standupFollowupsRelations = relations(standupFollowups, ({ one }) => ({
  session: one(standupSessions, { fields: [standupFollowups.sessionId], references: [standupSessions.id] }),
  followupThread: one(chatThreads, { fields: [standupFollowups.followupThreadId], references: [chatThreads.id] }),
}));

// ── Feature Flags Tables ──────────────────────────────────────────────────────

export const featureFlags = pgTable('feature_flags', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').unique().notNull(),
  description: text('description'),
  enabled: boolean('enabled').notNull().default(false),
  lifecycle: text('lifecycle').$type<FlagLifecycle>().notNull().default('active'),
  cleanupReady: boolean('cleanup_ready').notNull().default(false),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const featureFlagRules = pgTable('feature_flag_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  flagId: uuid('flag_id').notNull().references(() => featureFlags.id, { onDelete: 'cascade' }),
  type: text('type').$type<FlagRuleType>().notNull(),
  value: text('value'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  flagIdx: index('idx_feature_flag_rules_flag_id').on(t.flagId),
}));

export const featureFlagAudit = pgTable('feature_flag_audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  flagId: uuid('flag_id').references(() => featureFlags.id, { onDelete: 'set null' }),
  flagKey: text('flag_key').notNull(),
  action: text('action').$type<FlagAuditAction>().notNull(),
  actorId: text('actor_id'),
  actorEmail: text('actor_email'),
  details: jsonb('details'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  flagCreatedAtIdx: index('idx_feature_flag_audit_flag_created').on(t.flagId, t.createdAt),
}));

// ── Feature Flags Relations ───────────────────────────────────────────────────

export const featureFlagsRelations = relations(featureFlags, ({ many }) => ({
  rules: many(featureFlagRules),
  auditLog: many(featureFlagAudit),
}));

export const featureFlagRulesRelations = relations(featureFlagRules, ({ one }) => ({
  flag: one(featureFlags, {
    fields: [featureFlagRules.flagId],
    references: [featureFlags.id],
  }),
}));

export const featureFlagAuditRelations = relations(featureFlagAudit, ({ one }) => ({
  flag: one(featureFlags, {
    fields: [featureFlagAudit.flagId],
    references: [featureFlags.id],
  }),
}));

// ── UI Lab Tables ─────────────────────────────────────────────────────────────

export const uiLabDesigns = pgTable('ui_lab_designs', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').notNull(),
  authorId: text('author_id').notNull(),
  title: text('title').notNull(),
  prompt: text('prompt').notNull(),
  targetRoute: text('target_route'),
  model: text('model'),
  status: text('status').notNull().default('generating'),
  html: text('html'),
  version: integer('version').notNull().default(1),
  history: jsonb('history').$type<UiLabHistoryEntry[]>().notNull().default([]),
  generationError: text('generation_error'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const uiLabComments = pgTable('ui_lab_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  designId: uuid('design_id').notNull().references(() => uiLabDesigns.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull(),
  text: text('text').notNull(),
  pinX: real('pin_x'),
  pinY: real('pin_y'),
  version: integer('version').notNull(),
  resolved: boolean('resolved').notNull().default(false),
  resolvedBy: text('resolved_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const uiLabDesignShares = pgTable('ui_lab_design_shares', {
  id: uuid('id').primaryKey().defaultRandom(),
  designId: uuid('design_id').notNull().references(() => uiLabDesigns.id, { onDelete: 'cascade' }),
  granteeId: text('grantee_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  createdBy: text('created_by').notNull().references(() => appUsers.oid, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  designGranteeUq: unique('ui_lab_design_shares_design_id_grantee_id_key').on(
    t.designId,
    t.granteeId,
  ),
  granteeIdx: index('idx_ui_lab_design_shares_grantee').on(t.granteeId, t.designId),
  designIdx: index('idx_ui_lab_design_shares_design').on(t.designId, t.createdAt),
}));

export const uiLabDesignsRelations = relations(uiLabDesigns, ({ many }) => ({
  comments: many(uiLabComments),
  shares: many(uiLabDesignShares),
}));

export const uiLabCommentsRelations = relations(uiLabComments, ({ one }) => ({
  design: one(uiLabDesigns, {
    fields: [uiLabComments.designId],
    references: [uiLabDesigns.id],
  }),
}));

export const uiLabDesignSharesRelations = relations(uiLabDesignShares, ({ one }) => ({
  design: one(uiLabDesigns, {
    fields: [uiLabDesignShares.designId],
    references: [uiLabDesigns.id],
  }),
  grantee: one(appUsers, {
    fields: [uiLabDesignShares.granteeId],
    references: [appUsers.oid],
  }),
  creator: one(appUsers, {
    fields: [uiLabDesignShares.createdBy],
    references: [appUsers.oid],
  }),
}));

// ── Feature Requests ──────────────────────────────────────────────────────────

export const featureRequests = pgTable('feature_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').$type<WorkItemType>().notNull().default('feature'),
  title: text('title').notNull(),
  request: text('request').notNull(),
  advantage: text('advantage'),
  interviewId: uuid('interview_id').references(() => interviews.id, { onDelete: 'set null' }),
  submittedBy: text('submitted_by').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  sourceProject: text('source_project').notNull(),
  assignedToOid: text('assigned_to_oid').references(() => appUsers.oid, { onDelete: 'set null' }),
  assignedToApex: boolean('assigned_to_apex').notNull().default(false),
  status: text('status').notNull().default('new'),
  aiStatus: text('ai_status').notNull().default('pending'),
  aiPriority: text('ai_priority'),
  aiRisk: text('ai_risk'),
  aiRationale: text('ai_rationale'),
  aiThreadId: text('ai_thread_id'),
  teamPriority: text('team_priority'),
  teamRisk: text('team_risk'),
  rank: integer('rank'),
  reviewedBy: text('reviewed_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  statusCreatedIdx: index('idx_feature_requests_status_created').on(t.status, t.createdAt),
  typeStatusCreatedIdx: index('idx_feature_requests_type_status_created').on(t.type, t.status, t.createdAt),
  submittedByIdx: index('idx_feature_requests_submitted_by').on(t.submittedBy),
  sourceProjectIdx: index('idx_feature_requests_source_project').on(t.sourceProject),
  assignedToOidIdx: index('idx_feature_requests_assigned_to_oid')
    .on(t.assignedToOid)
    .where(sql`${t.assignedToOid} IS NOT NULL`),
  exclusiveAssigneeCheck: check(
    'feature_requests_exclusive_assignee_check',
    sql`(${t.assignedToOid} IS NOT NULL)::integer + (${t.assignedToApex} = TRUE)::integer <= 1`,
  ),
}));

export const featureRequestAdrs = pgTable('feature_request_adrs', {
  featureRequestId: uuid('feature_request_id').notNull()
    .references(() => featureRequests.id, { onDelete: 'cascade' }),
  adrId: uuid('adr_id').notNull()
    .references(() => adrs.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.featureRequestId, t.adrId] }),
  adrIdx: index('idx_feature_request_adrs_adr_id').on(t.adrId),
}));

export const featureRequestsRelations = relations(featureRequests, ({ one, many }) => ({
  interview: one(interviews, {
    fields: [featureRequests.interviewId],
    references: [interviews.id],
  }),
  submitter: one(appUsers, {
    fields: [featureRequests.submittedBy],
    references: [appUsers.oid],
  }),
  assignee: one(appUsers, {
    fields: [featureRequests.assignedToOid],
    references: [appUsers.oid],
  }),
  adrLinks: many(featureRequestAdrs),
}));

export const featureRequestAdrsRelations = relations(featureRequestAdrs, ({ one }) => ({
  featureRequest: one(featureRequests, {
    fields: [featureRequestAdrs.featureRequestId],
    references: [featureRequests.id],
  }),
  adr: one(adrs, {
    fields: [featureRequestAdrs.adrId],
    references: [adrs.id],
  }),
}));

// ── PDF Sessions ──────────────────────────────────────────────────────────────

export const pdfSessions = pgTable('pdf_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  projectId: text('project_id'),
  status: text('status').$type<PdfSessionStatus>().notNull().default('active'),
  pageManifest: jsonb('page_manifest').$type<PageManifestEntry[]>().notNull().default([]),
  textOverlays: jsonb('text_overlays').$type<OverlayTextBox[]>().notNull().default([]),
  fileMetadata: jsonb('file_metadata').$type<PdfFileMetadata[]>().notNull().default([]),
  exportFilename: text('export_filename'),
  formFieldValues: jsonb('form_field_values').$type<PdfTextFormValue[]>().notNull().default([]),
  signatureState: jsonb('signature_state').$type<PdfSignatureState>().notNull().default({ assets: [], overlays: [] }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now() + interval '4 hours'`),
}, (t) => ({
  userIdIdx: index('idx_pdf_sessions_user_id').on(t.userId),
  expiresAtIdx: index('idx_pdf_sessions_expires_at').on(t.expiresAt).where(sql`status = 'active'`),
}));

export const pdfSessionsRelations = relations(pdfSessions, ({ one }) => ({
  user: one(appUsers, {
    fields: [pdfSessions.userId],
    references: [appUsers.oid],
  }),
}));

export const pdfConversionJobs = pgTable('pdf_conversion_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => pdfSessions.id, { onDelete: 'cascade' }),
  jobType: text('job_type').$type<PdfJobType>().notNull().default('docx_convert'),
  userId: text('user_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  originalName: text('original_name').notNull(),
  originalMimeType: text('original_mime_type').notNull(),
  inputKey: text('input_key').notNull(),
  status: text('status').$type<PdfConversionStatus>().notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  result: jsonb('result').$type<Record<string, unknown>>(),
  fileId: uuid('file_id'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  ownerInstance: text('owner_instance'),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true, mode: 'string' }),
  lockExpiresAt: timestamp('lock_expires_at', { withTimezone: true, mode: 'string' }),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  sessionCreatedIdx: index('idx_pdf_conversion_jobs_session_created').on(t.sessionId, t.createdAt),
  statusCreatedIdx: index('idx_pdf_conversion_jobs_status_created').on(t.status, t.createdAt),
  claimIdx: index('idx_pdf_conversion_jobs_claim').on(t.createdAt).where(sql`status = 'queued'`),
  processingUserIdx: index('idx_pdf_conversion_jobs_processing_user')
    .on(t.userId, t.lockExpiresAt)
    .where(sql`status = 'processing'`),
}));

export const pdfConversionJobsRelations = relations(pdfConversionJobs, ({ one }) => ({
  session: one(pdfSessions, {
    fields: [pdfConversionJobs.sessionId],
    references: [pdfSessions.id],
  }),
}));

// ── Agent Runs (source of truth for multi-worker run status) ──────────────────

export const agentRuns = pgTable('agent_runs', {
  id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
  threadId: text('thread_id').notNull(),
  status: text('status').$type<AgentRunStatus>().notNull().default('queued'),
  ownerInstance: text('owner_instance'),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  progressAt: timestamp('progress_at', { withTimezone: true, mode: 'string' }),
  progressLabel: text('progress_label'),
  progressPhase: text('progress_phase').$type<AgentRunPhase>(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  timeoutAt: timestamp('timeout_at', { withTimezone: true, mode: 'string' }),
  // True when the run was claimed under event-driven-run-termination. Lets the
  // reaper classify deterministically from the row (event-driven runs never
  // write a heartbeat by design) instead of re-evaluating the flag per sweep.
  eventDriven: boolean('event_driven').notNull().default(false),
  lastError: text('last_error'),
  // FEAT-001 Formal Agent Run Lifecycle (additive; nullable for legacy rows).
  projectId: text('project_id'),
  lane: text('lane').$type<AgentRunLane>(),
  queuedAt: timestamp('queued_at', { withTimezone: true, mode: 'string' }),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true, mode: 'string' }),
  dispatchMessageId: text('dispatch_message_id'),
  executionSnapshot: jsonb('execution_snapshot').$type<AgentRunExecutionSnapshot>(),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  cancelState: text('cancel_state').$type<AgentRunCancelState>(),
  terminalReason: text('terminal_reason').$type<AgentRunTerminalReason>(),
  // Durable protocol: V1 default; background and interactive V2 write explicit transports.
  transportVersion: text('transport_version').$type<AiRunTransportVersion>().notNull().default('http-files-v1'),
  requestedByUserId: text('requested_by_user_id'),
  interactiveClass: text('interactive_class').$type<InteractiveClass>(),
  clientTurnId: uuid('client_turn_id'),
  clientTurnHash: text('client_turn_hash'),
  devSessionId: uuid('dev_session_id').references(() => devSessions.id, { onDelete: 'set null' }),
  buildTaskId: uuid('build_task_id').references((): AnyPgColumn => buildTasks.id, { onDelete: 'set null' }),
  workflowClass: text('workflow_class').$type<AgentRunWorkflowClass>(),
  cloudAgentIdentity: text('cloud_agent_identity'),
  cloudAgentManaged: boolean('cloud_agent_managed').notNull().default(false),
  cloudJobName: text('cloud_job_name'),
  cloudJobExecutionName: text('cloud_job_execution_name'),
  cloudBranchName: text('cloud_branch_name'),
  cloudPrUrl: text('cloud_pr_url'),
  cloudPrStatus: text('cloud_pr_status')
    .$type<'none' | 'open' | 'abandoned' | 'merged'>()
    .default('none'),
  // FEAT-003 TBI-005: suite-level unit/e2e/WCAG outcomes reported at terminal write time.
  // NULL means the run reported nothing; never gates PR creation or run completion.
  checkResults: jsonb('check_results').$type<RunCheckResult[]>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  statusHeartbeatIdx: index('idx_agent_runs_status_heartbeat').on(t.status, t.heartbeatAt),
  statusLaneIdx: index('idx_agent_runs_status_lane').on(t.status, t.lane),
  projectStatusIdx: index('idx_agent_runs_project_status').on(t.projectId, t.status),
  threadCreatedIdx: index('idx_agent_runs_thread_created').on(t.threadId, t.createdAt),
  threadActiveIdx: index('idx_agent_runs_thread_active')
    .on(t.threadId, t.createdAt)
    .where(sql`${t.status} IN ('queued', 'dispatched', 'running')`),
  v2ActiveThreadIdx: uniqueIndex('uq_agent_runs_v2_active_thread')
    .on(t.threadId)
    .where(sql`${t.transportVersion} = 'servicebus-blob-v2' AND ${t.status} IN ('queued', 'dispatched', 'running')`),
  clientTurnUniq: uniqueIndex('uq_agent_runs_client_turn')
    .on(t.threadId, t.clientTurnId)
    .where(sql`${t.clientTurnId} IS NOT NULL`),
  interactiveActiveThreadUniq: uniqueIndex('uq_agent_runs_interactive_active_thread')
    .on(t.threadId)
    .where(sql`${t.lane} = 'ai-runs-interactive' AND ${t.status} IN ('queued', 'dispatched', 'running')`),
  interactiveUserActiveIdx: index('idx_agent_runs_interactive_user_active')
    .on(t.requestedByUserId, t.interactiveClass, t.createdAt)
    .where(sql`${t.lane} = 'ai-runs-interactive' AND ${t.status} IN ('queued', 'dispatched', 'running')`),
  cloudPrStatusCheck: check(
    'agent_runs_cloud_pr_status_check',
    sql`${t.cloudPrStatus} IS NULL OR ${t.cloudPrStatus} IN ('none', 'open', 'abandoned', 'merged')`,
  ),
  queuedWorkerIdx: index('idx_agent_runs_queued_at_worker')
    .on(t.queuedAt)
    .where(sql`${t.lane} = 'background'`),
  dispatchedWorkerIdx: index('idx_agent_runs_dispatched_at_worker')
    .on(t.dispatchedAt)
    .where(sql`${t.lane} = 'background' AND ${t.dispatchMessageId} IS NOT NULL`),
  heartbeatWorkerIdx: index('idx_agent_runs_heartbeat_at_worker')
    .on(t.heartbeatAt)
    .where(sql`${t.lane} = 'background' AND ${t.dispatchMessageId} IS NOT NULL`),
  backgroundInFlightIdx: index('idx_agent_runs_background_in_flight')
    .on(t.lane, t.status)
    .where(sql`${t.lane} = 'background' AND ${t.status} IN ('dispatched', 'running')`),
  backgroundFairQueueIdx: index('idx_agent_runs_background_fair_queue')
    .on(t.projectId, t.queuedAt, t.id)
    .where(sql`${t.lane} = 'background' AND ${t.status} = 'queued'`),
  laneCheck: check(
    'agent_runs_lane_check',
    sql`${t.lane} IS NULL OR ${t.lane} IN ('background', 'ai-runs-interactive', 'cloud-agent')`,
  ),
  terminalReasonCheck: check(
    'agent_runs_terminal_reason_check',
    sql`${t.terminalReason} IS NULL OR ${t.terminalReason} IN ('worker_lost', 'progress_timeout', 'queue_ttl', 'forced_cancel', 'dispatch_ttl', 'cloud_agent_timeout')`,
  ),
  transportVersionCheck: check(
    'agent_runs_transport_version_check',
    sql`${t.transportVersion} IN ('http-files-v1', 'servicebus-blob-v2', 'dapr-actor-v2')`,
  ),
  interactiveClassCheck: check(
    'agent_runs_interactive_class_check',
    sql`${t.interactiveClass} IS NULL OR ${t.interactiveClass} IN ('fast', 'agentic')`,
  ),
  clientTurnHashCheck: check(
    'agent_runs_client_turn_hash_check',
    sql`${t.clientTurnHash} IS NULL OR ${t.clientTurnHash} ~ '^[0-9a-f]{64}$'`,
  ),
  requestedByUserIdCheck: check(
    'agent_runs_requested_by_user_id_check',
    sql`${t.requestedByUserId} IS NULL OR (${t.requestedByUserId} = btrim(${t.requestedByUserId}) AND char_length(${t.requestedByUserId}) BETWEEN 1 AND 256)`,
  ),
  daprActorRequiredFieldsCheck: check(
    'agent_runs_dapr_actor_v2_required_fields_check',
    sql`${t.transportVersion} <> 'dapr-actor-v2' OR (${t.requestedByUserId} IS NOT NULL AND ${t.interactiveClass} IS NOT NULL AND ${t.clientTurnId} IS NOT NULL AND ${t.clientTurnHash} IS NOT NULL)`,
  ),
  workflowClassCheck: check(
    'agent_runs_workflow_class_check',
    sql`${t.workflowClass} IS NULL OR ${t.workflowClass} IN ('generation', 'implementation', 'build-task')`,
  ),
  buildTaskClassCheck: check(
    'agent_runs_build_task_class_check',
    sql`${t.buildTaskId} IS NULL OR ${t.workflowClass} = 'build-task'`,
  ),
  oneLivePerBuildTask: uniqueIndex('uq_agent_runs_one_live_per_build_task')
    .on(t.buildTaskId)
    .where(sql`${t.workflowClass} = 'build-task' AND ${t.status} IN ('queued', 'dispatched', 'running') AND ${t.buildTaskId} IS NOT NULL`),
  buildTaskIdx: index('idx_agent_runs_build_task')
    .on(t.buildTaskId)
    .where(sql`${t.buildTaskId} IS NOT NULL`),
  cloudAgentManagedIdentityCheck: check(
    'agent_runs_cloud_agent_managed_identity_check',
    sql`${t.cloudAgentManaged} = false OR ${t.cloudAgentIdentity} IS NOT NULL`,
  ),
  oneLiveImplementationPerSession: uniqueIndex('uq_agent_runs_one_live_per_session')
    .on(t.devSessionId)
    .where(sql`${t.workflowClass} = 'implementation' AND ${t.status} IN ('queued', 'dispatched', 'running') AND ${t.devSessionId} IS NOT NULL`),
  nonTerminalTimeoutCheck: check(
    'agent_runs_non_terminal_timeout_at_check',
    sql`${t.status} NOT IN ('queued', 'running') OR ${t.timeoutAt} IS NOT NULL`,
  ),
}));

export const agentRunEvents = pgTable('agent_run_events', {
  eventId: uuid('event_id').primaryKey(),
  ordinal: bigserial('ordinal', { mode: 'number' }).notNull().unique(),
  threadId: text('thread_id').notNull(),
  runId: text('run_id').notNull(),
  sourceInstance: text('source_instance').notNull(),
  sequence: integer('sequence').notNull(),
  eventTimestamp: timestamp('event_timestamp', { withTimezone: true, mode: 'string' }).notNull(),
  eventType: text('event_type').$type<AgentRunEventType>().notNull(),
  phase: text('phase').$type<AgentRunPhase>().notNull(),
  status: text('status').$type<AgentRunEventStatus>().notNull(),
  detail: text('detail'),
  event: jsonb('event').$type<SseEvent | AgentRunCancelEvent>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  sourceSequenceUniq: unique('agent_run_events_source_sequence_key').on(t.runId, t.sourceInstance, t.sequence),
  threadOrdinalIdx: index('idx_agent_run_events_thread_ordinal').on(t.threadId, t.ordinal),
  runSequenceIdx: index('idx_agent_run_events_run_sequence').on(t.runId, t.sequence),
}));

// ── AI Run V2 control plane (Task 3 persistence contracts) ─────────────────────

export const aiRunAttempts = pgTable('ai_run_attempts', {
  id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
  runId: text('run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  attemptNumber: integer('attempt_number').notNull(),
  dispatchMessageId: text('dispatch_message_id').notNull(),
  status: text('status').$type<AiRunV2AttemptStatus>().notNull().default('queued'),
  artifactStatus: text('artifact_status').$type<AiRunArtifactStatus>().notNull().default('pending'),
  lastCheckpointSequence: integer('last_checkpoint_sequence').notNull().default(0),
  lastCheckpointAt: timestamp('last_checkpoint_at', { withTimezone: true, mode: 'string' }),
  specRef: jsonb('spec_ref').$type<AiRunBlobRef>(),
  specSnapshot: jsonb('spec_snapshot').$type<DurableInteractiveTurnSpecification>(),
  manifestRef: jsonb('manifest_ref').$type<AiRunBlobRef>(),
  failureCategory: text('failure_category').$type<AiRunV2FailureCategory>(),
  failureDetail: text('failure_detail'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  runAttemptUniq: unique('uq_ai_run_attempts_run_number').on(t.runId, t.attemptNumber),
  dispatchMessageUniq: unique('uq_ai_run_attempts_dispatch_message_id').on(t.dispatchMessageId),
  activeAttemptUniq: uniqueIndex('uq_ai_run_attempts_active_run')
    .on(t.runId)
    .where(sql`${t.status} IN ('queued', 'dispatched', 'running', 'checking_worker', 'finalizing')`),
  runCreatedIdx: index('idx_ai_run_attempts_run_created').on(t.runId, t.createdAt),
  statusCheck: check(
    'ai_run_attempts_status_check',
    sql`${t.status} IN ('queued', 'dispatched', 'running', 'checking_worker', 'finalizing', 'completed', 'failed', 'cancelled')`,
  ),
  artifactStatusCheck: check(
    'ai_run_attempts_artifact_status_check',
    sql`${t.artifactStatus} IN ('pending', 'uploading', 'manifest_written', 'verified', 'failed')`,
  ),
  failureCategoryCheck: check(
    'ai_run_attempts_failure_category_check',
    sql`${t.failureCategory} IS NULL OR ${t.failureCategory} IN ('worker_lost', 'progress_timeout', 'queue_ttl', 'dispatch_ttl', 'forced_cancel', 'poison_message', 'artifact_verification_failed', 'lease_lost', 'internal_error', 'hard_timeout', 'tool_timeout', 'worker_start_failed', 'validation_failed')`,
  ),
  attemptNumberCheck: check(
    'ai_run_attempts_attempt_number_check',
    sql`${t.attemptNumber} > 0`,
  ),
  checkpointSequenceCheck: check(
    'ai_run_attempts_checkpoint_sequence_check',
    sql`${t.lastCheckpointSequence} >= 0`,
  ),
}));

export const aiRunOutbox = pgTable('ai_run_outbox', {
  id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
  idempotencyKey: text('idempotency_key').notNull(),
  kind: text('kind').notNull(),
  runId: text('run_id').notNull(),
  attemptId: text('attempt_id'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  availableAt: timestamp('available_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  claimedBy: text('claimed_by'),
  claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'string' }),
  claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true, mode: 'string' }),
  publishAttempts: integer('publish_attempts').notNull().default(0),
  lastError: text('last_error'),
  publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  idempotencyUniq: unique('uq_ai_run_outbox_idempotency_key').on(t.idempotencyKey),
  dueIdx: index('idx_ai_run_outbox_due')
    .on(t.availableAt, t.createdAt)
    .where(sql`${t.publishedAt} IS NULL`),
  interactiveDueIdx: index('idx_ai_run_outbox_interactive_due')
    .on(t.createdAt, t.id)
    .where(sql`${t.kind} = 'interactive_dispatch' AND ${t.publishedAt} IS NULL`),
  interactiveClassDueIdx: index('idx_ai_run_outbox_interactive_class_due')
    .on(sql`(${t.payload}->>'interactiveClass')`, t.createdAt, t.id)
    .where(sql`${t.kind} = 'interactive_dispatch' AND ${t.publishedAt} IS NULL`),
  publishAttemptsCheck: check(
    'ai_run_outbox_publish_attempts_check',
    sql`${t.publishAttempts} >= 0`,
  ),
}));

export const aiRunInbox = pgTable('ai_run_inbox', {
  eventId: text('event_id').primaryKey(),
  kind: text('kind').notNull(),
  runId: text('run_id').notNull(),
  attemptId: text('attempt_id').notNull(),
  dispatchMessageId: text('dispatch_message_id').notNull(),
  checkpointSequence: integer('checkpoint_sequence'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true, mode: 'string' }),
}, (t) => ({
  attemptCheckpointUniq: uniqueIndex('uq_ai_run_inbox_attempt_checkpoint')
    .on(t.attemptId, t.checkpointSequence)
    .where(sql`${t.checkpointSequence} IS NOT NULL`),
  unprocessedIdx: index('idx_ai_run_inbox_unprocessed')
    .on(t.receivedAt)
    .where(sql`${t.processedAt} IS NULL`),
  checkpointSequenceCheck: check(
    'ai_run_inbox_checkpoint_sequence_check',
    sql`${t.checkpointSequence} IS NULL OR ${t.checkpointSequence} > 0`,
  ),
}));

export const aiControlPlaneLeases = pgTable('ai_control_plane_leases', {
  leaseKey: text('lease_key').$type<AiControlPlaneLeaseKey>().primaryKey(),
  holderId: text('holder_id'),
  fencingToken: bigint('fencing_token', { mode: 'bigint' }).notNull().default(sql`0`),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`'epoch'`),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  leaseKeyCheck: check(
    'ai_control_plane_leases_key_check',
    sql`${t.leaseKey} IN ('admission', 'recovery', 'reaper', 'outbox')`,
  ),
  fencingTokenCheck: check(
    'ai_control_plane_leases_fencing_token_check',
    sql`${t.fencingToken} >= 0`,
  ),
}));

// ── AI Cost Analytics ─────────────────────────────────────────────────────────

export const aiPricing = pgTable('ai_pricing', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(),
  modelId: text('model_id').notNull(),
  inputPricePerMtok: text('input_price_per_mtok').notNull().default('0'),
  outputPricePerMtok: text('output_price_per_mtok').notNull().default('0'),
  cacheReadPricePerMtok: text('cache_read_price_per_mtok').notNull().default('0'),
  cacheWritePricePerMtok: text('cache_write_price_per_mtok').notNull().default('0'),
  currency: text('currency').notNull().default('USD'),
  effectiveFrom: timestamp('effective_from', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  effectiveTo: timestamp('effective_to', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export type AiTokenSource = 'exact' | 'estimated';
export type AiCostSource = 'computed' | 'estimated' | 'allocated';
export type AiUsageStatus = 'success' | 'error' | 'cancelled';

export const aiUsageEvents = pgTable('ai_usage_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(),
  modelId: text('model_id').notNull(),
  effort: text('effort').$type<EffortLevel>(),
  feature: text('feature').notNull(),
  project: text('project').notNull(),
  skillPath: text('skill_path'),
  threadId: text('thread_id'),
  runId: text('run_id'),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  workItemId: text('work_item_id'),
  userId: text('user_id'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  tokenSource: text('token_source').$type<AiTokenSource>().notNull().default('estimated'),
  costUsd: text('cost_usd').notNull().default('0'),
  costSource: text('cost_source').$type<AiCostSource>().notNull().default('estimated'),
  durationMs: integer('duration_ms'),
  status: text('status').$type<AiUsageStatus>().notNull().default('success'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  createdAtIdx: index('idx_ai_usage_events_created_at').on(t.createdAt),
  providerIdx: index('idx_ai_usage_events_provider').on(t.provider),
  projectIdx: index('idx_ai_usage_events_project').on(t.project),
  featureIdx: index('idx_ai_usage_events_feature').on(t.feature),
  modelIdx: index('idx_ai_usage_events_model').on(t.modelId),
  projectCreatedIdx: index('idx_ai_usage_events_project_created').on(t.project, t.createdAt),
  entityIdx: index('idx_ai_usage_events_entity').on(t.entityType, t.entityId),
  threadIdx: index('idx_ai_usage_events_thread_id').on(t.threadId),
  cloudAgentRunUq: uniqueIndex('uq_ai_usage_events_cloud_agent_run')
    .on(t.runId)
    .where(sql`${t.feature} = 'cloud-agent' AND ${t.runId} IS NOT NULL`),
}));

export const cursorUsageEvents = pgTable('cursor_usage_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  ts: timestamp('ts', { withTimezone: true, mode: 'string' }).notNull(),
  serviceAccountId: text('service_account_id'),
  project: text('project'),
  model: text('model').notNull(),
  kind: text('kind'),
  maxMode: boolean('max_mode').notNull().default(false),
  isHeadless: boolean('is_headless').notNull().default(false),
  isTokenBasedCall: boolean('is_token_based_call').notNull().default(false),
  isChargeable: boolean('is_chargeable').notNull().default(false),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cacheWriteTokens: integer('cache_write_tokens'),
  cacheReadTokens: integer('cache_read_tokens'),
  totalModelCents: text('total_model_cents'),
  chargedCents: text('charged_cents').notNull().default('0'),
  cursorTokenFeeCents: text('cursor_token_fee_cents'),
  requestsCosts: text('requests_costs'),
  userEmail: text('user_email'),
  dedupeKey: text('dedupe_key').unique(),
  ingestedAt: timestamp('ingested_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  tsIdx: index('idx_cursor_usage_events_ts').on(t.ts),
  saIdx: index('idx_cursor_usage_events_sa').on(t.serviceAccountId),
  projectIdx: index('idx_cursor_usage_events_project').on(t.project),
  modelIdx: index('idx_cursor_usage_events_model').on(t.model),
}));

export const aiCostInsights = pgTable('ai_cost_insights', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').notNull(),
  periodFrom: text('period_from').notNull(),
  periodTo: text('period_to').notNull(),
  modelUsed: text('model_used').notNull(),
  headline: text('headline'),
  insights: jsonb('insights').$type<string[]>().notNull().default([]),
  recommendations: jsonb('recommendations').$type<string[]>().notNull().default([]),
  riskFlags: jsonb('risk_flags').$type<string[]>().notNull().default([]),
  generatedAt: timestamp('generated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  projectPeriodIdx: unique('ai_cost_insights_project_period').on(t.project, t.periodFrom, t.periodTo),
}));

export const aiCostDailyBrief = pgTable('ai_cost_daily_brief', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').notNull(),
  briefDate: text('brief_date').notNull(),
  briefType: text('brief_type').notNull().default('morning'),
  modelUsed: text('model_used').notNull(),
  totalCostUsd: text('total_cost_usd').notNull().default('0'),
  cursorCostUsd: text('cursor_cost_usd').notNull().default('0'),
  bedrockCostUsd: text('bedrock_cost_usd').notNull().default('0'),
  totalInteractions: integer('total_interactions').notNull().default(0),
  mtdCostUsd: text('mtd_cost_usd').notNull().default('0'),
  projectedEomUsd: text('projected_eom_usd').notNull().default('0'),
  trendDirection: text('trend_direction').notNull().default('flat'),
  trendPct: text('trend_pct').notNull().default('0'),
  headline: text('headline'),
  keyBullets: jsonb('key_bullets').$type<string[]>().notNull().default([]),
  alerts: jsonb('alerts').$type<string[]>().notNull().default([]),
  topFeatures: jsonb('top_features').$type<Array<{ feature: string; costUsd: number }>>().notNull().default([]),
  generatedAt: timestamp('generated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  projectDateTypeIdx: unique('ai_cost_daily_brief_project_date_type').on(t.project, t.briefDate, t.briefType),
}));

// ── Calendar Work-Item Assistant ──────────────────────────────────────────────

export const workItemAssistantSessions = pgTable('work_item_assistant_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerUserId: text('owner_user_id').notNull(),
  project: text('project').notNull(),
  areaPath: text('area_path').notNull().default(''),
  anchorWorkItemId: integer('anchor_work_item_id').notNull(),
  selectedWorkItemIds: jsonb('selected_work_item_ids').$type<number[]>().notNull().default([]),
  contextSnapshot: jsonb('context_snapshot').$type<WorkItemHierarchyNode[]>().notNull().default([]),
  threadId: uuid('thread_id').references(() => chatThreads.id, { onDelete: 'set null' }),
  status: text('status').$type<WorkItemAssistantSessionStatus>().notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  ownerIdx: index('idx_work_item_assistant_sessions_owner').on(t.ownerUserId),
  projectAnchorIdx: index('idx_work_item_assistant_sessions_project_anchor').on(t.project, t.anchorWorkItemId),
  threadIdx: index('idx_work_item_assistant_sessions_thread').on(t.threadId),
}));

export const workItemChangeProposals = pgTable('work_item_change_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => workItemAssistantSessions.id, { onDelete: 'cascade' }),
  changeSet: jsonb('change_set').$type<WorkItemChangeSet>().notNull(),
  status: text('status').$type<WorkItemProposalStatus>().notNull().default('pending'),
  itemResults: jsonb('item_results').$type<WorkItemApplyItemResult[]>(),
  resolvedBy: text('resolved_by'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  sessionCreatedIdx: index('idx_work_item_change_proposals_session_created').on(t.sessionId, t.createdAt),
}));

export const workItemAssistantSessionsRelations = relations(workItemAssistantSessions, ({ one, many }) => ({
  thread: one(chatThreads, {
    fields: [workItemAssistantSessions.threadId],
    references: [chatThreads.id],
  }),
  proposals: many(workItemChangeProposals),
}));

export const workItemChangeProposalsRelations = relations(workItemChangeProposals, ({ one }) => ({
  session: one(workItemAssistantSessions, {
    fields: [workItemChangeProposals.sessionId],
    references: [workItemAssistantSessions.id],
  }),
}));

// Add calendar assistant columns to projectSkillSettings (applied via migration)
// Drizzle schema mirrors columns added in 20260715170000_calendar-work-item-assistant.sql

// ── Apex Work Board ───────────────────────────────────────────────────────────

import type {
  AcceptanceCriterion,
  ApexWorkItemStatus,
  ApexWorkItemType,
  ApexWorkItemSourceType,
  ApexWorkItemPriority,
  ApexWorkItemEventAction,
  ApexReleaseStatus,
  ApexWorkItemLinkType,
} from '../../shared/types/apexWorkItem';

export const apexReleases = pgTable('apex_releases', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').notNull(),
  name: text('name').notNull(),
  version: text('version'),
  targetDate: date('target_date', { mode: 'string' }),
  status: text('status').$type<ApexReleaseStatus>().notNull().default('planned'),
  position: integer('position').notNull().default(0),
  createdBy: text('created_by').notNull().references(() => appUsers.oid, { onDelete: 'restrict' }),
  updatedBy: text('updated_by').notNull().references(() => appUsers.oid, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  projectTargetIdx: index('idx_apex_releases_project_target').on(t.project, t.targetDate),
}));

export const apexWorkItems = pgTable('apex_work_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').notNull(),
  itemNumber: integer('item_number').notNull(),
  title: text('title').notNull(),
  outcome: text('outcome').notNull().default(''),
  type: text('type').$type<ApexWorkItemType>().notNull(),
  status: text('status').$type<ApexWorkItemStatus>().notNull().default('idea'),
  ownerOid: text('owner_oid').references(() => appUsers.oid, { onDelete: 'restrict' }),
  assignedToApex: boolean('assigned_to_apex').notNull().default(false),
  priority: text('priority').$type<ApexWorkItemPriority>(),
  priorityRank: integer('priority_rank'),
  aiPriorityRationale: text('ai_priority_rationale'),
  aiRankedAt: timestamp('ai_ranked_at', { withTimezone: true, mode: 'string' }),
  acceptanceCriteria: jsonb('acceptance_criteria').$type<AcceptanceCriterion[]>().notNull().default([]),
  branch: text('branch'),
  prUrl: text('pr_url'),
  position: integer('position').notNull().default(0),
  dueDate: date('due_date', { mode: 'string' }),
  releaseId: uuid('release_id').references(() => apexReleases.id, { onDelete: 'set null' }),
  parentId: uuid('parent_id').references((): AnyPgColumn => apexWorkItems.id, { onDelete: 'set null' }),
  sourceType: text('source_type').$type<ApexWorkItemSourceType>().notNull().default('standalone'),
  prdId: uuid('prd_id').references(() => interviews.id, { onDelete: 'set null' }),
  backlogItemId: text('backlog_item_id'),
  featureRequestId: uuid('feature_request_id').references(() => featureRequests.id, { onDelete: 'set null' }),
  /** Azure DevOps work item id when imported / linked from ADO */
  adoWorkItemId: integer('ado_work_item_id'),
  epicId: text('epic_id'),
  epicTitle: text('epic_title'),
  featureId: text('feature_id'),
  featureTitle: text('feature_title'),
  /** Approved design doc (design + tech-spec + assumptions) linked like ADO Feature attachments */
  designDocId: uuid('design_doc_id').references(() => designDocs.id, { onDelete: 'set null' }),
  designPrototypeId: uuid('design_prototype_id').references(() => designPrototypes.id, { onDelete: 'set null' }),
  createdBy: text('created_by').notNull().references(() => appUsers.oid, { onDelete: 'restrict' }),
  updatedBy: text('updated_by').notNull().references(() => appUsers.oid, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  ownerStatusIdx: index('idx_apex_work_items_owner_status').on(t.ownerOid, t.status),
  statusPosIdx: index('idx_apex_work_items_status_pos').on(t.status, t.position),
  projectStatusPosIdx: index('idx_apex_work_items_project_status_pos').on(t.project, t.status, t.position),
  projectOwnerIdx: index('idx_apex_work_items_project_owner').on(t.project, t.ownerOid),
  projectPriorityRankIdx: index('idx_apex_work_items_project_priority_rank').on(t.project, t.priorityRank),
  projectItemNumberIdx: uniqueIndex('idx_apex_work_items_project_item_number').on(t.project, t.itemNumber),
  projectAdoIdx: uniqueIndex('idx_apex_work_items_project_ado')
    .on(t.project, t.adoWorkItemId)
    .where(sql`${t.adoWorkItemId} IS NOT NULL`),
  frIdx: index('idx_apex_work_items_feature_request').on(t.featureRequestId),
  releaseIdx: index('idx_apex_work_items_release').on(t.releaseId),
  parentIdx: index('idx_apex_work_items_parent').on(t.parentId),
  designDocIdx: index('idx_apex_work_items_design_doc').on(t.designDocId),
  designPrototypeIdx: index('idx_apex_work_items_design_prototype').on(t.designPrototypeId),
}));

export const apexWorkItemCollaborators = pgTable('apex_work_item_collaborators', {
  workItemId: uuid('work_item_id').notNull().references(() => apexWorkItems.id, { onDelete: 'cascade' }),
  userOid: text('user_oid').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  addedAt: timestamp('added_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.workItemId, t.userOid] }),
  userIdx: index('idx_apex_work_item_collab_user').on(t.userOid),
}));

export const apexWorkItemEvents = pgTable('apex_work_item_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  workItemId: uuid('work_item_id').notNull().references(() => apexWorkItems.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').notNull().references(() => appUsers.oid, { onDelete: 'restrict' }),
  action: text('action').$type<ApexWorkItemEventAction>().notNull(),
  fromStatus: text('from_status').$type<ApexWorkItemStatus>(),
  toStatus: text('to_status').$type<ApexWorkItemStatus>(),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  itemCreatedIdx: index('idx_apex_work_item_events_item').on(t.workItemId, t.createdAt),
}));

export const apexWorkItemLinks = pgTable('apex_work_item_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').notNull(),
  sourceId: uuid('source_id').notNull().references(() => apexWorkItems.id, { onDelete: 'cascade' }),
  targetId: uuid('target_id').notNull().references(() => apexWorkItems.id, { onDelete: 'cascade' }),
  linkType: text('link_type').$type<ApexWorkItemLinkType>().notNull().default('predecessor'),
  createdBy: text('created_by').notNull().references(() => appUsers.oid, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  targetIdx: index('idx_apex_work_item_links_target').on(t.targetId),
  projectIdx: index('idx_apex_work_item_links_project').on(t.project),
}));

export const apexWorkItemComments = pgTable('apex_work_item_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  workItemId: uuid('work_item_id').notNull().references(() => apexWorkItems.id, { onDelete: 'cascade' }),
  project: text('project').notNull(),
  authorOid: text('author_oid').notNull().references(() => appUsers.oid, { onDelete: 'restrict' }),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  itemIdx: index('idx_apex_work_item_comments_item').on(t.workItemId, t.createdAt),
  projectIdx: index('idx_apex_work_item_comments_project').on(t.project),
}));

export const apexWorkItemAttachments = pgTable('apex_work_item_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  workItemId: uuid('work_item_id').notNull().references(() => apexWorkItems.id, { onDelete: 'cascade' }),
  project: text('project').notNull(),
  fileName: text('file_name').notNull(),
  contentType: text('content_type').notNull().default('application/octet-stream'),
  byteSize: integer('byte_size').notNull().default(0),
  storagePath: text('storage_path').notNull(),
  uploadedBy: text('uploaded_by').notNull().references(() => appUsers.oid, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  itemIdx: index('idx_apex_work_item_attachments_item').on(t.workItemId),
}));

export const apexDeployments = pgTable('apex_deployments', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').notNull(),
  releaseId: uuid('release_id').references(() => apexReleases.id, { onDelete: 'set null' }),
  environment: text('environment').notNull(),
  version: text('version').notNull(),
  deployedAt: timestamp('deployed_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  deployedBy: text('deployed_by').references(() => appUsers.oid, { onDelete: 'set null' }),
  notes: text('notes'),
  workItemIds: jsonb('work_item_ids').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  projectEnvIdx: index('idx_apex_deployments_project_env').on(t.project, t.environment, t.deployedAt),
  releaseIdx: index('idx_apex_deployments_release').on(t.releaseId),
}));

export const apexWorkItemsRelations = relations(apexWorkItems, ({ one, many }) => ({
  owner: one(appUsers, { fields: [apexWorkItems.ownerOid], references: [appUsers.oid] }),
  release: one(apexReleases, { fields: [apexWorkItems.releaseId], references: [apexReleases.id] }),
  parent: one(apexWorkItems, { fields: [apexWorkItems.parentId], references: [apexWorkItems.id], relationName: 'workItemParent' }),
  children: many(apexWorkItems, { relationName: 'workItemParent' }),
  collaborators: many(apexWorkItemCollaborators),
  events: many(apexWorkItemEvents),
  comments: many(apexWorkItemComments),
  attachments: many(apexWorkItemAttachments),
  featureRequest: one(featureRequests, { fields: [apexWorkItems.featureRequestId], references: [featureRequests.id] }),
}));

export const apexReleasesRelations = relations(apexReleases, ({ many }) => ({
  workItems: many(apexWorkItems),
  deployments: many(apexDeployments),
}));

export const apexWorkItemCollaboratorsRelations = relations(apexWorkItemCollaborators, ({ one }) => ({
  workItem: one(apexWorkItems, { fields: [apexWorkItemCollaborators.workItemId], references: [apexWorkItems.id] }),
  user: one(appUsers, { fields: [apexWorkItemCollaborators.userOid], references: [appUsers.oid] }),
}));

export const apexWorkItemEventsRelations = relations(apexWorkItemEvents, ({ one }) => ({
  workItem: one(apexWorkItems, { fields: [apexWorkItemEvents.workItemId], references: [apexWorkItems.id] }),
  actor: one(appUsers, { fields: [apexWorkItemEvents.actorId], references: [appUsers.oid] }),
}));

export const apexWorkItemCommentsRelations = relations(apexWorkItemComments, ({ one }) => ({
  workItem: one(apexWorkItems, { fields: [apexWorkItemComments.workItemId], references: [apexWorkItems.id] }),
  author: one(appUsers, { fields: [apexWorkItemComments.authorOid], references: [appUsers.oid] }),
}));

export const apexWorkItemAttachmentsRelations = relations(apexWorkItemAttachments, ({ one }) => ({
  workItem: one(apexWorkItems, { fields: [apexWorkItemAttachments.workItemId], references: [apexWorkItems.id] }),
  uploader: one(appUsers, { fields: [apexWorkItemAttachments.uploadedBy], references: [appUsers.oid] }),
}));

// ── Load Testing Module ───────────────────────────────────────────────────────

export const loadTests = pgTable('load_test', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: text('project_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  targetUrl: text('target_url').notNull(),
  environment: text('environment').notNull(),
  engine: text('engine').$type<LoadTestEngine>().notNull().default('k6'),
  flowType: text('flow_type').$type<LoadTestFlowType>().notNull().default('single'),
  scriptSource: text('script_source').$type<LoadTestScriptSource>().notNull().default('form_builder'),
  script: text('script').notNull(),
  loadProfile: jsonb('load_profile').$type<LoadProfile>().notNull(),
  clientThresholds: jsonb('client_thresholds').$type<Threshold[]>().notNull().default([]),
  flowSteps: jsonb('flow_steps').$type<FlowStep[] | null>(),
  runSource: text('run_source').$type<LoadTestRunSource>(),
  secretRefs: jsonb('secret_refs').$type<Record<string, string>>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  createdBy: text('created_by').notNull(),
  updatedBy: text('updated_by').notNull(),
}, (t) => ({
  projectIdIdx: index('idx_load_test_project_id').on(t.projectId),
  projectCreatedIdx: index('idx_load_test_project_created').on(t.projectId, t.createdAt),
}));

export const loadTestRuns = pgTable('load_test_run', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: text('project_id').notNull(),
  loadTestId: uuid('load_test_id').notNull().references(() => loadTests.id, { onDelete: 'restrict' }),
  status: text('status').$type<RunStatus>().notNull().default('queued'),
  runSource: text('run_source').$type<LoadTestRunSource>().notNull().default('app'),
  queuedAt: timestamp('queued_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true, mode: 'string' }),
  dispatchMessageId: text('dispatch_message_id'),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  overallResult: text('overall_result').$type<'passed' | 'failed'>(),
  thresholdResults: jsonb('threshold_results').$type<ThresholdResult[]>(),
  summaryArtifactRef: jsonb('summary_artifact_ref').$type<ArtifactRef>(),
  timeseriesArtifactRef: jsonb('timeseries_artifact_ref').$type<ArtifactRef>(),
  errorDetail: text('error_detail'),
  targetKey: text('target_key'),
  executionSnapshot: jsonb('execution_snapshot').$type<LoadTestExecutionSnapshot>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  projectIdIdx: index('idx_load_test_run_project_id').on(t.projectId),
  projectCreatedIdx: index('idx_load_test_run_project_created').on(t.projectId, t.createdAt),
  loadTestIdIdx: index('idx_load_test_run_load_test_id').on(t.loadTestId),
  statusHeartbeatIdx: index('idx_load_test_run_status_heartbeat').on(t.status, t.heartbeatAt),
}));

export const loadTestTargets = pgTable('load_test_target', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: text('project_id').notNull(),
  baseUrl: text('base_url').notNull(),
  environmentLabel: text('environment_label').notNull(),
  isReachable: boolean('is_reachable').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  createdBy: text('created_by').notNull(),
  updatedBy: text('updated_by').notNull(),
}, (t) => ({
  projectIdIdx: index('idx_load_test_target_project_id').on(t.projectId),
  projectBaseUrlUq: uniqueIndex('uq_load_test_target_project_base_url').on(t.projectId, t.baseUrl),
}));

export const loadTestsRelations = relations(loadTests, ({ many }) => ({
  runs: many(loadTestRuns),
}));

export const loadTestRunsRelations = relations(loadTestRuns, ({ one }) => ({
  loadTest: one(loadTests, {
    fields: [loadTestRuns.loadTestId],
    references: [loadTests.id],
  }),
}));

// ── Diagrams Module ───────────────────────────────────────────────────────────

export const diagrams = pgTable('diagrams', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: text('project_id').notNull(),
  ownerId: text('owner_id').notNull().references(() => appUsers.oid, { onDelete: 'restrict' }),
  title: text('title').notNull(),
  scene: jsonb('scene').$type<ExcalidrawScene>().notNull(),
  thumbnail: text('thumbnail').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  projectOwnerIdx: index('idx_diagrams_project_owner').on(t.projectId, t.ownerId),
  projectUpdatedIdx: index('idx_diagrams_project_updated').on(t.projectId, t.updatedAt),
  titleNotBlankCheck: check('diagrams_title_not_blank', sql`length(btrim(${t.title})) > 0`),
  versionPositiveCheck: check('diagrams_version_positive', sql`${t.version} > 0`),
}));

export const diagramShares = pgTable('diagram_shares', {
  id: uuid('id').primaryKey().defaultRandom(),
  diagramId: uuid('diagram_id').notNull().references(() => diagrams.id, { onDelete: 'cascade' }),
  granteeId: text('grantee_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  access: text('access').$type<DiagramShareAccess>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  diagramGranteeUq: unique('diagram_shares_diagram_id_grantee_id_key').on(
    t.diagramId,
    t.granteeId,
  ),
  granteeIdx: index('idx_diagram_shares_grantee').on(t.granteeId, t.diagramId),
  accessCheck: check('diagram_shares_access_check', sql`${t.access} IN ('view', 'edit')`),
}));

export const diagramsRelations = relations(diagrams, ({ one, many }) => ({
  owner: one(appUsers, {
    fields: [diagrams.ownerId],
    references: [appUsers.oid],
  }),
  shares: many(diagramShares),
}));

export const diagramSharesRelations = relations(diagramShares, ({ one }) => ({
  diagram: one(diagrams, {
    fields: [diagramShares.diagramId],
    references: [diagrams.id],
  }),
  grantee: one(appUsers, {
    fields: [diagramShares.granteeId],
    references: [appUsers.oid],
  }),
}));

// ── Walkthrough Tables (FEAT-001) ─────────────────────────────────────────────

export const walkthroughs = pgTable('walkthroughs', {
  id: uuid('id').primaryKey().defaultRandom(),
  internalName: text('internal_name').notNull(),
  userTitle: text('user_title').notNull(),
  whyItMatters: text('why_it_matters').notNull().default(''),
  lifecycle: text('lifecycle').$type<WalkthroughLifecycle>().notNull().default('draft'),
  priority: integer('priority').notNull().default(0),
  isRequired: boolean('is_required').notNull().default(false),
  revision: integer('revision').notNull().default(1),
  publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),
  archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  generationProvenance: jsonb('generation_provenance').$type<WalkthroughGenerationProvenance>(),
}, (t) => ({
  lifecyclePriorityPublishedIdx: index('idx_walkthroughs_lifecycle_priority_published').on(
    t.lifecycle,
    t.priority,
    t.publishedAt,
  ),
}));

export const walkthroughSteps = pgTable('walkthrough_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  walkthroughId: uuid('walkthrough_id').notNull().references(() => walkthroughs.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  heading: text('heading').notNull(),
  bodyMarkdown: text('body_markdown').notNull().default(''),
  /** First-class Step destination; existing DB column retained for compatibility. */
  route: text('target_route'),
  imageUrl: text('image_url'),
  imageAlt: text('image_alt'),
  ctaLabel: text('cta_label'),
  ctaRoute: text('cta_route'),
  /** Flat nullable anchor columns — route is shared with the Step destination. */
  anchorKey: text('anchor_key'),
  placement: text('placement').$type<WalkthroughAnchorPlacement>(),
}, (t) => ({
  ordinalUq: unique('uq_walkthrough_steps_ordinal').on(t.walkthroughId, t.ordinal),
  walkthroughOrdinalIdx: index('idx_walkthrough_steps_walkthrough_ordinal').on(
    t.walkthroughId,
    t.ordinal,
  ),
}));

export const walkthroughTargetingRules = pgTable('walkthrough_targeting_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  walkthroughId: uuid('walkthrough_id').notNull().references(() => walkthroughs.id, { onDelete: 'cascade' }),
  type: text('type').$type<WalkthroughTargetRuleType>().notNull(),
  value: text('value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  typeValueIdx: index('idx_walkthrough_targeting_rules_type_value').on(t.type, t.value),
  walkthroughIdx: index('idx_walkthrough_targeting_rules_walkthrough').on(t.walkthroughId),
  walkthroughTypeValueUq: unique('uq_walkthrough_targeting_rules_walkthrough_type_value').on(
    t.walkthroughId,
    t.type,
    t.value,
  ),
}));

export const walkthroughProgress = pgTable('walkthrough_progress', {
  id: uuid('id').primaryKey().defaultRandom(),
  walkthroughId: uuid('walkthrough_id').notNull().references(() => walkthroughs.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  /** Persisted: seen | completed | dismissed only. acknowledged is derived. */
  status: text('status').$type<WalkthroughProgressStatus>().notNull(),
  lastStepId: uuid('last_step_id').references(() => walkthroughSteps.id, { onDelete: 'set null' }),
  seenAt: timestamp('seen_at', { withTimezone: true, mode: 'string' }),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true, mode: 'string' }),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  userRevisionUq: unique('uq_walkthrough_progress_user_revision').on(
    t.walkthroughId,
    t.userId,
    t.revision,
  ),
  userWalkthroughRevisionIdx: index('idx_walkthrough_progress_user_walkthrough_revision').on(
    t.userId,
    t.walkthroughId,
    t.revision,
  ),
  walkthroughRevisionIdx: index('idx_walkthrough_progress_walkthrough_revision').on(
    t.walkthroughId,
    t.revision,
  ),
}));

export type WalkthroughNotificationAttemptState = 'pending' | 'delivered' | 'failed';

export const walkthroughAnchorMisses = pgTable('walkthrough_anchor_misses', {
  id: uuid('id').primaryKey().defaultRandom(),
  walkthroughId: uuid('walkthrough_id').notNull().references(() => walkthroughs.id, { onDelete: 'cascade' }),
  stepId: uuid('step_id').notNull().references(() => walkthroughSteps.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  projectSnapshot: text('project_snapshot').notNull(),
  anchorKey: text('anchor_key').notNull(),
  targetRoute: text('target_route').notNull(),
  occurrenceId: uuid('occurrence_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  occurrenceUq: unique('uq_walkthrough_anchor_misses_occurrence').on(
    t.userId,
    t.walkthroughId,
    t.stepId,
    t.revision,
    t.occurrenceId,
  ),
  walkthroughOccurredIdx: index('idx_walkthrough_anchor_misses_walkthrough_occurred').on(
    t.walkthroughId,
    t.occurredAt,
    t.id,
  ),
  stepRevisionIdx: index('idx_walkthrough_anchor_misses_step_revision').on(t.stepId, t.revision),
}));

export const walkthroughNotificationDeliveries = pgTable('walkthrough_notification_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  walkthroughId: uuid('walkthrough_id').notNull().references(() => walkthroughs.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  userId: text('user_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  notificationId: uuid('notification_id').references(() => notifications.id, { onDelete: 'set null' }),
  attemptState: text('attempt_state').$type<WalkthroughNotificationAttemptState>().notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastErrorClass: text('last_error_class'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  wtRevUserUq: unique('uq_walkthrough_notification_deliveries_wt_rev_user').on(
    t.walkthroughId,
    t.revision,
    t.userId,
  ),
  userRevisionIdx: index('idx_walkthrough_notification_deliveries_user_revision').on(
    t.userId,
    t.walkthroughId,
    t.revision,
  ),
}));

/** Smart Anchor Management — approved+active rows are the runtime catalog. */
export const walkthroughAnchorRegistry = pgTable('walkthrough_anchor_registry', {
  id: uuid('id').primaryKey().defaultRandom(),
  anchorKey: text('anchor_key').notNull(),
  testId: text('test_id').notNull(),
  label: text('label').notNull(),
  suggestedRoute: text('suggested_route'),
  approvedRoute: text('approved_route'),
  allowedPlacements: jsonb('allowed_placements')
    .$type<WalkthroughRegistryPlacement[]>()
    .notNull()
    .default(['bottom']),
  smartTags: jsonb('smart_tags').$type<string[]>().notNull().default([]),
  openerAnchorKeys: jsonb('opener_anchor_keys').$type<string[]>().notNull().default([]),
  sourceKind: text('source_kind').$type<WalkthroughAnchorSourceKind>().notNull(),
  sourceLocations: jsonb('source_locations')
    .$type<WalkthroughAnchorSourceLocation[]>()
    .notNull()
    .default([]),
  sourceHash: text('source_hash'),
  reviewStatus: text('review_status')
    .$type<WalkthroughAnchorReviewStatus>()
    .notNull()
    .default('pending'),
  isActive: boolean('is_active').notNull().default(false),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'string' }),
  missingSince: timestamp('missing_since', { withTimezone: true, mode: 'string' }),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
  aiProvenance: jsonb('ai_provenance').$type<WalkthroughAnchorAiProvenance>(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  anchorKeyUq: uniqueIndex('uq_walkthrough_anchor_registry_anchor_key')
    .on(t.anchorKey)
    .where(sql`${t.deletedAt} IS NULL`),
  testIdUq: uniqueIndex('uq_walkthrough_anchor_registry_test_id')
    .on(t.testId)
    .where(sql`${t.deletedAt} IS NULL`),
  smartTagsGinIdx: index('idx_walkthrough_anchor_registry_smart_tags').using('gin', t.smartTags),
  activeRouteStatusIdx: index('idx_walkthrough_anchor_registry_active_route_status')
    .on(t.isActive, t.approvedRoute, t.reviewStatus)
    .where(sql`${t.deletedAt} IS NULL`),
  reviewStatusIdx: index('idx_walkthrough_anchor_registry_review_status')
    .on(t.reviewStatus)
    .where(sql`${t.deletedAt} IS NULL`),
}));

/** Platform Admin → Walkthroughs → Options (singleton skill + agent model). */
export const walkthroughAiOptions = pgTable('walkthrough_ai_options', {
  id: text('id').primaryKey().default(WALKTHROUGH_AI_OPTIONS_SINGLETON_ID),
  walkthroughGenerationSkillPath: text('walkthrough_generation_skill_path').notNull(),
  walkthroughGenerationModel: text('walkthrough_generation_model').notNull().default(''),
  anchorSmartTaggingSkillPath: text('anchor_smart_tagging_skill_path').notNull(),
  anchorSmartTaggingModel: text('anchor_smart_tagging_model').notNull().default(''),
  anchorDiscoverySkillPath: text('anchor_discovery_skill_path')
    .notNull()
    .default('.cursor/skills/walkthrough-anchor-discovery/SKILL.md'),
  anchorDiscoveryModel: text('anchor_discovery_model').notNull().default(''),
  createdBy: text('created_by').notNull(),
  createdByDisplayName: text('created_by_display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedBy: text('updated_by').notNull(),
  updatedByDisplayName: text('updated_by_display_name').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const walkthroughsRelations = relations(walkthroughs, ({ many }) => ({
  steps: many(walkthroughSteps),
  targetingRules: many(walkthroughTargetingRules),
  progress: many(walkthroughProgress),
  notificationDeliveries: many(walkthroughNotificationDeliveries),
  anchorMisses: many(walkthroughAnchorMisses),
}));

export const walkthroughAnchorMissesRelations = relations(walkthroughAnchorMisses, ({ one }) => ({
  walkthrough: one(walkthroughs, {
    fields: [walkthroughAnchorMisses.walkthroughId],
    references: [walkthroughs.id],
  }),
  step: one(walkthroughSteps, {
    fields: [walkthroughAnchorMisses.stepId],
    references: [walkthroughSteps.id],
  }),
  user: one(appUsers, {
    fields: [walkthroughAnchorMisses.userId],
    references: [appUsers.oid],
  }),
}));

export const walkthroughNotificationDeliveriesRelations = relations(
  walkthroughNotificationDeliveries,
  ({ one }) => ({
    walkthrough: one(walkthroughs, {
      fields: [walkthroughNotificationDeliveries.walkthroughId],
      references: [walkthroughs.id],
    }),
    user: one(appUsers, {
      fields: [walkthroughNotificationDeliveries.userId],
      references: [appUsers.oid],
    }),
    notification: one(notifications, {
      fields: [walkthroughNotificationDeliveries.notificationId],
      references: [notifications.id],
    }),
  }),
);

export const walkthroughStepsRelations = relations(walkthroughSteps, ({ one, many }) => ({
  walkthrough: one(walkthroughs, {
    fields: [walkthroughSteps.walkthroughId],
    references: [walkthroughs.id],
  }),
  progressRows: many(walkthroughProgress),
  anchorMisses: many(walkthroughAnchorMisses),
}));

export const walkthroughTargetingRulesRelations = relations(walkthroughTargetingRules, ({ one }) => ({
  walkthrough: one(walkthroughs, {
    fields: [walkthroughTargetingRules.walkthroughId],
    references: [walkthroughs.id],
  }),
}));

export const walkthroughProgressRelations = relations(walkthroughProgress, ({ one }) => ({
  walkthrough: one(walkthroughs, {
    fields: [walkthroughProgress.walkthroughId],
    references: [walkthroughs.id],
  }),
  user: one(appUsers, {
    fields: [walkthroughProgress.userId],
    references: [appUsers.oid],
  }),
  lastStep: one(walkthroughSteps, {
    fields: [walkthroughProgress.lastStepId],
    references: [walkthroughSteps.id],
  }),
}));

// ── Foundation Skill Releases ─────────────────────────────────────────────────

import type {
  FoundationSkillReleaseStatus,
  FoundationSkillAuditAction,
  FoundationSkillCompatibilityStatus,
  FoundationSkillArtifactManifest,
  FoundationSkillProjectNotes,
  FoundationSkillTargetRepo,
} from '../../shared/types/foundationSkills';

export const foundationSkillReleases = pgTable('foundation_skill_releases', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  version:             text('version').notNull().unique(),
  status:              text('status').$type<FoundationSkillReleaseStatus>().notNull().default('draft'),
  artifactPackage:     text('artifact_package').notNull().default('@apex/skills'),
  artifactVersion:     text('artifact_version').notNull(),
  artifactFeed:        text('artifact_feed'),
  integritySha256:     text('integrity_sha256'),
  contractApiVersion:  integer('contract_api_version').notNull().default(1),
  selectedSkills:      jsonb('selected_skills').$type<string[]>().notNull().default([]),
  targetProjects:      jsonb('target_projects').$type<string[]>().notNull().default([]),
  targetRepos:         jsonb('target_repos').$type<FoundationSkillTargetRepo[]>().notNull().default([]),
  skillTargets:        jsonb('skill_targets').$type<Record<string, string[]>>().notNull().default({}),
  manifestSnapshot:    jsonb('manifest_snapshot').$type<FoundationSkillArtifactManifest>(),
  releaseNotes:        text('release_notes'),
  breakingChanges:     text('breaking_changes'),
  projectNotes:        jsonb('project_notes').$type<Record<string, FoundationSkillProjectNotes>>().notNull().default({}),
  publishedBy:         text('published_by'),
  publishedAt:         timestamp('published_at', { withTimezone: true, mode: 'string' }),
  deprecatedBy:        text('deprecated_by'),
  deprecatedAt:        timestamp('deprecated_at', { withTimezone: true, mode: 'string' }),
  createdBy:           text('created_by').notNull(),
  createdAt:           timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt:           timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  statusVersionIdx: index('idx_fsr_status_version').on(t.status, t.version),
}));

export const foundationSkillReleaseAudit = pgTable('foundation_skill_release_audit', {
  id:             uuid('id').primaryKey().defaultRandom(),
  releaseId:      uuid('release_id').references(() => foundationSkillReleases.id, { onDelete: 'set null' }),
  releaseVersion: text('release_version').notNull(),
  action:         text('action').$type<FoundationSkillAuditAction>().notNull(),
  actorId:        text('actor_id'),
  actorEmail:     text('actor_email'),
  details:        jsonb('details').$type<Record<string, unknown>>(),
  createdAt:      timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  releaseCreatedIdx: index('idx_fsra_release_created').on(t.releaseId, t.createdAt),
  actionCreatedIdx:  index('idx_fsra_action_created').on(t.action, t.createdAt),
}));

export const foundationSkillRepoStatus = pgTable('foundation_skill_repo_status', {
  id:                    uuid('id').primaryKey().defaultRandom(),
  provider:              text('provider').notNull().default('ado'),
  project:               text('project').notNull(),
  repo:                  text('repo').notNull(),
  branch:                text('branch').notNull().default('main'),
  /** Apex project name — the identifier release targeting is keyed on. */
  apexProject:           text('apex_project'),
  installedVersion:      text('installed_version'),
  selectedSkills:        jsonb('selected_skills').$type<string[]>().notNull().default([]),
  lockHash:              text('lock_hash'),
  compatibilityStatus:   text('compatibility_status').$type<FoundationSkillCompatibilityStatus>(),
  compatibilityErrors:   jsonb('compatibility_errors').$type<string[]>().notNull().default([]),
  availableVersion:      text('available_version'),
  updateAvailable:       boolean('update_available').notNull().default(false),
  compatibilityCheckedAt: timestamp('compatibility_checked_at', { withTimezone: true, mode: 'string' }),
  lastObservedAt:        timestamp('last_observed_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  observedBy:            text('observed_by'),
  createdAt:             timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt:             timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  providerProjectRepoIdx: unique('fssrs_provider_project_repo_branch').on(t.provider, t.project, t.repo, t.branch),
  updateAvailableIdx:     index('idx_fssrs_update_available').on(t.updateAvailable, t.lastObservedAt),
  apexProjectIdx:         index('idx_fssrs_apex_project').on(t.apexProject),
}));

// ── Foundation Skill Relations ────────────────────────────────────────────────

export const foundationSkillReleasesRelations = relations(foundationSkillReleases, ({ many }) => ({
  auditLog: many(foundationSkillReleaseAudit),
}));

export const foundationSkillReleaseAuditRelations = relations(foundationSkillReleaseAudit, ({ one }) => ({
  release: one(foundationSkillReleases, {
    fields: [foundationSkillReleaseAudit.releaseId],
    references: [foundationSkillReleases.id],
  }),
}));

// ── API Keys Module (FEAT-001) ────────────────────────────────────────────────

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: text('project_id').notNull(),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  cadence: text('cadence').$type<ApiKeyCadence>().notNull(),
  scopes: text('scopes').array().$type<ApiKeyScope[]>().notNull().default([]),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
  deletedBy: text('deleted_by'),
}, (t) => ({
  projectCreatedActiveIdx: index('idx_api_keys_project_created_active')
    .on(t.projectId, t.createdAt)
    .where(sql`${t.deletedAt} is null`),
  projectLowerNameActiveUq: uniqueIndex('uq_api_keys_project_lower_name_active')
    .on(t.projectId, sql`lower(${t.name})`)
    .where(sql`${t.deletedAt} is null`),
  keyHashUq: uniqueIndex('uq_api_keys_key_hash').on(t.keyHash),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  createdByUser: one(appUsers, {
    fields: [apiKeys.createdBy],
    references: [appUsers.oid],
  }),
}));

// ── Observability Trace Events (Safe Trace Event Storage) ─────────────────────

export const traceEvents = pgTable('trace_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventType: text('event_type').$type<TraceEventType>().notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull(),
  actorUserId: text('actor_user_id').references(() => appUsers.oid, { onDelete: 'set null' }),
  projectId: text('project_id'),
  traceId: text('trace_id').notNull(),
  sessionId: text('session_id'),
  routeTemplate: text('route_template'),
  httpMethod: text('http_method'),
  statusCode: integer('status_code'),
  durationMs: integer('duration_ms'),
  severity: text('severity'),
  details: jsonb('details').$type<SafeTraceDetails>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  actorOccurredIdx: index('idx_trace_events_actor_occurred').on(t.actorUserId, t.occurredAt, t.id),
  traceOccurredIdx: index('idx_trace_events_trace_occurred').on(t.traceId, t.occurredAt),
  sessionOccurredIdx: index('idx_trace_events_session_occurred')
    .on(t.sessionId, t.occurredAt)
    .where(sql`${t.sessionId} IS NOT NULL`),
  routeOccurredIdx: index('idx_trace_events_route_occurred').on(t.routeTemplate, t.occurredAt),
  occurredIdx: index('idx_trace_events_occurred').on(t.occurredAt),
  eventTypeCheck: check(
    'trace_events_event_type_check',
    sql`${t.eventType} IN ('api_request', 'error', 'ui_action', 'agent_event')`,
  ),
  traceIdCheck: check(
    'trace_events_trace_id_check',
    sql`${t.traceId} ~ '^[0-9a-f]{32}$'`,
  ),
  statusCodeCheck: check(
    'trace_events_status_code_check',
    sql`${t.statusCode} IS NULL OR (${t.statusCode} >= 100 AND ${t.statusCode} <= 599)`,
  ),
  durationMsCheck: check(
    'trace_events_duration_ms_check',
    sql`${t.durationMs} IS NULL OR ${t.durationMs} >= 0`,
  ),
  routeTemplateCheck: check(
    'trace_events_route_template_check',
    sql`${t.routeTemplate} IS NULL OR position('?' IN ${t.routeTemplate}) = 0`,
  ),
  detailsObjectCheck: check(
    'trace_events_details_object_check',
    sql`jsonb_typeof(${t.details}) = 'object'`,
  ),
}));

export const tracePathRollups = pgTable('trace_path_rollups', {
  id: uuid('id').primaryKey().defaultRandom(),
  fromRoute: text('from_route').notNull(),
  toRoute: text('to_route').notNull(),
  day: date('day', { mode: 'string' }).notNull(),
  transitionCount: integer('transition_count').notNull().default(0),
  distinctActorCount: integer('distinct_actor_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  fromToDayUniq: unique('trace_path_rollups_from_to_day_key').on(t.fromRoute, t.toRoute, t.day),
  fromRouteCheck: check(
    'trace_path_rollups_from_route_check',
    sql`position('?' IN ${t.fromRoute}) = 0`,
  ),
  toRouteCheck: check(
    'trace_path_rollups_to_route_check',
    sql`position('?' IN ${t.toRoute}) = 0`,
  ),
  countsCheck: check(
    'trace_path_rollups_counts_check',
    sql`${t.transitionCount} >= 0 AND ${t.distinctActorCount} >= 0`,
  ),
}));

export const traceEventsRelations = relations(traceEvents, ({ one }) => ({
  actor: one(appUsers, {
    fields: [traceEvents.actorUserId],
    references: [appUsers.oid],
  }),
}));

// ── Artifact done events (frozen cycle-time end instants) ─────────────────────

// Insert-once per (artifactType, artifactId). No foreign key: artifactId points
// at interviews, prds, test_cases, design_prototypes, or design_docs depending
// on artifactType.
export const artifactDoneEvents = pgTable('artifact_done_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  artifactType: text('artifact_type').$type<ArtifactDoneEventType>().notNull(),
  artifactId: uuid('artifact_id').notNull(),
  doneAt: timestamp('done_at', { withTimezone: true, mode: 'string' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  artifactUniq: unique('artifact_done_events_artifact_type_artifact_id_key').on(t.artifactType, t.artifactId),
  typeDoneAtIdx: index('idx_artifact_done_events_type_done_at').on(t.artifactType, t.doneAt),
  artifactTypeCheck: check(
    'artifact_done_events_artifact_type_check',
    sql`${t.artifactType} IN ('interview', 'prd', 'test_case', 'design_prototype', 'design_doc')`,
  ),
}));

// ── Playbook orchestration (Apex-owned run truth) ─────────────────────────────

export const playbookSpendPolicies = pgTable('playbook_spend_policies', {
  project: text('project').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  baselineCostUsd: numeric('baseline_cost_usd', { precision: 18, scale: 6 }).notNull(),
  capUsd: numeric('cap_usd', { precision: 18, scale: 6 }).notNull(),
  warningActive: boolean('warning_active').notNull().default(false),
  warningGeneration: integer('warning_generation').notNull().default(0),
  warningCrossedAt: timestamp('warning_crossed_at', { withTimezone: true, mode: 'string' }),
  warningRecipientUserIds: jsonb('warning_recipient_user_ids').$type<string[]>().notNull().default([]),
  overrideByUserId: text('override_by_user_id').references(() => appUsers.oid, {
    onDelete: 'set null',
  }),
  overrideToUsd: numeric('override_to_usd', { precision: 18, scale: 6 }),
  overrideAt: timestamp('override_at', { withTimezone: true, mode: 'string' }),
  overrideReason: text('override_reason'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  enabledIdx: index('idx_playbook_spend_policies_enabled').on(t.enabled),
  baselineNonnegative: check(
    'playbook_spend_policies_baseline_nonnegative',
    sql`${t.baselineCostUsd} >= 0`,
  ),
  capPositive: check('playbook_spend_policies_cap_positive', sql`${t.capUsd} > 0`),
  warningGenerationNonnegative: check(
    'playbook_spend_policies_warning_generation_nonnegative',
    sql`${t.warningGeneration} >= 0`,
  ),
  warningStateComplete: check(
    'playbook_spend_policies_warning_state_complete',
    sql`(${t.warningActive} = false AND ${t.warningCrossedAt} IS NULL)
      OR (${t.warningActive} = true AND ${t.warningCrossedAt} IS NOT NULL)`,
  ),
}));

// These four tables are the whole of what Apex needs to answer "what happened, and what happens
// next" for a Playbook run. The engine's own tables live in the `playbook_engine` schema and are a
// disposable execution cache — nothing here references them, and exit criterion E4 drops them
// mid-run to prove it.

export const playbookDefinitions = pgTable('playbook_definitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  /** Null for definitions that were not installed from a shipped template. */
  templateKey: text('template_key'),
  /** Null when templateKey is null. Monotonic shipped template version at install. */
  templateVersion: integer('template_version'),
  createdBy: text('created_by').notNull().references(() => appUsers.oid, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  projectCreatedIdx: index('idx_playbook_definitions_project_created').on(t.project, t.createdAt),
  projectNameUq: uniqueIndex('uq_playbook_definitions_project_name')
    .on(t.project, sql`lower(btrim(${t.name}))`),
  nameNotBlank: check(
    'playbook_definitions_name_not_blank',
    sql`length(btrim(${t.name})) > 0`,
  ),
  templateMetadata: check(
    'playbook_definitions_template_metadata_check',
    sql`(
      (${t.templateKey} IS NULL AND ${t.templateVersion} IS NULL)
      OR (
        ${t.templateKey} IS NOT NULL
        AND length(btrim(${t.templateKey})) > 0
        AND ${t.templateVersion} IS NOT NULL
        AND ${t.templateVersion} >= 1
      )
    )`,
  ),
  templateKeyUq: uniqueIndex('uq_playbook_definitions_project_template')
    .on(t.project, t.templateKey)
    .where(sql`${t.templateKey} IS NOT NULL`),
}));

export const playbookDefinitionVersions = pgTable('playbook_definition_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  definitionId: uuid('definition_id').notNull()
    .references(() => playbookDefinitions.id, { onDelete: 'cascade' }),
  versionNumber: integer('version_number').notNull(),
  graph: jsonb('graph').$type<PlaybookGraph>().notNull(),
  status: text('status').$type<PlaybookVersionStatus>().notNull().default('draft'),
  publishedBy: text('published_by').references(() => appUsers.oid, { onDelete: 'set null' }),
  publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  // Optimistic draft concurrency and auditable working-copy revision (FEAT-007).
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  definitionVersionUq: unique('uq_playbook_definition_versions_number')
    .on(t.definitionId, t.versionNumber),
  definitionIdx: index('idx_playbook_definition_versions_definition')
    .on(t.definitionId, t.versionNumber),
  statusIdx: index('idx_playbook_definition_versions_status').on(t.definitionId, t.status),
  // Database enforcement of exactly one retained draft per definition (FEAT-007 user decision).
  oneDraftUq: uniqueIndex('uq_playbook_definition_versions_one_draft')
    .on(t.definitionId)
    .where(sql`${t.status} = 'draft'`),
  statusCheck: check(
    'playbook_definition_versions_status_check',
    sql`${t.status} IN ('draft', 'published', 'deprecated', 'archived')`,
  ),
  versionNumberCheck: check(
    'playbook_definition_versions_version_number_check',
    sql`${t.versionNumber} >= 1`,
  ),
}));

export const playbookVersionLayouts = pgTable('playbook_version_layouts', {
  id: uuid('id').primaryKey().defaultRandom(),
  versionId: uuid('version_id')
    .notNull()
    .unique()
    .references(() => playbookDefinitionVersions.id, { onDelete: 'cascade' }),
  positions: jsonb('positions').$type<PlaybookLayoutPositions>().notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  versionIdx: index('idx_playbook_version_layouts_version').on(t.versionId),
}));

export const playbookRuns = pgTable('playbook_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').notNull(),
  // Restrict, not cascade: a version a run pinned is never hard-deleted, so BR-006 has a database
  // backstop even though version immutability itself is enforced in the service.
  definitionVersionId: uuid('definition_version_id').notNull()
    .references(() => playbookDefinitionVersions.id, { onDelete: 'restrict' }),
  initiatorUserId: text('initiator_user_id').notNull()
    .references(() => appUsers.oid, { onDelete: 'restrict' }),
  status: text('status').$type<PlaybookRunStatus>().notNull().default('running'),
  // Null for current-version resolution; required and trimmed for explicit older pins (TBI-031).
  versionPinReason: text('version_pin_reason'),
  // Canonical Playbook start bindings. Null for Phase 0/1 runs that had no bound artifact.
  runInput: jsonb('run_input').$type<Record<string, unknown>>(),
  // Incremented by the runtime, never computed on read — the structural guards that read them are
  // synchronous, and an aggregate scan in an admission check is how guards get disabled.
  stepCount: integer('step_count').notNull().default(0),
  agentStepCount: integer('agent_step_count').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  projectStartedIdx: index('idx_playbook_runs_project_started').on(t.project, t.startedAt),
  projectStatusIdx: index('idx_playbook_runs_project_status').on(t.project, t.status),
  definitionVersionIdx: index('idx_playbook_runs_definition_version').on(t.definitionVersionId),
  statusCheck: check(
    'playbook_runs_status_check',
    sql`${t.status} IN ('running', 'suspended', 'completed', 'cancelled', 'failed', 'expired')`,
  ),
  stepCountCheck: check('playbook_runs_step_count_check', sql`${t.stepCount} >= 0`),
  agentStepCountCheck: check('playbook_runs_agent_step_count_check', sql`${t.agentStepCount} >= 0`),
}));

export const playbookStepRuns = pgTable('playbook_step_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => playbookRuns.id, { onDelete: 'cascade' }),
  // The node id inside the pinned version's graph, which is jsonb — so this is not a foreign key.
  stepId: text('step_id').notNull(),
  stepType: text('step_type').notNull(),
  status: text('status').$type<PlaybookStepRunStatus>().notNull().default('pending'),
  // Null for approval-gate and notify steps, which correlate to no agent run.
  agentRunId: text('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  resumeToken: text('resume_token'),
  inputInline: jsonb('input_inline').$type<Record<string, unknown>>(),
  gatePoolKey: text('gate_pool_key').$type<ReviewerDocumentType>(),
  gateApprovalMode: text('gate_approval_mode').$type<ApprovalMode>(),
  outputInline: jsonb('output_inline').$type<Record<string, unknown>>(),
  outputBlobRef: jsonb('output_blob_ref').$type<PlaybookStepBlobRef>(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  runStepUq: unique('uq_playbook_step_runs_run_step').on(t.runId, t.stepId),
  runIdx: index('idx_playbook_step_runs_run').on(t.runId, t.createdAt),
  // Partial over open statuses so a reconciliation pass costs time proportional to outstanding
  // suspensions rather than to all run history.
  expiresAtIdx: index('idx_playbook_step_runs_expires_at')
    .on(t.expiresAt)
    .where(sql`${t.expiresAt} IS NOT NULL AND ${t.status} IN ('pending', 'running', 'suspended')`),
  agentRunIdx: index('idx_playbook_step_runs_agent_run')
    .on(t.agentRunId)
    .where(sql`${t.agentRunId} IS NOT NULL`),
  statusCheck: check(
    'playbook_step_runs_status_check',
    sql`${t.status} IN ('pending', 'running', 'suspended', 'completed', 'failed', 'failed_retryable', 'cancelled', 'expired')`,
  ),
}));

export const playbookGateApprovers = pgTable('playbook_gate_approvers', {
  id: uuid('id').primaryKey().defaultRandom(),
  stepRunId: uuid('step_run_id').notNull()
    .references(() => playbookStepRuns.id, { onDelete: 'cascade' }),
  approverUserId: text('approver_user_id').notNull()
    .references(() => appUsers.oid, { onDelete: 'restrict' }),
  sourceGroupIds: jsonb('source_group_ids').$type<string[]>().notNull().default([]),
  decision: text('decision').$type<'approved' | 'rejected'>(),
  comment: text('comment'),
  decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  stepUserUq: unique('uq_playbook_gate_approvers_step_user').on(t.stepRunId, t.approverUserId),
  userDecisionIdx: index('idx_playbook_gate_approvers_user_decision')
    .on(t.approverUserId, t.decision),
  stepIdx: index('idx_playbook_gate_approvers_step').on(t.stepRunId),
}));

// Relations exist so the projection can load a run with its steps and pinned version in one
// round trip through db.query.*, per .cursor/rules/postgresql-db.mdc.

export const playbookDefinitionsRelations = relations(playbookDefinitions, ({ many }) => ({
  versions: many(playbookDefinitionVersions),
}));

export const playbookDefinitionVersionsRelations = relations(
  playbookDefinitionVersions,
  ({ one, many }) => ({
    definition: one(playbookDefinitions, {
      fields: [playbookDefinitionVersions.definitionId],
      references: [playbookDefinitions.id],
    }),
    layout: one(playbookVersionLayouts, {
      fields: [playbookDefinitionVersions.id],
      references: [playbookVersionLayouts.versionId],
    }),
    runs: many(playbookRuns),
  }),
);

export const playbookVersionLayoutsRelations = relations(playbookVersionLayouts, ({ one }) => ({
  version: one(playbookDefinitionVersions, {
    fields: [playbookVersionLayouts.versionId],
    references: [playbookDefinitionVersions.id],
  }),
}));

export const playbookRunsRelations = relations(playbookRuns, ({ one, many }) => ({
  definitionVersion: one(playbookDefinitionVersions, {
    fields: [playbookRuns.definitionVersionId],
    references: [playbookDefinitionVersions.id],
  }),
  steps: many(playbookStepRuns),
  interviews: many(interviews),
}));

export const playbookStepRunsRelations = relations(playbookStepRuns, ({ one, many }) => ({
  run: one(playbookRuns, {
    fields: [playbookStepRuns.runId],
    references: [playbookRuns.id],
  }),
  gateApprovers: many(playbookGateApprovers),
  interviews: many(interviews),
}));

export const playbookGateApproversRelations = relations(playbookGateApprovers, ({ one }) => ({
  stepRun: one(playbookStepRuns, {
    fields: [playbookGateApprovers.stepRunId],
    references: [playbookStepRuns.id],
  }),
}));

export const mcpServers = pgTable('mcp_servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').notNull(),
  name: text('name').notNull(),
  provider: text('provider').notNull(),
  status: text('status').notNull().default('untested'),
  credentialCiphertext: text('credential_ciphertext').notNull(),
  credentialIv: text('credential_iv').notNull(),
  credentialAuthTag: text('credential_auth_tag').notNull(),
  credentialHint: text('credential_hint').notNull(),
  baseUrl: text('base_url'),
  operations: jsonb('operations').$type<McpServerOperation[]>().notNull().default([]),
  allowedUserIds: jsonb('allowed_user_ids').$type<string[]>().notNull().default([]),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  lastTestedAt: timestamp('last_tested_at', { withTimezone: true, mode: 'string' }),
}, (t) => ({
  projectIdx: index('idx_mcp_servers_project').on(t.project),
}));

export const workflowEvaluationDefinitions = pgTable('workflow_evaluation_definitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  processKey: text('process_key').notNull(),
  stageKey: text('stage_key').notNull(),
  evaluatorKey: text('evaluator_key').notNull(),
  benchmarkKey: text('benchmark_key').notNull(),
  version: integer('version').notNull(),
  rubric: jsonb('rubric').$type<WorkflowEvaluationRubric>().notNull(),
  promptfooSuiteRef: text('promptfoo_suite_ref').notNull(),
  judgeOutputSchema: jsonb('judge_output_schema').$type<Record<string, unknown>>().notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  versionUq: unique('uq_workflow_evaluation_definitions_version')
    .on(t.processKey, t.stageKey, t.evaluatorKey, t.benchmarkKey, t.version),
  oneActiveUq: uniqueIndex('uq_workflow_evaluation_definitions_one_active')
    .on(t.processKey, t.stageKey, t.evaluatorKey, t.benchmarkKey)
    .where(sql`${t.active} = true`),
  versionCheck: check(
    'workflow_evaluation_definitions_version_check',
    sql`${t.version} >= 1`,
  ),
  suiteRefCheck: check(
    'workflow_evaluation_definitions_suite_ref_check',
    sql`length(btrim(${t.promptfooSuiteRef})) > 0`,
  ),
}));

export const workflowEvaluationEvents = pgTable('workflow_evaluation_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').notNull(),
  definitionId: uuid('definition_id').notNull()
    .references(() => workflowEvaluationDefinitions.id, { onDelete: 'restrict' }),
  subjectType: text('subject_type').$type<WorkflowEvaluationSubjectType>().notNull(),
  subjectId: uuid('subject_id').notNull(),
  stageKey: text('stage_key').notNull(),
  phaseIndex: smallint('phase_index'),
  reviewerUserId: text('reviewer_user_id').notNull()
    .references(() => appUsers.oid, { onDelete: 'restrict' }),
  reviewerRoleKey: text('reviewer_role_key').notNull(),
  reviewerRoleLabel: text('reviewer_role_label').notNull(),
  skillPath: text('skill_path'),
  skillVersion: text('skill_version'),
  model: text('model'),
  interviewId: uuid('interview_id'),
  prdId: uuid('prd_id'),
  artifactHash: text('artifact_hash').notNull(),
  criteriaScores: jsonb('criteria_scores').$type<WorkflowEvaluationCriteriaScores>().notNull(),
  outcome: text('outcome').$type<WorkflowEvaluationOutcome>().notNull(),
  reasonCodes: jsonb('reason_codes').$type<WorkflowEvaluationReasonCode[]>().notNull().default([]),
  comment: text('comment'),
  correctedArtifactText: text('corrected_artifact_text'),
  correctedArtifactBlobRef: jsonb('corrected_artifact_blob_ref').$type<AiRunBlobRef>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  subjectHistoryIdx: index('idx_workflow_evaluation_events_subject_history')
    .on(t.project, t.subjectType, t.subjectId, t.createdAt),
  artifactIdx: index('idx_workflow_evaluation_events_artifact')
    .on(t.project, t.subjectType, t.subjectId, t.artifactHash),
  projectCreatedIdx: index('idx_workflow_evaluation_events_project_created')
    .on(t.project, t.createdAt),
  lineageIdx: index('idx_workflow_evaluation_events_lineage')
    .on(t.skillPath, t.skillVersion),
  modelIdx: index('idx_workflow_evaluation_events_model').on(t.model),
  interviewIdx: index('idx_workflow_evaluation_events_interview')
    .on(t.interviewId)
    .where(sql`${t.interviewId} IS NOT NULL`),
  prdIdx: index('idx_workflow_evaluation_events_prd')
    .on(t.prdId)
    .where(sql`${t.prdId} IS NOT NULL`),
  subjectTypeCheck: check(
    'workflow_evaluation_events_subject_type_check',
    sql`${t.subjectType} IN ('interview_phase', 'prd')`,
  ),
  outcomeCheck: check(
    'workflow_evaluation_events_outcome_check',
    sql`${t.outcome} IN ('accept_unchanged', 'accept_after_edits', 'regenerate', 'reject')`,
  ),
  subjectCoherenceCheck: check(
    'workflow_evaluation_events_subject_coherence_check',
    sql`(
      (${t.subjectType} = 'prd' AND ${t.phaseIndex} IS NULL AND ${t.prdId} = ${t.subjectId})
      OR (
        ${t.subjectType} = 'interview_phase'
        AND ${t.phaseIndex} BETWEEN 1 AND 3
        AND ${t.interviewId} = ${t.subjectId}
      )
    )`,
  ),
  artifactHashCheck: check(
    'workflow_evaluation_events_artifact_hash_check',
    sql`${t.artifactHash} ~ '^[0-9a-f]{64}$'`,
  ),
  roleNotBlankCheck: check(
    'workflow_evaluation_events_role_not_blank_check',
    sql`length(btrim(${t.reviewerRoleKey})) > 0 AND length(btrim(${t.reviewerRoleLabel})) > 0`,
  ),
  correctionCheck: check(
    'workflow_evaluation_events_correction_check',
    sql`${t.correctedArtifactText} IS NULL OR ${t.correctedArtifactBlobRef} IS NULL`,
  ),
  criteriaScoresCheck: check(
    'workflow_evaluation_events_criteria_scores_check',
    sql`jsonb_typeof(${t.criteriaScores}) = 'object'`,
  ),
  reasonCodesCheck: check(
    'workflow_evaluation_events_reason_codes_check',
    sql`jsonb_typeof(${t.reasonCodes}) = 'array'`,
  ),
}));

export const workflowEvaluationJobs = pgTable('workflow_evaluation_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull()
    .references(() => workflowEvaluationEvents.id, { onDelete: 'restrict' }),
  evaluatorKey: text('evaluator_key').$type<WorkflowEvaluationJobEvaluator>().notNull(),
  status: text('status').$type<WorkflowEvaluationJobStatus>().notNull().default('pending'),
  runId: text('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  specificationHash: text('specification_hash'),
  summary: jsonb('summary').$type<Record<string, unknown>>(),
  resultBlobRefs: jsonb('result_blob_refs').$type<WorkflowEvaluationJobResultBlobRefs>(),
  errorDetail: text('error_detail'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  eventEvaluatorUq: unique('uq_workflow_evaluation_jobs_event_evaluator')
    .on(t.eventId, t.evaluatorKey),
  openIdx: index('idx_workflow_evaluation_jobs_open')
    .on(t.status)
    .where(sql`${t.status} IN ('pending', 'running')`),
  evaluatorCheck: check(
    'workflow_evaluation_jobs_evaluator_check',
    sql`${t.evaluatorKey} IN ('promptfoo', 'llm_judge')`,
  ),
  statusCheck: check(
    'workflow_evaluation_jobs_status_check',
    sql`${t.status} IN ('pending', 'running', 'ready', 'failed')`,
  ),
}));

export const workflowEvaluationDefinitionsRelations = relations(
  workflowEvaluationDefinitions,
  ({ many }) => ({
    events: many(workflowEvaluationEvents),
  }),
);

export const workflowEvaluationEventsRelations = relations(
  workflowEvaluationEvents,
  ({ one, many }) => ({
    definition: one(workflowEvaluationDefinitions, {
      fields: [workflowEvaluationEvents.definitionId],
      references: [workflowEvaluationDefinitions.id],
    }),
    jobs: many(workflowEvaluationJobs),
  }),
);

export const workflowEvaluationJobsRelations = relations(workflowEvaluationJobs, ({ one }) => ({
  event: one(workflowEvaluationEvents, {
    fields: [workflowEvaluationJobs.eventId],
    references: [workflowEvaluationEvents.id],
  }),
}));

const buildTimestamp = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' as const });

export const buildRuns = pgTable('build_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').notNull(),
  repository: text('repository').notNull(),
  requestedByUserId: text('requested_by_user_id').notNull().references(() => appUsers.oid, { onDelete: 'restrict' }),
  clientRequestId: text('client_request_id').notNull(),
  modelOverride: text('model_override'),
  prompt: text('prompt').notNull(),
  playbookRunId: uuid('playbook_run_id').references(() => playbookRuns.id, { onDelete: 'restrict' }),
  playbookStepRunId: uuid('playbook_step_run_id').references(() => playbookStepRuns.id, { onDelete: 'restrict' }),
  skillSettingsId: uuid('skill_settings_id').references(() => projectSkillSettings.id, { onDelete: 'set null' }),
  queuedAt: buildTimestamp('queued_at'),
  interviewId: uuid('interview_id').references(() => interviews.id, { onDelete: 'restrict' }),
  briefId: uuid('brief_id').references(() => interviewBriefs.id, { onDelete: 'restrict' }),
  status: text('status').$type<BuildRunStatus>().notNull().default('queued'),
  suspendReason: text('suspend_reason').$type<BuildSuspendReason>(),
  suspendedFromStatus: text('suspended_from_status').$type<BuildRunStatus>(),
  currentRevisionNumber: integer('current_revision_number').notNull().default(1),
  revisionsUsed: integer('revisions_used').notNull().default(0),
  revisionCap: integer('revision_cap').notNull().default(5),
  integrationBranch: text('integration_branch'),
  baseCommit: text('base_commit'),
  skillSnapshot: jsonb('skill_snapshot').$type<BuildSkillSnapshot>().notNull(),
  supportContacts: jsonb('support_contacts').$type<BuildSupportContact[]>().notNull(),
  qualityManifestSnapshot: jsonb('quality_manifest_snapshot').$type<BuildQualityManifestSnapshot>().notNull(),
  costCapUsd: numeric('cost_cap_usd', { precision: 12, scale: 4 }).notNull(),
  costUsedUsd: numeric('cost_used_usd', { precision: 12, scale: 4 }).notNull().default('0'),
  elapsedCapSeconds: integer('elapsed_cap_seconds').notNull(),
  parallelismCap: smallint('parallelism_cap').notNull(),
  parallelismUsed: smallint('parallelism_used').notNull().default(0),
  pullRequestUrl: text('pull_request_url'),
  pullRequestId: integer('pull_request_id'),
  acceptedRevisionNumber: integer('accepted_revision_number'),
  integrationBranchDeletedAt: buildTimestamp('integration_branch_deleted_at'),
  startedAt: buildTimestamp('started_at'),
  endedAt: buildTimestamp('ended_at'),
  createdAt: buildTimestamp('created_at').notNull().defaultNow(),
  updatedAt: buildTimestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  projectCheck: check('build_runs_project_check', sql`char_length(${t.project}) >= 1 AND ${t.project} = btrim(${t.project})`),
  repositoryCheck: check('build_runs_repository_check', sql`char_length(${t.repository}) >= 1 AND ${t.repository} = btrim(${t.repository})`),
  clientRequestIdCheck: check('build_runs_client_request_id_check', sql`char_length(${t.clientRequestId}) BETWEEN 1 AND 128 AND ${t.clientRequestId} = btrim(${t.clientRequestId})`),
  promptCheck: check('build_runs_prompt_check', sql`char_length(btrim(${t.prompt})) >= 1`),
  statusCheck: check('build_runs_status_check', sql`${t.status} IN ('queued', 'intake', 'planning', 'building', 'checking', 'deploying', 'preview_ready', 'suspended', 'deployment_failed', 'needs_developer', 'accepted', 'cancelled', 'failed')`),
  suspendReasonCheck: check('build_runs_suspend_reason_check', sql`${t.suspendReason} IS NULL OR ${t.suspendReason} IN ('cost_cap', 'elapsed_cap', 'repair_cap', 'flag_disabled', 'permission_revoked', 'configuration', 'plan_invalid')`),
  suspendedFromStatusCheck: check('build_runs_suspended_from_status_check', sql`${t.suspendedFromStatus} IS NULL OR ${t.suspendedFromStatus} IN ('queued', 'intake', 'planning', 'building', 'checking', 'deploying')`),
  suspendedCoherenceCheck: check('build_runs_suspended_coherence_check', sql`(${t.status} = 'suspended') = (${t.suspendReason} IS NOT NULL AND ${t.suspendedFromStatus} IS NOT NULL)`),
  revisionCounterCheck: check('build_runs_revision_counter_check', sql`${t.revisionCap} >= 1 AND ${t.currentRevisionNumber} >= 1 AND ${t.revisionsUsed} >= 0 AND ${t.revisionsUsed} <= ${t.revisionCap} AND ${t.currentRevisionNumber} = ${t.revisionsUsed} + 1`),
  integrationBranchCheck: check('build_runs_integration_branch_check', sql`${t.integrationBranch} IS NULL OR ${t.integrationBranch} = 'apex/build/' || ${t.id}::text`),
  baseCommitCheck: check('build_runs_base_commit_check', sql`${t.baseCommit} IS NULL OR ${t.baseCommit} ~ '^[0-9a-f]{40}$'`),
  skillSnapshotCheck: check('build_runs_skill_snapshot_check', sql`jsonb_typeof(${t.skillSnapshot}) = 'object'`),
  supportContactsCheck: check('build_runs_support_contacts_check', sql`jsonb_typeof(${t.supportContacts}) = 'array' AND jsonb_array_length(${t.supportContacts}) >= 1`),
  qualityManifestCheck: check('build_runs_quality_manifest_snapshot_check', sql`jsonb_typeof(${t.qualityManifestSnapshot}) = 'object'`),
  costCapCheck: check('build_runs_cost_cap_check', sql`${t.costCapUsd} > 0`),
  costUsedCheck: check('build_runs_cost_used_check', sql`${t.costUsedUsd} >= 0`),
  elapsedCapCheck: check('build_runs_elapsed_cap_check', sql`${t.elapsedCapSeconds} > 0`),
  parallelismCapCheck: check('build_runs_parallelism_cap_check', sql`${t.parallelismCap} BETWEEN 1 AND 6`),
  parallelismUsedCheck: check('build_runs_parallelism_used_check', sql`${t.parallelismUsed} BETWEEN 0 AND ${t.parallelismCap}`),
  acceptedPrCheck: check('build_runs_accepted_pr_check', sql`${t.status} <> 'accepted' OR (${t.pullRequestUrl} IS NOT NULL AND ${t.acceptedRevisionNumber} IS NOT NULL)`),
  terminalEndedAtCheck: check('build_runs_terminal_ended_at_check', sql`(${t.status} IN ('accepted', 'cancelled', 'failed')) = (${t.endedAt} IS NOT NULL)`),
  playbookRunUq: uniqueIndex('uq_build_runs_playbook_run').on(t.playbookRunId),
  clientRequestUq: uniqueIndex('uq_build_runs_client_request').on(t.project, t.requestedByUserId, t.clientRequestId),
  projectCreatedIdx: index('idx_build_runs_project_created').on(t.project, t.createdAt),
  slotIdx: index('idx_build_runs_slot').on(t.project, t.status).where(sql`${t.status} IN ('intake', 'planning', 'building', 'checking', 'deploying')`),
  queueIdx: index('idx_build_runs_queue').on(t.createdAt).where(sql`${t.status} = 'queued'`),
  queuedAtIdx: index('idx_build_runs_queued_at').on(t.project, t.queuedAt).where(sql`${t.status} = 'queued'`),
  cancelCleanupIdx: index('idx_build_runs_cancel_cleanup').on(t.endedAt).where(sql`${t.status} = 'cancelled' AND ${t.integrationBranchDeletedAt} IS NULL`),
  retentionIdx: index('idx_build_runs_retention').on(t.endedAt).where(sql`${t.endedAt} IS NOT NULL`),
  interviewIdx: index('idx_build_runs_interview').on(t.interviewId).where(sql`${t.interviewId} IS NOT NULL`),
}));

export const buildRevisions = pgTable('build_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  buildRunId: uuid('build_run_id').notNull().references(() => buildRuns.id, { onDelete: 'restrict' }),
  revisionNumber: integer('revision_number').notNull(),
  feedback: text('feedback'),
  briefVersion: integer('brief_version'),
  requirements: jsonb('requirements').$type<BuildRequirement[]>().notNull().default([]),
  assumptions: jsonb('assumptions').$type<string[]>().notNull().default([]),
  exclusions: jsonb('exclusions').$type<string[]>().notNull().default([]),
  riskDecisions: jsonb('risk_decisions').$type<BuildRiskDecision[]>().notNull().default([]),
  classification: text('classification').$type<BuildClassification>(),
  plan: jsonb('plan').$type<Record<string, unknown>>(),
  planValidation: jsonb('plan_validation').$type<{ status: 'pass' | 'fail'; violations: unknown[] }>(),
  contextNotesPath: text('context_notes_path'),
  repairAttempts: integer('repair_attempts').notNull().default(0),
  elapsedSecondsUsed: integer('elapsed_seconds_used').notNull().default(0),
  validatedCommit: text('validated_commit'),
  pipelineRunId: text('pipeline_run_id'),
  deploymentStatus: text('deployment_status').$type<BuildDeploymentStatus>().notNull().default('not_started'),
  deploymentQueuedAt: buildTimestamp('deployment_queued_at'),
  deployedAt: buildTimestamp('deployed_at'),
  deploymentFailedStage: text('deployment_failed_stage'),
  deploymentPipelineUrl: text('deployment_pipeline_url'),
  previewUrl: text('preview_url'),
  createdAt: buildTimestamp('created_at').notNull().defaultNow(),
  updatedAt: buildTimestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  revisionNumberCheck: check('build_revisions_revision_number_check', sql`${t.revisionNumber} >= 1`),
  requirementsCheck: check('build_revisions_requirements_check', sql`jsonb_typeof(${t.requirements}) = 'array'`),
  assumptionsCheck: check('build_revisions_assumptions_check', sql`jsonb_typeof(${t.assumptions}) = 'array'`),
  exclusionsCheck: check('build_revisions_exclusions_check', sql`jsonb_typeof(${t.exclusions}) = 'array'`),
  riskDecisionsCheck: check('build_revisions_risk_decisions_check', sql`jsonb_typeof(${t.riskDecisions}) = 'array'`),
  classificationCheck: check('build_revisions_classification_check', sql`${t.classification} IS NULL OR ${t.classification} IN ('small', 'full')`),
  planCheck: check('build_revisions_plan_check', sql`${t.plan} IS NULL OR jsonb_typeof(${t.plan}) = 'object'`),
  planValidationCheck: check('build_revisions_plan_validation_check', sql`${t.planValidation} IS NULL OR jsonb_typeof(${t.planValidation}) = 'object'`),
  planBriefCheck: check('build_revisions_plan_brief_check', sql`${t.plan} IS NULL OR ${t.briefVersion} IS NOT NULL`),
  repairAttemptsCheck: check('build_revisions_repair_attempts_check', sql`${t.repairAttempts} BETWEEN 0 AND 2`),
  elapsedSecondsCheck: check('build_revisions_elapsed_seconds_check', sql`${t.elapsedSecondsUsed} >= 0`),
  validatedCommitCheck: check('build_revisions_validated_commit_check', sql`${t.validatedCommit} IS NULL OR ${t.validatedCommit} ~ '^[0-9a-f]{40}$'`),
  deploymentStatusCheck: check('build_revisions_deployment_status_check', sql`${t.deploymentStatus} IN ('not_started', 'queued', 'deploying', 'succeeded', 'failed')`),
  deploymentCoherenceCheck: check('build_revisions_deployment_coherence_check', sql`(${t.deploymentStatus} NOT IN ('queued', 'deploying', 'succeeded') OR ${t.validatedCommit} IS NOT NULL) AND (${t.deploymentStatus} <> 'succeeded' OR ${t.previewUrl} IS NOT NULL)`),
  runNumberUq: uniqueIndex('uq_build_revisions_run_number').on(t.buildRunId, t.revisionNumber),
  pipelineRunUq: uniqueIndex('uq_build_revisions_pipeline_run').on(t.pipelineRunId).where(sql`${t.pipelineRunId} IS NOT NULL`),
  waitingDeployIdx: index('idx_build_revisions_waiting_deploy').on(t.deploymentQueuedAt, t.id).where(sql`${t.deploymentStatus} = 'queued'`),
  deployingIdx: index('idx_build_revisions_deploying').on(t.updatedAt).where(sql`${t.deploymentStatus} = 'deploying'`),
}));

export const buildTasks = pgTable('build_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  buildRevisionId: uuid('build_revision_id').notNull().references(() => buildRevisions.id, { onDelete: 'restrict' }),
  taskKey: text('task_key').notNull(),
  role: text('role').$type<BuildTaskRole>().notNull(),
  dependsOn: jsonb('depends_on').$type<string[]>().notNull().default([]),
  ownedFiles: jsonb('owned_files').$type<string[]>().notNull().default([]),
  covers: jsonb('covers').$type<string[]>().notNull().default([]),
  reuse: jsonb('reuse').$type<BuildReuseEntry[]>().notNull().default([]),
  runMode: text('run_mode').$type<BuildTaskRunMode>().notNull(),
  chainHeadKey: text('chain_head_key'),
  branchName: text('branch_name'),
  status: text('status').$type<BuildTaskStatus>().notNull().default('pending'),
  attempt: integer('attempt').notNull().default(1),
  omittedReason: text('omitted_reason'),
  mergePullRequestId: integer('merge_pull_request_id'),
  mergeCommit: text('merge_commit'),
  startedAt: buildTimestamp('started_at'),
  completedAt: buildTimestamp('completed_at'),
  createdAt: buildTimestamp('created_at').notNull().defaultNow(),
  updatedAt: buildTimestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  taskKeyCheck: check('build_tasks_task_key_check', sql`${t.taskKey} ~ '^[a-z][a-z0-9-]{0,39}$'`),
  roleCheck: check('build_tasks_role_check', sql`${t.role} IN ('planner', 'implementer', 'qa', 'check', 'sync')`),
  dependsOnCheck: check('build_tasks_depends_on_check', sql`jsonb_typeof(${t.dependsOn}) = 'array'`),
  ownedFilesCheck: check('build_tasks_owned_files_check', sql`jsonb_typeof(${t.ownedFiles}) = 'array'`),
  coversCheck: check('build_tasks_covers_check', sql`jsonb_typeof(${t.covers}) = 'array'`),
  reuseCheck: check('build_tasks_reuse_check', sql`jsonb_typeof(${t.reuse}) = 'array'`),
  runModeCheck: check('build_tasks_run_mode_check', sql`${t.runMode} IN ('own_agent', 'chain')`),
  chainHeadKeyCheck: check('build_tasks_chain_head_key_check', sql`${t.chainHeadKey} IS NULL OR ${t.chainHeadKey} ~ '^[a-z][a-z0-9-]{0,39}$'`),
  chainHeadCoherenceCheck: check('build_tasks_chain_head_coherence_check', sql`(${t.runMode} = 'own_agent' AND ${t.chainHeadKey} IS NULL) OR (${t.runMode} = 'chain' AND ${t.chainHeadKey} IS NOT NULL)`),
  statusCheck: check('build_tasks_status_check', sql`${t.status} IN ('pending', 'ready', 'running', 'merged', 'failed', 'omitted')`),
  attemptCheck: check('build_tasks_attempt_check', sql`${t.attempt} >= 1`),
  omittedReasonCheck: check('build_tasks_omitted_reason_check', sql`(${t.status} = 'omitted') = (${t.omittedReason} IS NOT NULL)`),
  revisionKeyUq: uniqueIndex('uq_build_tasks_revision_key').on(t.buildRevisionId, t.taskKey),
  revisionStatusIdx: index('idx_build_tasks_revision_status').on(t.buildRevisionId, t.status),
  branchNameUq: uniqueIndex('uq_build_tasks_branch_name').on(t.branchName).where(sql`${t.branchName} IS NOT NULL`),
  chainHeadIdx: index('idx_build_tasks_chain_head').on(t.buildRevisionId, t.chainHeadKey).where(sql`${t.chainHeadKey} IS NOT NULL`),
}));

export const buildVerificationRows = pgTable('build_verification_rows', {
  id: uuid('id').primaryKey().defaultRandom(),
  buildRevisionId: uuid('build_revision_id').notNull().references(() => buildRevisions.id, { onDelete: 'restrict' }),
  requirementId: text('requirement_id').notNull(),
  kind: text('kind').$type<BuildVerificationKind>().notNull(),
  testTier: text('test_tier').$type<BuildTestTier>(),
  testRefs: jsonb('test_refs').$type<BuildTestRef[]>().notNull().default([]),
  redEvidence: jsonb('red_evidence').$type<BuildTestEvidence>(),
  greenEvidence: jsonb('green_evidence').$type<BuildTestEvidence>(),
  evidenceBlobRef: jsonb('evidence_blob_ref').$type<ArtifactRef>(),
  status: text('status').$type<BuildVerificationStatus>().notNull().default('pending'),
  deferralReason: text('deferral_reason'),
  carriedFromRevisionNumber: integer('carried_from_revision_number'),
  createdAt: buildTimestamp('created_at').notNull().defaultNow(),
  updatedAt: buildTimestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  kindCheck: check('build_verification_rows_kind_check', sql`${t.kind} IN ('ac', 'dod', 'br', 'nfr', 'risk_decision')`),
  requirementPrefixCheck: check('build_verification_rows_requirement_prefix_check', sql`(${t.kind} = 'ac' AND ${t.requirementId} ~ '^AC-[1-9][0-9]*$') OR (${t.kind} = 'dod' AND ${t.requirementId} ~ '^DOD-[1-9][0-9]*$') OR (${t.kind} = 'br' AND ${t.requirementId} ~ '^BR-[1-9][0-9]*$') OR (${t.kind} = 'nfr' AND ${t.requirementId} ~ '^NFR-[1-9][0-9]*$') OR (${t.kind} = 'risk_decision' AND ${t.requirementId} ~ '^RD-[1-9][0-9]*$')`),
  testTierCheck: check('build_verification_rows_test_tier_check', sql`${t.testTier} IS NULL OR ${t.testTier} IN ('unit', 'integration', 'e2e')`),
  testRefsCheck: check('build_verification_rows_test_refs_check', sql`jsonb_typeof(${t.testRefs}) = 'array'`),
  redEvidenceCheck: check('build_verification_rows_red_evidence_check', sql`${t.redEvidence} IS NULL OR jsonb_typeof(${t.redEvidence}) = 'object'`),
  greenEvidenceCheck: check('build_verification_rows_green_evidence_check', sql`${t.greenEvidence} IS NULL OR jsonb_typeof(${t.greenEvidence}) = 'object'`),
  evidenceBlobRefCheck: check('build_verification_rows_evidence_blob_ref_check', sql`${t.evidenceBlobRef} IS NULL OR jsonb_typeof(${t.evidenceBlobRef}) = 'object'`),
  statusCheck: check('build_verification_rows_status_check', sql`${t.status} IN ('pending', 'pass', 'fail', 'deferred', 'retired')`),
  deferralCheck: check('build_verification_rows_deferral_check', sql`(${t.status} = 'deferred') = (${t.deferralReason} IS NOT NULL)`),
  passEvidenceCheck: check('build_verification_rows_pass_evidence_check', sql`${t.status} <> 'pass' OR (${t.redEvidence} IS NOT NULL AND ${t.greenEvidence} IS NOT NULL AND jsonb_typeof(${t.testRefs}) = 'array' AND jsonb_array_length(${t.testRefs}) >= 1)`),
  revisionRequirementUq: uniqueIndex('uq_build_verification_rows_revision_requirement').on(t.buildRevisionId, t.requirementId),
  revisionStatusIdx: index('idx_build_verification_rows_revision_status').on(t.buildRevisionId, t.status),
}));

export const buildPreviewLeases = pgTable('build_preview_leases', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').notNull(),
  repository: text('repository').notNull(),
  buildRunId: uuid('build_run_id').notNull().references(() => buildRuns.id, { onDelete: 'cascade' }),
  buildRevisionId: uuid('build_revision_id').notNull().references(() => buildRevisions.id, { onDelete: 'restrict' }),
  grantedAt: buildTimestamp('granted_at').notNull().defaultNow(),
  expiresAt: buildTimestamp('expires_at').notNull(),
}, (t) => ({
  projectCheck: check('build_preview_leases_project_check', sql`char_length(${t.project}) >= 1 AND ${t.project} = btrim(${t.project})`),
  repositoryCheck: check('build_preview_leases_repository_check', sql`char_length(${t.repository}) >= 1 AND ${t.repository} = btrim(${t.repository})`),
  expiresCheck: check('build_preview_leases_expires_check', sql`${t.expiresAt} > ${t.grantedAt}`),
  projectRepositoryUq: uniqueIndex('uq_build_preview_leases_project_repository').on(t.project, t.repository),
  runUq: uniqueIndex('uq_build_preview_leases_run').on(t.buildRunId),
  expiresIdx: index('idx_build_preview_leases_expires').on(t.expiresAt),
}));

export const buildEvents = pgTable('build_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  ordinal: bigserial('ordinal', { mode: 'number' }).notNull(),
  buildRunId: uuid('build_run_id').notNull().references(() => buildRuns.id, { onDelete: 'restrict' }),
  buildRevisionId: uuid('build_revision_id').references(() => buildRevisions.id, { onDelete: 'restrict' }),
  eventType: text('event_type').notNull(),
  severity: text('severity').$type<BuildEventSeverity>().notNull().default('info'),
  message: text('message').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  correlationKind: text('correlation_kind').$type<BuildCorrelationKind>(),
  correlationId: text('correlation_id'),
  actorUserId: text('actor_user_id').references(() => appUsers.oid, { onDelete: 'restrict' }),
  dedupeKey: text('dedupe_key'),
  createdAt: buildTimestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  eventTypeCheck: check('build_events_event_type_check', sql`${t.eventType} ~ '^[a-z][a-z0-9_.]{0,63}$'`),
  severityCheck: check('build_events_severity_check', sql`${t.severity} IN ('info', 'warn', 'error')`),
  messageCheck: check('build_events_message_check', sql`char_length(${t.message}) BETWEEN 1 AND 8000`),
  detailCheck: check('build_events_detail_check', sql`${t.detail} IS NULL OR jsonb_typeof(${t.detail}) = 'object'`),
  correlationKindCheck: check('build_events_correlation_kind_check', sql`${t.correlationKind} IS NULL OR ${t.correlationKind} IN ('agent_run', 'pipeline_run', 'pull_request', 'commit')`),
  correlationPairCheck: check('build_events_correlation_pair_check', sql`(${t.correlationKind} IS NULL) = (${t.correlationId} IS NULL)`),
  ordinalUq: uniqueIndex('uq_build_events_ordinal').on(t.ordinal),
  runOrdinalIdx: index('idx_build_events_run_ordinal').on(t.buildRunId, t.ordinal),
  dedupeUq: uniqueIndex('uq_build_events_dedupe').on(t.buildRunId, t.dedupeKey).where(sql`${t.dedupeKey} IS NOT NULL`),
}));

export const buildRunsRelations = relations(buildRuns, ({ one, many }) => ({
  requester: one(appUsers, { fields: [buildRuns.requestedByUserId], references: [appUsers.oid] }),
  playbookRun: one(playbookRuns, { fields: [buildRuns.playbookRunId], references: [playbookRuns.id] }),
  playbookStepRun: one(playbookStepRuns, { fields: [buildRuns.playbookStepRunId], references: [playbookStepRuns.id] }),
  interview: one(interviews, { fields: [buildRuns.interviewId], references: [interviews.id] }),
  brief: one(interviewBriefs, { fields: [buildRuns.briefId], references: [interviewBriefs.id] }),
  revisions: many(buildRevisions),
  events: many(buildEvents),
}));

export const buildRevisionsRelations = relations(buildRevisions, ({ one, many }) => ({
  run: one(buildRuns, { fields: [buildRevisions.buildRunId], references: [buildRuns.id] }),
  tasks: many(buildTasks),
  verificationRows: many(buildVerificationRows),
  events: many(buildEvents),
}));

export const buildTasksRelations = relations(buildTasks, ({ one }) => ({
  revision: one(buildRevisions, { fields: [buildTasks.buildRevisionId], references: [buildRevisions.id] }),
}));

export const buildVerificationRowsRelations = relations(buildVerificationRows, ({ one }) => ({
  revision: one(buildRevisions, { fields: [buildVerificationRows.buildRevisionId], references: [buildRevisions.id] }),
}));

export const buildPreviewLeasesRelations = relations(buildPreviewLeases, ({ one }) => ({
  run: one(buildRuns, { fields: [buildPreviewLeases.buildRunId], references: [buildRuns.id] }),
  revision: one(buildRevisions, { fields: [buildPreviewLeases.buildRevisionId], references: [buildRevisions.id] }),
}));

export const buildEventsRelations = relations(buildEvents, ({ one }) => ({
  run: one(buildRuns, { fields: [buildEvents.buildRunId], references: [buildRuns.id] }),
  revision: one(buildRevisions, { fields: [buildEvents.buildRevisionId], references: [buildRevisions.id] }),
  actor: one(appUsers, { fields: [buildEvents.actorUserId], references: [appUsers.oid] }),
}));
