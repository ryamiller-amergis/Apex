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
