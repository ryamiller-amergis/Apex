import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import type { ChatThreadKickoff } from '../../shared/types/chat';

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

// ── Interview Tables ───────────────────────────────────────────────────────────

export const interviews = pgTable('interviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  chatThreadId: uuid('chat_thread_id').notNull().unique(),
  authorId: text('author_id').notNull(),
  title: text('title').notNull().default('Untitled Interview'),
  project: text('project').notNull(),
  repo: text('repo').notNull(),
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
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});
