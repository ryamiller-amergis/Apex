import { boolean, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import type {
  PageManifestEntry,
  PdfConversionStatus,
  PdfFileMetadata,
  PdfSessionStatus,
} from '../../shared/types/pdf';
import type { ChatThreadKickoff } from '../../shared/types/chat';
import type { ContentSnapshot, PrdValidationBaseline, TestCaseCoverageSummary, ValidationScorecard } from '../../shared/types/interview';
import type { DesignPrototypeHistoryEntry } from '../../shared/types/designPrototype';
import type { UiLabHistoryEntry } from '../../shared/types/uiLab';
import type { DesignPlanFeature, DesignPlanHistoryEntry } from '../../shared/types/designPlan';
import type { QuickSkillPill, QuickMcpPill, InterviewSkillOption } from '../../shared/types/projectSettings';
import type { ApprovalMode, OwnerApprovalStatus } from '../../shared/types/approvals';
import type { MenuItemKey } from '../../shared/types/menuSettings';
import type { ProjectAccessRequestStatus } from '../../shared/types/platformAdmin';
import type { FlagLifecycle, FlagRuleType, FlagAuditAction } from '../../shared/types/featureFlags';

// ── Tables ────────────────────────────────────────────────────────────────────

export const chatThreads = pgTable('chat_threads', {
  id: uuid('id').primaryKey(),
  userId: text('user_id').notNull(),
  status: text('status').notNull().default('idle'),
  kickoff: jsonb('kickoff').$type<ChatThreadKickoff>().notNull(),
  cursorAgentId: text('cursor_agent_id'),
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

// ── RBAC Relations ────────────────────────────────────────────────────────────

export const appUsersRelations = relations(appUsers, ({ many }) => ({
  userRoles: many(appUserRoles),
  groupMemberships: many(appGroupMembers),
  projectAssignments: many(userProjectAssignments),
  projectAccessRequests: many(projectAccessRequests),
  featureRequests: many(featureRequests),
}));

export const appRolesRelations = relations(appRoles, ({ many }) => ({
  userRoles: many(appUserRoles),
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
  status: text('status').notNull().default('in_progress'),
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
  status: text('status').notNull().default('draft'),
  reviewerId: text('reviewer_id'),
  reviewComment: text('review_comment'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

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
  designDocSkillPath: text('design_doc_skill_path'),
  designDocAssistantSkillPath: text('design_doc_assistant_skill_path'),
  designPrototypeSkillPath: text('design_prototype_skill_path'),
  testCaseSkillPath: text('test_case_skill_path'),
  interviewModel: text('interview_model'),
  prdModel: text('prd_model'),
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
  skillProvider: text('skill_provider').notNull().default('ado'),
  interviewSkillOptions: jsonb('interview_skill_options').$type<InterviewSkillOption[]>(),
  prototypeStageEnabled: boolean('prototype_stage_enabled').notNull().default(true),
  quickSkillPills: jsonb('quick_skill_pills').$type<QuickSkillPill[]>(),
  quickMcpPills: jsonb('quick_mcp_pills').$type<QuickMcpPill[]>(),
  approvalMode: text('approval_mode').$type<ApprovalMode>().notNull().default('any_one'),
  cursorApiKeyEnvRef: text('cursor_api_key_env_ref'),
  cursorServiceAccountId: text('cursor_service_account_id'),
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
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

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
  title: text('title').notNull(),
  request: text('request').notNull(),
  advantage: text('advantage').notNull(),
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
  submittedByIdx: index('idx_feature_requests_submitted_by').on(t.submittedBy),
}));

export const featureRequestsRelations = relations(featureRequests, ({ one }) => ({
  interview: one(interviews, {
    fields: [featureRequests.interviewId],
    references: [interviews.id],
  }),
  submitter: one(appUsers, {
    fields: [featureRequests.submittedBy],
    references: [appUsers.oid],
  }),
}));

// ── PDF Sessions ──────────────────────────────────────────────────────────────

export const pdfSessions = pgTable('pdf_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  projectId: text('project_id'),
  status: text('status').$type<PdfSessionStatus>().notNull().default('active'),
  pageManifest: jsonb('page_manifest').$type<PageManifestEntry[]>().notNull().default([]),
  fileMetadata: jsonb('file_metadata').$type<PdfFileMetadata[]>().notNull().default([]),
  exportFilename: text('export_filename'),
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
  originalName: text('original_name').notNull(),
  originalMimeType: text('original_mime_type').notNull(),
  inputPath: text('input_path').notNull(),
  status: text('status').$type<PdfConversionStatus>().notNull().default('queued'),
  fileId: uuid('file_id'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  ownerInstance: text('owner_instance'),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true, mode: 'string' }),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  sessionCreatedIdx: index('idx_pdf_conversion_jobs_session_created').on(t.sessionId, t.createdAt),
  statusCreatedIdx: index('idx_pdf_conversion_jobs_status_created').on(t.status, t.createdAt),
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
  status: text('status').notNull().default('queued'),
  ownerInstance: text('owner_instance'),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  timeoutAt: timestamp('timeout_at', { withTimezone: true, mode: 'string' }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  statusHeartbeatIdx: index('idx_agent_runs_status_heartbeat').on(t.status, t.heartbeatAt),
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
