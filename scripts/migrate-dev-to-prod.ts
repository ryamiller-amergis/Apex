/**
 * One-time dev → prod data migration script.
 *
 * Connects to the dev database (read-only), reads all user-generated data,
 * and emits a single .sql file with ordered INSERT … ON CONFLICT statements
 * that can be reviewed and then applied to production.
 *
 * Usage:
 *   DEV_DATABASE_URL="postgresql://..." npx ts-node -P tsconfig.server.json scripts/migrate-dev-to-prod.ts
 *
 * Or with a flag:
 *   npx ts-node -P tsconfig.server.json scripts/migrate-dev-to-prod.ts \
 *     --dev-url "postgresql://..."
 *
 * Output:  scripts/output/dev-to-prod-migration.sql
 */

import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getDevUrl(): string {
  const fromFlag = process.argv.find((a) => a.startsWith('--dev-url='))?.split('=').slice(1).join('=');
  const flagIdx = process.argv.indexOf('--dev-url');
  const fromFlagSep = flagIdx !== -1 ? process.argv[flagIdx + 1] : undefined;
  const url = fromFlag ?? fromFlagSep ?? process.env.DEV_DATABASE_URL ?? '';
  if (!url) {
    throw new Error(
      'No dev database URL provided. Set DEV_DATABASE_URL or pass --dev-url "postgresql://..."',
    );
  }
  return url;
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

function escapeLiteral(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  if (typeof val === 'number') return String(val);
  if (val instanceof Date) return `'${val.toISOString()}'`;
  if (typeof val === 'object') {
    return escapeString(JSON.stringify(val));
  }
  return escapeString(String(val));
}

function escapeString(s: string): string {
  // Use PostgreSQL's dollar-quoted string if it contains single quotes or backslashes
  // to avoid double-escaping issues. Pick a unique tag.
  if (s.includes("'") || s.includes('\\')) {
    let tag = '$migval$';
    let attempt = 0;
    while (s.includes(tag)) {
      tag = `$mig${attempt++}$`;
    }
    return `${tag}${s}${tag}`;
  }
  return `'${s}'`;
}

// ---------------------------------------------------------------------------
// Table definitions — ordered by FK dependency (parents first)
// ---------------------------------------------------------------------------

interface TableDef {
  name: string;
  pk: string | string[];
  /** Columns to NULL out during migration (ephemeral runtime values) */
  nullColumns?: string[];
  /** Use DO NOTHING instead of DO UPDATE (for seed data that may differ in prod) */
  doNothing?: boolean;
  /** Columns to exclude from the SET clause in ON CONFLICT DO UPDATE */
  excludeFromUpdate?: string[];
  /**
   * Skip normal INSERT generation. These tables need special handling
   * (e.g. UUID remapping between environments).
   */
  skip?: boolean;
}

const TABLES: TableDef[] = [
  // Tier 1 — no FK deps
  { name: 'app_settings', pk: 'key', excludeFromUpdate: ['key'] },
  // Permissions & roles are seeded by migrations and may have different UUIDs
  // in prod. We skip them and handle role_permissions via UUID remapping below.
  { name: 'app_permissions', pk: 'id', skip: true },
  { name: 'app_roles', pk: 'id', skip: true },
  // feature_flags are seeded by migrations with potentially different UUIDs.
  // Skip and handle via remapping like roles/permissions.
  { name: 'feature_flags', pk: 'id', skip: true },

  // Tier 2 — depends on Tier 1
  { name: 'app_users', pk: 'oid' },
  // Role-permission mappings also need remapping since UUIDs may differ.
  { name: 'app_role_permissions', pk: ['role_id', 'permission_id'], skip: true },
  // Feature flag rules need flag UUID remapping.
  { name: 'feature_flag_rules', pk: 'id', skip: true },
  // Feature flag audit needs flag UUID remapping.
  { name: 'feature_flag_audit', pk: 'id', skip: true },

  // Tier 3 — depends on users + roles
  // User-role assignments need role UUID remapping.
  { name: 'app_user_roles', pk: ['user_id', 'role_id'], skip: true },
  // Groups are seeded per-project via the API; same name+project but different UUIDs.
  { name: 'app_groups', pk: 'id', skip: true },
  { name: 'user_project_assignments', pk: ['user_id', 'project'], doNothing: true },
  { name: 'pending_project_assignments', pk: ['email', 'project'], doNothing: true },
  { name: 'project_access_requests', pk: 'id' },
  // project_skill_settings have different UUIDs between dev/prod.
  // Need to remap settings_id references in project_approvers and project_approver_groups.
  { name: 'project_skill_settings', pk: ['project', 'friendly_name'] },
  { name: 'project_menu_settings', pk: 'project' },
  { name: 'notification_preferences', pk: ['user_id', 'notification_type'], doNothing: true },

  // Tier 4 — depends on groups + settings
  // Group members and approver groups need group UUID remapping.
  { name: 'app_group_members', pk: ['group_id', 'user_id'], skip: true },
  // project_approvers.settings_id needs remapping to prod settings UUID
  { name: 'project_approvers', pk: 'id', skip: true },
  { name: 'project_approver_groups', pk: 'id', skip: true },

  // Tier 5 — chat threads
  {
    name: 'chat_threads',
    pk: 'id',
    nullColumns: ['workspace_dir', 'cursor_agent_id', 'active_run_id'],
  },

  // Tier 6 — depends on threads
  { name: 'chat_messages', pk: 'id' },
  { name: 'interviews', pk: 'id' },
  { name: 'dev_sessions', pk: 'id' },

  // Tier 7 — depends on interviews
  { name: 'prds', pk: 'id' },
  // standup_configs has group_id FK and group_ids JSONB that need group UUID remapping
  { name: 'standup_configs', pk: 'id', skip: true },

  // Tier 8 — depends on PRDs + standups
  { name: 'design_prototypes', pk: 'id' },
  { name: 'test_cases', pk: 'id' },
  { name: 'design_plans', pk: 'id' },
  { name: 'standup_sessions', pk: 'id', skip: true },
  // design_docs depends on design_prototypes, so must come after
  { name: 'design_docs', pk: 'id' },

  // Tier 9 — depends on Tier 8
  { name: 'chat_message_attachments', pk: 'id' },
  { name: 'design_prototype_comments', pk: 'id' },
  { name: 'document_approver_assignments', pk: 'id' },
  { name: 'document_owner_approvals', pk: 'id' },
  { name: 'review_comments', pk: 'id' },
  { name: 'standup_participants', pk: 'id' },
  { name: 'standup_followups', pk: 'id' },

  // Tier 10
  { name: 'review_replies', pk: 'id' },
  { name: 'notifications', pk: 'id' },
  { name: 'teams_conversation_references', pk: 'user_oid' },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function generateInsert(
  table: TableDef,
  columns: string[],
  row: Record<string, unknown>,
): string[] {
  const values = columns.map((col) => {
    if (table.nullColumns?.includes(col)) return 'NULL';
    return escapeLiteral(row[col]);
  });

  const pkCols = Array.isArray(table.pk) ? table.pk : [table.pk];
  const conflictTarget = pkCols.map((c) => `"${c}"`).join(', ');

  let conflictClause: string;
  if (table.doNothing) {
    conflictClause = 'DO NOTHING';
  } else {
    const updateCols = columns.filter(
      (c) =>
        !pkCols.includes(c) &&
        !table.nullColumns?.includes(c) &&
        !table.excludeFromUpdate?.includes(c),
    );
    if (updateCols.length === 0) {
      conflictClause = 'DO NOTHING';
    } else {
      const setClauses = updateCols.map((c) => `"${c}" = EXCLUDED."${c}"`);
      conflictClause = `DO UPDATE SET ${setClauses.join(', ')}`;
    }
  }

  return [
    `INSERT INTO "${table.name}" (${columns.map((c) => `"${c}"`).join(', ')})`,
    `  VALUES (${values.join(', ')})`,
    `  ON CONFLICT (${conflictTarget}) ${conflictClause};`,
  ];
}

/**
 * Permissions and roles are seeded by migrations with random UUIDs, so dev
 * and prod will have different IDs for the same logical key/name.
 *
 * Instead of inserting dev rows (which would collide on the UNIQUE key/name
 * constraint), we emit SQL that remaps dev UUIDs → prod UUIDs using the
 * natural key as a join. This ensures app_user_roles and app_role_permissions
 * reference the correct prod IDs.
 */
async function emitRbacRemapping(
  pool: Pool,
  lines: string[],
): Promise<{ roleCount: number; permCount: number; rpCount: number; urCount: number }> {
  // Read dev data
  const { rows: devRoles } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM app_roles`,
  );
  const { rows: devPerms } = await pool.query<{ id: string; key: string }>(
    `SELECT id, key FROM app_permissions`,
  );
  const { rows: devRolePerms } = await pool.query<{ role_id: string; permission_id: string }>(
    `SELECT role_id, permission_id FROM app_role_permissions`,
  );
  const { rows: devUserRoles } = await pool.query<{
    user_id: string; role_id: string; assigned_by: string | null; assigned_at: string;
  }>(`SELECT user_id, role_id, assigned_by, assigned_at FROM app_user_roles`);

  // Build dev UUID → name/key lookup maps
  const devRoleIdToName = new Map(devRoles.map((r) => [r.id, r.name]));
  const devPermIdToKey = new Map(devPerms.map((p) => [p.id, p.key]));

  // ── app_role_permissions ──
  // For each dev mapping, emit an INSERT that resolves prod UUIDs by name/key subquery.
  lines.push(
    `-- ── app_role_permissions (${devRolePerms.length} rows, remapped by role name + perm key) ──`,
  );
  for (const rp of devRolePerms) {
    const roleName = devRoleIdToName.get(rp.role_id);
    const permKey = devPermIdToKey.get(rp.permission_id);
    if (!roleName || !permKey) continue;
    lines.push(
      `INSERT INTO app_role_permissions (role_id, permission_id)`,
      `  SELECT r.id, p.id FROM app_roles r, app_permissions p`,
      `  WHERE r.name = ${escapeString(roleName)} AND p.key = ${escapeString(permKey)}`,
      `  ON CONFLICT (role_id, permission_id) DO NOTHING;`,
    );
  }
  lines.push('');

  // ── app_user_roles ──
  lines.push(
    `-- ── app_user_roles (${devUserRoles.length} rows, remapped by role name) ──`,
  );
  for (const ur of devUserRoles) {
    const roleName = devRoleIdToName.get(ur.role_id);
    if (!roleName) continue;
    lines.push(
      `INSERT INTO app_user_roles (user_id, role_id, assigned_by, assigned_at)`,
      `  SELECT ${escapeString(ur.user_id)}, r.id, ${escapeLiteral(ur.assigned_by)}, ${escapeLiteral(ur.assigned_at)}`,
      `  FROM app_roles r WHERE r.name = ${escapeString(roleName)}`,
      `  ON CONFLICT (user_id, role_id) DO NOTHING;`,
    );
  }
  lines.push('');

  console.log(`  app_permissions: ${devPerms.length} rows (skipped — seeded by migrations)`);
  console.log(`  app_roles: ${devRoles.length} rows (skipped — seeded by migrations)`);
  console.log(`  app_role_permissions: ${devRolePerms.length} rows (remapped)`);
  console.log(`  app_user_roles: ${devUserRoles.length} rows (remapped)`);

  return {
    roleCount: devRoles.length,
    permCount: devPerms.length,
    rpCount: devRolePerms.length,
    urCount: devUserRoles.length,
  };
}

/**
 * Feature flags are seeded by migrations with random UUIDs.
 * Remap dev flag UUIDs → prod UUIDs using the `key` column, then
 * emit rules and audit entries using subquery-based inserts.
 */
async function emitFeatureFlagRemapping(
  pool: Pool,
  lines: string[],
): Promise<{ flagCount: number; ruleCount: number; auditCount: number }> {
  const { rows: devFlags } = await pool.query<{ id: string; key: string }>(
    `SELECT id, key FROM feature_flags`,
  );
  const { rows: devRules } = await pool.query<{
    id: string; flag_id: string; type: string; value: string | null;
    created_by: string | null; created_at: string;
  }>(`SELECT * FROM feature_flag_rules`);
  const { rows: devAudit } = await pool.query<{
    id: string; flag_id: string | null; flag_key: string; action: string;
    actor_id: string | null; actor_email: string | null; details: unknown;
    created_at: string;
  }>(`SELECT * FROM feature_flag_audit`);

  const devFlagIdToKey = new Map(devFlags.map((f) => [f.id, f.key]));

  // ── feature_flag_rules ──
  lines.push(
    `-- ── feature_flag_rules (${devRules.length} rows, remapped by flag key) ──`,
  );
  for (const rule of devRules) {
    const flagKey = devFlagIdToKey.get(rule.flag_id);
    if (!flagKey) continue;
    lines.push(
      `INSERT INTO feature_flag_rules (id, flag_id, type, value, created_by, created_at)`,
      `  SELECT ${escapeString(rule.id)}, f.id, ${escapeString(rule.type)}, ${escapeLiteral(rule.value)}, ${escapeLiteral(rule.created_by)}, ${escapeLiteral(rule.created_at)}`,
      `  FROM feature_flags f WHERE f.key = ${escapeString(flagKey)}`,
      `  ON CONFLICT (id) DO NOTHING;`,
    );
  }
  lines.push('');

  // ── feature_flag_audit ──
  lines.push(
    `-- ── feature_flag_audit (${devAudit.length} rows, remapped by flag key) ──`,
  );
  for (const entry of devAudit) {
    const flagKey = entry.flag_key;
    lines.push(
      `INSERT INTO feature_flag_audit (id, flag_id, flag_key, action, actor_id, actor_email, details, created_at)`,
      `  SELECT ${escapeString(entry.id)}, f.id, ${escapeString(flagKey)}, ${escapeString(entry.action)}, ${escapeLiteral(entry.actor_id)}, ${escapeLiteral(entry.actor_email)}, ${escapeLiteral(entry.details)}, ${escapeLiteral(entry.created_at)}`,
      `  FROM feature_flags f WHERE f.key = ${escapeString(flagKey)}`,
      `  ON CONFLICT (id) DO NOTHING;`,
    );
  }
  lines.push('');

  console.log(`  feature_flags: ${devFlags.length} rows (skipped — seeded by migrations)`);
  console.log(`  feature_flag_rules: ${devRules.length} rows (remapped)`);
  console.log(`  feature_flag_audit: ${devAudit.length} rows (remapped)`);

  return { flagCount: devFlags.length, ruleCount: devRules.length, auditCount: devAudit.length };
}

/**
 * Groups are seeded per-project via the API with random UUIDs.
 * Remap dev group UUIDs → prod UUIDs using (name, COALESCE(project, '')).
 * Also remap app_group_members and project_approver_groups.
 * Returns the dev→prod UUID mapping for use by standup tables.
 */
async function emitGroupRemapping(
  pool: Pool,
  lines: string[],
): Promise<{ memberCount: number; approverGroupCount: number; devGroupIdToNameProject: Map<string, { name: string; project: string | null }> }> {
  const { rows: devGroups } = await pool.query<{ id: string; name: string; project: string | null }>(
    `SELECT id, name, project FROM app_groups`,
  );
  const { rows: devMembers } = await pool.query<{
    group_id: string; user_id: string; added_by: string | null; added_at: string;
  }>(`SELECT * FROM app_group_members`);
  const { rows: devApproverGroups } = await pool.query<{
    id: string; settings_id: string; group_id: string; document_type: string;
    assigned_by: string | null; assigned_at: string;
  }>(`SELECT * FROM project_approver_groups`);

  const devGroupIdToNameProject = new Map(
    devGroups.map((g) => [g.id, { name: g.name, project: g.project }]),
  );

  // Ensure all dev groups exist in prod. The unique constraint is on
  // (name, COALESCE(project, '')). If a group with the same name+project
  // already exists (likely from API seeding), we skip it — its prod UUID
  // will be resolved via subqueries when inserting members/approver groups.
  lines.push(
    `-- ── app_groups (${devGroups.length} rows, upsert by name+project) ──`,
  );
  for (const g of devGroups) {
    const { rows: devGroupFull } = await pool.query(
      `SELECT * FROM app_groups WHERE id = $1`, [g.id],
    );
    if (devGroupFull.length === 0) continue;
    const row = devGroupFull[0];
    const columns = Object.keys(row);
    const values = columns.map((col) => escapeLiteral(row[col]));
    lines.push(
      `INSERT INTO app_groups (${columns.map((c) => `"${c}"`).join(', ')})`,
      `  VALUES (${values.join(', ')})`,
      `  ON CONFLICT (name, COALESCE(project, '')) DO NOTHING;`,
    );
  }
  lines.push('');

  // ── app_group_members ──
  lines.push(
    `-- ── app_group_members (${devMembers.length} rows, remapped by group name+project) ──`,
  );
  for (const m of devMembers) {
    const group = devGroupIdToNameProject.get(m.group_id);
    if (!group) continue;
    lines.push(
      `INSERT INTO app_group_members (group_id, user_id, added_by, added_at)`,
      `  SELECT g.id, ${escapeString(m.user_id)}, ${escapeLiteral(m.added_by)}, ${escapeLiteral(m.added_at)}`,
      `  FROM app_groups g WHERE g.name = ${escapeString(group.name)} AND COALESCE(g.project, '') = ${escapeString(group.project ?? '')}`,
      `  ON CONFLICT (group_id, user_id) DO NOTHING;`,
    );
  }
  lines.push('');

  // ── project_approver_groups (both settings_id and group_id need remapping) ──
  lines.push(
    `-- ── project_approver_groups (${devApproverGroups.length} rows, settings_id + group_id remapped) ──`,
  );
  for (const ag of devApproverGroups) {
    const group = devGroupIdToNameProject.get(ag.group_id);
    if (!group) continue;
    // Remap settings_id via project_skill_settings lookup
    const { rows: devSettingsForAG } = await pool.query<{ project: string; friendly_name: string }>(
      `SELECT project, friendly_name FROM project_skill_settings WHERE id = $1`, [ag.settings_id],
    );
    if (devSettingsForAG.length === 0) continue;
    const sk = devSettingsForAG[0];
    lines.push(
      `INSERT INTO project_approver_groups (id, settings_id, group_id, document_type, assigned_by, assigned_at)`,
      `  SELECT ${escapeString(ag.id)}, s.id, g.id, ${escapeString(ag.document_type)}, ${escapeLiteral(ag.assigned_by)}, ${escapeLiteral(ag.assigned_at)}`,
      `  FROM project_skill_settings s, app_groups g`,
      `  WHERE s.project = ${escapeString(sk.project)} AND s.friendly_name = ${escapeString(sk.friendly_name)}`,
      `  AND g.name = ${escapeString(group.name)} AND COALESCE(g.project, '') = ${escapeString(group.project ?? '')}`,
      `  ON CONFLICT (id) DO NOTHING;`,
    );
  }
  lines.push('');

  // ── project_approvers (settings_id needs remapping) ──
  const { rows: devApprovers } = await pool.query(`SELECT * FROM project_approvers`);
  const { rows: devSettings } = await pool.query<{ id: string; project: string; friendly_name: string }>(
    `SELECT id, project, friendly_name FROM project_skill_settings`,
  );
  const devSettingsIdToKey = new Map(devSettings.map((s) => [s.id, { project: s.project, friendlyName: s.friendly_name }]));

  lines.push(
    `-- ── project_approvers (${devApprovers.length} rows, settings_id remapped) ──`,
  );
  for (const pa of devApprovers) {
    const settingsKey = devSettingsIdToKey.get(pa.settings_id);
    if (!settingsKey) continue;
    lines.push(
      `INSERT INTO project_approvers (id, settings_id, user_id, document_type, assigned_by, assigned_at)`,
      `  SELECT ${escapeString(pa.id)}, s.id, ${escapeString(pa.user_id)}, ${escapeString(pa.document_type)}, ${escapeLiteral(pa.assigned_by)}, ${escapeLiteral(pa.assigned_at)}`,
      `  FROM project_skill_settings s WHERE s.project = ${escapeString(settingsKey.project)} AND s.friendly_name = ${escapeString(settingsKey.friendlyName)}`,
      `  ON CONFLICT (id) DO NOTHING;`,
    );
  }
  lines.push('');
  console.log(`  project_approvers: ${devApprovers.length} rows (settings_id remapped)`);

  // ── project_approver_groups (settings_id + group_id need remapping) ──
  lines.push(
    `-- ── project_approver_groups (${devApproverGroups.length} rows, settings_id + group_id remapped) ──`,
  );
  for (const ag of devApproverGroups) {
    const group = devGroupIdToNameProject.get(ag.group_id);
    if (!group) continue;
    const { rows: devSettingsForAG } = await pool.query<{ project: string; friendly_name: string }>(
      `SELECT project, friendly_name FROM project_skill_settings WHERE id = $1`, [ag.settings_id],
    );
    if (devSettingsForAG.length === 0) continue;
    const sk = devSettingsForAG[0];
    lines.push(
      `INSERT INTO project_approver_groups (id, settings_id, group_id, document_type, assigned_by, assigned_at)`,
      `  SELECT ${escapeString(ag.id)}, s.id, g.id, ${escapeString(ag.document_type)}, ${escapeLiteral(ag.assigned_by)}, ${escapeLiteral(ag.assigned_at)}`,
      `  FROM project_skill_settings s, app_groups g`,
      `  WHERE s.project = ${escapeString(sk.project)} AND s.friendly_name = ${escapeString(sk.friendly_name)}`,
      `  AND g.name = ${escapeString(group.name)} AND COALESCE(g.project, '') = ${escapeString(group.project ?? '')}`,
      `  ON CONFLICT (id) DO NOTHING;`,
    );
  }
  lines.push('');

  console.log(`  app_groups: ${devGroups.length} rows (upserted by name+project)`);
  console.log(`  app_group_members: ${devMembers.length} rows (remapped)`);
  console.log(`  project_approver_groups: ${devApproverGroups.length} rows (remapped)`);

  return { memberCount: devMembers.length, approverGroupCount: devApproverGroups.length, devGroupIdToNameProject };
}

/**
 * Emit standup_configs and standup_sessions with group UUID remapping.
 * Must be called AFTER chat_threads are inserted (sessions have FK to threads).
 */
async function emitStandupRemapping(
  pool: Pool,
  lines: string[],
  devGroupIdToNameProject: Map<string, { name: string; project: string | null }>,
): Promise<{ configCount: number; sessionCount: number }> {
  const { rows: devConfigs } = await pool.query(`SELECT * FROM standup_configs`);
  lines.push(
    `-- ── standup_configs (${devConfigs.length} rows, group refs remapped) ──`,
  );
  for (const cfg of devConfigs) {
    const columns = Object.keys(cfg);
    const values = columns.map((col) => {
      if (col === 'group_id') {
        if (!cfg.group_id) return 'NULL';
        const group = devGroupIdToNameProject.get(cfg.group_id);
        if (!group) return 'NULL';
        return `(SELECT id FROM app_groups WHERE name = ${escapeString(group.name)} AND COALESCE(project, '') = ${escapeString(group.project ?? '')} LIMIT 1)`;
      }
      if (col === 'group_ids' && Array.isArray(cfg.group_ids)) {
        const remappedSubqueries = (cfg.group_ids as string[]).map((gid) => {
          const group = devGroupIdToNameProject.get(gid);
          if (!group) return null;
          return `(SELECT id::text FROM app_groups WHERE name = ${escapeString(group.name)} AND COALESCE(project, '') = ${escapeString(group.project ?? '')} LIMIT 1)`;
        }).filter(Boolean);
        if (remappedSubqueries.length === 0) return `'[]'::jsonb`;
        return `(SELECT jsonb_agg(v) FROM (VALUES ${remappedSubqueries.map((sq) => `(${sq})`).join(', ')}) AS t(v))`;
      }
      if (col === 'skill_settings_id' && !cfg.skill_settings_id) return 'NULL';
      return escapeLiteral(cfg[col]);
    });

    lines.push(
      `INSERT INTO standup_configs (${columns.map((c) => `"${c}"`).join(', ')})`,
      `  VALUES (${values.join(', ')})`,
      `  ON CONFLICT (id) DO NOTHING;`,
    );
  }
  lines.push('');

  const { rows: devSessions } = await pool.query(`SELECT * FROM standup_sessions`);
  lines.push(
    `-- ── standup_sessions (${devSessions.length} rows, group refs remapped) ──`,
  );
  for (const sess of devSessions) {
    const columns = Object.keys(sess);
    const values = columns.map((col) => {
      if (col === 'group_id') {
        if (!sess.group_id) return 'NULL';
        const group = devGroupIdToNameProject.get(sess.group_id);
        if (!group) return 'NULL';
        return `(SELECT id FROM app_groups WHERE name = ${escapeString(group.name)} AND COALESCE(project, '') = ${escapeString(group.project ?? '')} LIMIT 1)`;
      }
      return escapeLiteral(sess[col]);
    });

    lines.push(
      `INSERT INTO standup_sessions (${columns.map((c) => `"${c}"`).join(', ')})`,
      `  VALUES (${values.join(', ')})`,
      `  ON CONFLICT (id) DO NOTHING;`,
    );
  }
  lines.push('');

  console.log(`  standup_configs: ${devConfigs.length} rows (group refs remapped)`);
  console.log(`  standup_sessions: ${devSessions.length} rows (group refs remapped)`);

  return { configCount: devConfigs.length, sessionCount: devSessions.length };
}

async function main(): Promise<void> {
  const devUrl = getDevUrl();
  console.log(`Connecting to dev database...`);

  const pool = new Pool({
    connectionString: devUrl,
    ssl: devUrl.includes('sslmode=require') ? { rejectUnauthorized: true } : undefined,
  });

  const lines: string[] = [
    '-- ==========================================================================',
    '-- Dev → Prod Data Migration',
    `-- Generated: ${new Date().toISOString()}`,
    '-- Review carefully before running against production!',
    '-- ==========================================================================',
    '',
    'BEGIN;',
    '',
    '-- Temporarily defer FK checks within the transaction',
    'SET CONSTRAINTS ALL DEFERRED;',
    '',
  ];

  let totalRows = 0;
  let rbacEmitted = false;
  let flagsEmitted = false;
  let groupsEmitted = false;
  let standupEmitted = false;
  let devGroupIdToNameProject: Map<string, { name: string; project: string | null }> | undefined;

  for (const table of TABLES) {
    if (table.skip) {
      if (!rbacEmitted && table.name === 'app_user_roles') {
        const counts = await emitRbacRemapping(pool, lines);
        totalRows += counts.rpCount + counts.urCount;
        rbacEmitted = true;
      }
      if (!flagsEmitted && table.name === 'feature_flag_rules') {
        const counts = await emitFeatureFlagRemapping(pool, lines);
        totalRows += counts.ruleCount + counts.auditCount;
        flagsEmitted = true;
      }
      if (!groupsEmitted && table.name === 'app_group_members') {
        const result = await emitGroupRemapping(pool, lines);
        totalRows += result.memberCount + result.approverGroupCount;
        devGroupIdToNameProject = result.devGroupIdToNameProject;
        groupsEmitted = true;
      }
      // Standup tables need group remapping AND must come after chat_threads.
      // They'll be emitted when we encounter them in the loop, but only after
      // chat_threads has been processed (handled below).
      if (!standupEmitted && table.name === 'standup_configs') {
        // Defer — will be emitted after chat_threads
      }
      continue;
    }

    // After chat_threads is processed, emit standup remapping
    if (!standupEmitted && table.name === 'chat_messages' && devGroupIdToNameProject) {
      const counts = await emitStandupRemapping(pool, lines, devGroupIdToNameProject);
      totalRows += counts.configCount + counts.sessionCount;
      standupEmitted = true;
    }

    const { rows } = await pool.query(`SELECT * FROM "${table.name}"`);
    const count = rows.length;

    lines.push(`-- ── ${table.name} (${count} rows) ${'─'.repeat(Math.max(0, 50 - table.name.length))}`);

    if (count === 0) {
      lines.push(`-- (empty table, skipping)`, '');
      continue;
    }

    const columns = Object.keys(rows[0]);

    for (const row of rows) {
      lines.push(...generateInsert(table, columns, row));
    }

    lines.push('');
    totalRows += count;
    console.log(`  ${table.name}: ${count} rows`);
  }

  lines.push('COMMIT;', '');

  // Write output
  const outputDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const outputPath = path.join(outputDir, 'dev-to-prod-migration.sql');
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');

  await pool.end();

  console.log(`\nDone! ${totalRows} total rows across ${TABLES.length} tables.`);
  console.log(`Output: ${outputPath}`);
  console.log('\nNext steps:');
  console.log('  1. Review the generated SQL file');
  console.log('  2. Run against prod:  psql "$PROD_DATABASE_URL" -f scripts/output/dev-to-prod-migration.sql');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
