import { bigserial, boolean, check, date, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import type { RepoProvider, RepoRole, RunType } from '../../shared/types/runGrounding';
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
import type {
  AgentRunCancelState,
  AgentRunLane,
  AgentRunStatus,
  AgentRunTerminalReason,
  ExecutionSnapshot,
} from '../../shared/types/agentRunLifecycle';
import type { ContentSnapshot, DesignDocValidationOverride, PrdReadinessOverride, PrdValidationBaseline, TestCaseCoverageSummary, ValidationScorecard } from '../../shared/types/interview';
import type { DesignPrototypeHistoryEntry } from '../../shared/types/designPrototype';
import type { UiLabHistoryEntry } from '../../shared/types/uiLab';
import type { DevSessionSetupPhase } from '../../shared/types/devWorkbench';
import type { DesignPlanFeature, DesignPlanHistoryEntry } from '../../shared/types/designPlan';
import type { QuickSkillPill, QuickMcpPill, InterviewSkillOption, PrototypeEngine } from '../../shared/types/projectSettings';
import type { ApprovalMode, OwnerApprovalStatus } from '../../shared/types/approvals';
import type { MenuItemKey } from '../../shared/types/menuSettings';
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
  DiagramShareAccess,
  ExcalidrawScene,
} from '../../shared/types/diagram';
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
});

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
});

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
  prdOwnerId: text('prd_owner_id').references(() => appUsers.oid, { onDelete: 'set null' }),
  designDocOwnerId: text('design_doc_owner_id').references(() => appUsers.oid, { onDelete: 'set null' }),
  designPrototypeOwnerId: text('design_prototype_owner_id').references(() => appUsers.oid, { onDelete: 'set null' }),
  testCaseOwnerId: text('test_case_owner_id').references(() => appUsers.oid, { onDelete: 'set null' }),
  prdApproverIds: jsonb('prd_approver_ids').$type<string[]>(),
  designDocApproverIds: jsonb('design_doc_approver_ids').$type<string[]>(),
  designPrototypeApproverIds: jsonb('design_prototype_approver_ids').$type<string[]>(),
  testCaseApproverIds: jsonb('test_case_approver_ids').$type<string[]>(),
  skillSettingsId: uuid('skill_settings_id'),
  prototypeStageEnabled: boolean('prototype_stage_enabled').notNull().default(true),
  testCasesEnabled: boolean('test_cases_enabled').notNull().default(true),
  status: text('status').notNull().default('in_progress'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

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

export const adrs = pgTable('adrs', {
  id: uuid('id').primaryKey().defaultRandom(),
  chatThreadId: uuid('chat_thread_id').notNull().unique().references(() => chatThreads.id, { onDelete: 'cascade' }),
  adrAssistantThreadId: uuid('adr_assistant_thread_id').references(() => chatThreads.id, { onDelete: 'set null' }),
  authorId: text('author_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  reviewerIds: jsonb('reviewer_ids').$type<string[]>(),
  title: text('title').notNull().default('Untitled ADR'),
  project: text('project').notNull(),
  repo: text('repo').notNull(),
  model: text('model'),
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
  prds: many(prds),
  adrLinks: many(interviewAdrLinks),
  designModuleLinks: many(interviewDesignModuleLinks),
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
  interviewSkillPath: text('interview_skill_path'),
  prdSkillPath: text('prd_skill_path'),
  adrInterviewSkillPath: text('adr_interview_skill_path'),
  adrFinalizeSkillPath: text('adr_finalize_skill_path'),
  adrAssistantSkillPath: text('adr_assistant_skill_path'),
  designDocSkillPath: text('design_doc_skill_path'),
  designDocAssistantSkillPath: text('design_doc_assistant_skill_path'),
  designPrototypeSkillPath: text('design_prototype_skill_path'),
  testCaseSkillPath: text('test_case_skill_path'),
  interviewModel: text('interview_model'),
  prdModel: text('prd_model'),
  adrModel: text('adr_model'),
  designDocModel: text('design_doc_model'),
  designDocAssistantModel: text('design_doc_assistant_model'),
  designPrototypeModel: text('design_prototype_model'),
  testCaseModel: text('test_case_model'),
  designDocValidationSkillPath: text('design_doc_validation_skill_path'),
  designDocValidationModel: text('design_doc_validation_model'),
  prdAssistantSkillPath: text('prd_assistant_skill_path'),
  prdAssistantModel: text('prd_assistant_model'),
  prdValidationSkillPath: text('prd_validation_skill_path'),
  prdValidationModel: text('prd_validation_model'),
  defaultModel: text('default_model'),
  prdReviewBedrockModelId: text('prd_review_bedrock_model_id'),
  prdReviewBedrockMaxTokens: integer('prd_review_bedrock_max_tokens'),
  designPrototypeBedrockModelId: text('design_prototype_bedrock_model_id'),
  designPrototypeBedrockMaxTokens: integer('design_prototype_bedrock_max_tokens'),
  designPrototypeBedrockTimeoutMs: integer('design_prototype_bedrock_timeout_ms'),
  designPrototypeRegenBedrockModelId: text('design_prototype_regen_bedrock_model_id'),
  designPrototypeRegenBedrockMaxTokens: integer('design_prototype_regen_bedrock_max_tokens'),
  designPlanBedrockModelId: text('design_plan_bedrock_model_id'),
  designPlanBedrockMaxTokens: integer('design_plan_bedrock_max_tokens'),
  prdValidationScoreThreshold: integer('prd_validation_score_threshold'),
  designDocValidationScoreThreshold: integer('design_doc_validation_score_threshold'),
  uiLabBedrockModelId: text('ui_lab_bedrock_model_id'),
  uiLabBedrockMaxTokens: integer('ui_lab_bedrock_max_tokens'),
  uiLabBedrockTimeoutMs: integer('ui_lab_bedrock_timeout_ms'),
  uiLabRegenBedrockModelId: text('ui_lab_regen_bedrock_model_id'),
  uiLabRegenBedrockMaxTokens: integer('ui_lab_regen_bedrock_max_tokens'),
  uiLabBedrockTemperature: real('ui_lab_bedrock_temperature'),
  uiLabSkillPath: text('ui_lab_skill_path'),
  developmentSkillPath: text('development_skill_path'),
  developmentModel: text('development_model'),
  standupSkillPath: text('standup_skill_path'),
  standupModel: text('standup_model'),
  featureRequestSkillPath: text('feature_request_skill_path'),
  featureRequestModel: text('feature_request_model'),
  technicalSkillPath: text('technical_skill_path'),
  technicalModel: text('technical_model'),
  issueSkillPath: text('issue_skill_path'),
  issueModel: text('issue_model'),
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
  calendarAssistantSkillPath: text('calendar_assistant_skill_path'),
  calendarAssistantModel: text('calendar_assistant_model'),
  loadTestGenerationSkillPath: text('load_test_generation_skill_path'),
  loadTestGenerationModel: text('load_test_generation_model'),
  designModuleSkillPath: text('design_module_skill_path'),
  designModuleModel: text('design_module_model'),
  designModuleScopingSkillPath: text('design_module_scoping_skill_path'),
  designModuleScopingModel: text('design_module_scoping_model'),
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
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (t) => ({
  // Exactly one default repo config per project.
  oneDefaultPerProject: uniqueIndex('project_skill_settings_one_default_per_project')
    .on(t.project)
    .where(sql`is_default`),
  projectFriendlyName: unique('project_skill_settings_project_friendly_name_key').on(t.project, t.friendlyName),
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

export const uiLabDesignsRelations = relations(uiLabDesigns, ({ many }) => ({
  comments: many(uiLabComments),
}));

export const uiLabCommentsRelations = relations(uiLabComments, ({ one }) => ({
  design: one(uiLabDesigns, {
    fields: [uiLabComments.designId],
    references: [uiLabDesigns.id],
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
  executionSnapshot: jsonb('execution_snapshot').$type<ExecutionSnapshot>(),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  cancelState: text('cancel_state').$type<AgentRunCancelState>(),
  terminalReason: text('terminal_reason').$type<AgentRunTerminalReason>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  statusHeartbeatIdx: index('idx_agent_runs_status_heartbeat').on(t.status, t.heartbeatAt),
  statusLaneIdx: index('idx_agent_runs_status_lane').on(t.status, t.lane),
  projectStatusIdx: index('idx_agent_runs_project_status').on(t.projectId, t.status),
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
    sql`${t.lane} IS NULL OR ${t.lane} IN ('background', 'ai-runs-interactive')`,
  ),
  terminalReasonCheck: check(
    'agent_runs_terminal_reason_check',
    sql`${t.terminalReason} IS NULL OR ${t.terminalReason} IN ('worker_lost', 'progress_timeout', 'queue_ttl', 'forced_cancel')`,
  ),
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
  skillTargets:        jsonb('skill_targets').$type<Record<string, string[]>>().notNull().default({}),
  manifestSnapshot:    jsonb('manifest_snapshot').$type<FoundationSkillArtifactManifest>(),
  releaseNotes:        text('release_notes'),
  breakingChanges:     text('breaking_changes'),
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
