import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import type { ChatThreadKickoff } from '../../shared/types/chat';
import type { ContentSnapshot, ValidationScorecard } from '../../shared/types/interview';
import type { QuickSkillPill, QuickMcpPill } from '../../shared/types/projectSettings';
import type { ApprovalMode } from '../../shared/types/approvals';
import type { MenuItemKey } from '../../shared/types/menuSettings';

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
  designDocs: many(designDocs, { relationName: 'designDocChatThread' }),
  designDocsAsQa: many(designDocs, { relationName: 'designDocQaChatThread' }),
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

// ── RBAC Tables ───────────────────────────────────────────────────────────────

export const appUsers = pgTable('app_users', {
  oid: text('oid').primaryKey(),
  displayName: text('display_name'),
  email: text('email'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'string' }),
  lastSeenChangelogVersion: text('last_seen_changelog_version'),
  showChangelogOnLogin: boolean('show_changelog_on_login').notNull().default(true),
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

// ── Groups Tables ─────────────────────────────────────────────────────────────
// Reusable, organizational user groups (e.g. Developers, Product, UI/UX).
// Fully separate from RBAC app_roles, which are permission-based.

export const appGroups = pgTable('app_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').unique().notNull(),
  description: text('description'),
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
  prdOwnerId: text('prd_owner_id').references(() => appUsers.oid, { onDelete: 'set null' }),
  designDocOwnerId: text('design_doc_owner_id').references(() => appUsers.oid, { onDelete: 'set null' }),
  prdApproverIds: jsonb('prd_approver_ids').$type<string[]>(),
  designDocApproverIds: jsonb('design_doc_approver_ids').$type<string[]>(),
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
  content: text('content').notNull().default(''),
  backlogJson: jsonb('backlog_json'),
  status: text('status').notNull().default('draft'),
  reviewerId: text('reviewer_id'),
  reviewComment: text('review_comment'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'string' }),
  designDocApproverIds: jsonb('design_doc_approver_ids').$type<string[]>(),
  prdAssistantThreadId: uuid('prd_assistant_thread_id'),
  proposedContent: text('proposed_content'),
  proposedBacklogJson: jsonb('proposed_backlog_json'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export const designDocs = pgTable('design_docs', {
  id: uuid('id').primaryKey().defaultRandom(),
  prdId: uuid('prd_id').notNull().references(() => prds.id, { onDelete: 'cascade' }),
  project: text('project').notNull(),
  chatThreadId: uuid('chat_thread_id'),
  qaChatThreadId: uuid('qa_chat_thread_id'),
  docAssistantThreadId: uuid('doc_assistant_thread_id'),
  validationThreadId: uuid('validation_thread_id'),
  validationScore: integer('validation_score'),
  validationScorecard: jsonb('validation_scorecard').$type<ValidationScorecard>(),
  validationReportMd: text('validation_report_md'),
  validationPhase: text('validation_phase'),
  fixBaseline: jsonb('fix_baseline').$type<ContentSnapshot>(),
  authorId: text('author_id').notNull(),
  title: text('title').notNull().default('Untitled Design Doc'),
  designContent: text('design_content').notNull().default(''),
  techSpecContent: text('tech_spec_content').notNull().default(''),
  assumptionsContent: text('assumptions_content').notNull().default(''),
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
  designDocs: many(designDocs),
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
  qaChatThread: one(chatThreads, {
    relationName: 'designDocQaChatThread',
    fields: [designDocs.qaChatThreadId],
    references: [chatThreads.id],
  }),
  docAssistantThread: one(chatThreads, {
    relationName: 'designDocAssistantThread',
    fields: [designDocs.docAssistantThreadId],
    references: [chatThreads.id],
  }),
}));

// ── Project Skill Settings ────────────────────────────────────────────────────

export const projectSkillSettings = pgTable('project_skill_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').unique().notNull(),
  skillRepo: text('skill_repo').notNull(),
  skillBranch: text('skill_branch').notNull(),
  updatedBy: text('updated_by'),
  interviewSkillPath: text('interview_skill_path'),
  prdSkillPath: text('prd_skill_path'),
  designDocSkillPath: text('design_doc_skill_path'),
  designDocQaSkillPath: text('design_doc_qa_skill_path'),
  designDocAssistantSkillPath: text('design_doc_assistant_skill_path'),
  interviewModel: text('interview_model'),
  prdModel: text('prd_model'),
  designDocModel: text('design_doc_model'),
  designDocQaModel: text('design_doc_qa_model'),
  designDocAssistantModel: text('design_doc_assistant_model'),
  designDocValidationSkillPath: text('design_doc_validation_skill_path'),
  designDocValidationModel: text('design_doc_validation_model'),
  prdAssistantSkillPath: text('prd_assistant_skill_path'),
  prdAssistantModel: text('prd_assistant_model'),
  defaultModel: text('default_model'),
  prdReviewBedrockModelId: text('prd_review_bedrock_model_id'),
  prdReviewBedrockMaxTokens: integer('prd_review_bedrock_max_tokens'),
  quickSkillPills: jsonb('quick_skill_pills').$type<QuickSkillPill[]>(),
  quickMcpPills: jsonb('quick_mcp_pills').$type<QuickMcpPill[]>(),
  approvalMode: text('approval_mode').$type<ApprovalMode>().notNull().default('any_one'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const projectApprovers = pgTable('project_approvers', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').notNull().references(() => projectSkillSettings.project, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => appUsers.oid, { onDelete: 'cascade' }),
  documentType: text('document_type').notNull(),
  assignedBy: text('assigned_by'),
  assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  uniq: unique().on(t.project, t.userId, t.documentType),
}));

export const projectApproversRelations = relations(projectApprovers, ({ one }) => ({
  projectSkillSetting: one(projectSkillSettings, {
    fields: [projectApprovers.project],
    references: [projectSkillSettings.project],
  }),
  user: one(appUsers, {
    fields: [projectApprovers.userId],
    references: [appUsers.oid],
  }),
}));

// Live group references in a project's approver pool, expanded to members at read time.
export const projectApproverGroups = pgTable('project_approver_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').notNull().references(() => projectSkillSettings.project, { onDelete: 'cascade' }),
  groupId: uuid('group_id').notNull().references(() => appGroups.id, { onDelete: 'cascade' }),
  documentType: text('document_type').notNull(),
  assignedBy: text('assigned_by'),
  assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => ({
  uniq: unique().on(t.project, t.groupId, t.documentType),
}));

export const projectApproverGroupsRelations = relations(projectApproverGroups, ({ one }) => ({
  projectSkillSetting: one(projectSkillSettings, {
    fields: [projectApproverGroups.project],
    references: [projectSkillSettings.project],
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

// ── Project Menu Settings ─────────────────────────────────────────────────────

export const projectMenuSettings = pgTable('project_menu_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: text('project').unique().notNull(),
  enabledViews: jsonb('enabled_views').$type<MenuItemKey[]>().notNull().default([]),
  updatedBy: text('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});
