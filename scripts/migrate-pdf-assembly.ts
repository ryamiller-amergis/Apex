/**
 * Scoped dev → prod migration for the "PDF assembly tool" interview pipeline.
 *
 * Exports only the interview, PRD (with backlog), design docs, test cases,
 * design plan, approvals, review comments, and associated chat threads/messages.
 *
 * Usage:
 *   DEV_DATABASE_URL="postgresql://..." npx ts-node -P tsconfig.server.json scripts/migrate-pdf-assembly.ts
 *
 * Output:  scripts/output/pdf-assembly-migration.sql
 */

import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

// ── IDs ────────────────────────────────────────────────────────────────────────

const INTERVIEW_ID = '44b6a0e0-4bed-47b5-a43a-cbfdcd8e6578';
const PRD_ID = '07895a11-e62a-4144-89d4-fcf06bfa5e59';

// ── Config ─────────────────────────────────────────────────────────────────────

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

// ── SQL helpers ────────────────────────────────────────────────────────────────

function escapeLiteral(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  if (typeof val === 'number') return String(val);
  if (val instanceof Date) return `'${val.toISOString()}'`;
  if (typeof val === 'object') return escapeString(JSON.stringify(val));
  return escapeString(String(val));
}

function escapeString(s: string): string {
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

interface UpsertOpts {
  pk: string | string[];
  nullColumns?: string[];
  doNothing?: boolean;
}

function generateInsert(
  table: string,
  columns: string[],
  row: Record<string, unknown>,
  opts: UpsertOpts,
): string[] {
  const values = columns.map((col) => {
    if (opts.nullColumns?.includes(col)) return 'NULL';
    return escapeLiteral(row[col]);
  });

  const pkCols = Array.isArray(opts.pk) ? opts.pk : [opts.pk];
  const conflictTarget = pkCols.map((c) => `"${c}"`).join(', ');

  let conflictClause: string;
  if (opts.doNothing) {
    conflictClause = 'DO NOTHING';
  } else {
    const updateCols = columns.filter(
      (c) => !pkCols.includes(c) && !opts.nullColumns?.includes(c),
    );
    conflictClause = updateCols.length === 0
      ? 'DO NOTHING'
      : `DO UPDATE SET ${updateCols.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ')}`;
  }

  return [
    `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')})`,
    `  VALUES (${values.join(', ')})`,
    `  ON CONFLICT (${conflictTarget}) ${conflictClause};`,
  ];
}

async function queryRows(pool: Pool, sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
  const { rows } = await pool.query(sql, params);
  return rows;
}

function emitSection(lines: string[], label: string, rows: Record<string, unknown>[], table: string, opts: UpsertOpts): void {
  lines.push(`-- ── ${label} (${rows.length} rows) ${'─'.repeat(Math.max(0, 55 - label.length))}`);
  if (rows.length === 0) {
    lines.push('-- (none)', '');
    return;
  }
  const columns = Object.keys(rows[0]);
  for (const row of rows) {
    lines.push(...generateInsert(table, columns, row, opts));
  }
  lines.push('');
  console.log(`  ${label}: ${rows.length} rows`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const devUrl = getDevUrl();
  console.log('Connecting to dev database...');

  const pool = new Pool({
    connectionString: devUrl,
    ssl: devUrl.includes('sslmode=require') ? { rejectUnauthorized: true } : undefined,
  });

  const lines: string[] = [
    '-- ==========================================================================',
    '-- PDF Assembly Tool — Scoped Data Migration (dev → prod)',
    `-- Generated: ${new Date().toISOString()}`,
    `-- Interview: ${INTERVIEW_ID}`,
    `-- PRD:       ${PRD_ID}`,
    '-- Review carefully before running against production!',
    '-- ==========================================================================',
    '',
    'BEGIN;',
    'SET CONSTRAINTS ALL DEFERRED;',
    '',
  ];

  // ── 1. Collect all chat thread IDs ──
  const threadIdRows = await queryRows(pool, `
    SELECT DISTINCT thread_id FROM (
      SELECT chat_thread_id as thread_id FROM interviews WHERE id = $1
      UNION SELECT chat_thread_id FROM prds WHERE interview_id = $1 AND chat_thread_id IS NOT NULL
      UNION SELECT prd_assistant_thread_id FROM prds WHERE interview_id = $1 AND prd_assistant_thread_id IS NOT NULL
      UNION SELECT validation_thread_id FROM prds WHERE interview_id = $1 AND validation_thread_id IS NOT NULL
      UNION SELECT chat_thread_id FROM design_docs WHERE prd_id = $2 AND chat_thread_id IS NOT NULL
      UNION SELECT doc_assistant_thread_id FROM design_docs WHERE prd_id = $2 AND doc_assistant_thread_id IS NOT NULL
      UNION SELECT validation_thread_id FROM design_docs WHERE prd_id = $2 AND validation_thread_id IS NOT NULL
      UNION SELECT chat_thread_id FROM test_cases WHERE prd_id = $2 AND chat_thread_id IS NOT NULL
    ) sub WHERE thread_id IS NOT NULL
  `, [INTERVIEW_ID, PRD_ID]);
  const threadIds = threadIdRows.map((r) => r.thread_id as string);
  console.log(`  Found ${threadIds.length} related chat threads`);

  // ── 2. Collect all referenced user IDs ──
  const designDocIdRows = await queryRows(pool, `SELECT id FROM design_docs WHERE prd_id = $1`, [PRD_ID]);
  const designDocIds = designDocIdRows.map((r) => r.id as string);
  const allDocIds = [PRD_ID, ...designDocIds];

  const userIdRows = await queryRows(pool, `
    SELECT DISTINCT uid FROM (
      SELECT author_id as uid FROM interviews WHERE id = $1
      UNION SELECT prd_owner_id FROM interviews WHERE id = $1 AND prd_owner_id IS NOT NULL
      UNION SELECT design_doc_owner_id FROM interviews WHERE id = $1 AND design_doc_owner_id IS NOT NULL
      UNION SELECT design_prototype_owner_id FROM interviews WHERE id = $1 AND design_prototype_owner_id IS NOT NULL
      UNION SELECT test_case_owner_id FROM interviews WHERE id = $1 AND test_case_owner_id IS NOT NULL
      UNION SELECT author_id FROM prds WHERE interview_id = $1
      UNION SELECT reviewer_id FROM prds WHERE interview_id = $1 AND reviewer_id IS NOT NULL
      UNION SELECT author_id FROM design_docs WHERE prd_id = $2
      UNION SELECT reviewer_id FROM design_docs WHERE prd_id = $2 AND reviewer_id IS NOT NULL
      UNION SELECT user_id FROM chat_threads WHERE id = ANY($3)
      UNION SELECT approver_user_id FROM document_approver_assignments WHERE document_id = ANY($4)
      UNION SELECT owner_user_id FROM document_owner_approvals WHERE document_id = ANY($4) AND owner_user_id IS NOT NULL
      UNION SELECT author_user_id FROM review_comments WHERE document_id = ANY($4)
    ) sub WHERE uid IS NOT NULL
  `, [INTERVIEW_ID, PRD_ID, threadIds, allDocIds]);
  const userIds = userIdRows.map((r) => r.uid as string);

  // ── 3. Emit users (upsert by oid) ──
  const users = await queryRows(pool, `SELECT * FROM app_users WHERE oid = ANY($1)`, [userIds]);
  emitSection(lines, 'app_users', users, 'app_users', { pk: 'oid' });

  // ── 4. Emit project_skill_settings (needed for skill_settings_id FK) ──
  const skillSettings = await queryRows(pool, `
    SELECT * FROM project_skill_settings WHERE id IN (
      SELECT skill_settings_id FROM interviews WHERE id = $1 AND skill_settings_id IS NOT NULL
      UNION SELECT skill_settings_id FROM prds WHERE interview_id = $1 AND skill_settings_id IS NOT NULL
      UNION SELECT skill_settings_id FROM design_docs WHERE prd_id = $2 AND skill_settings_id IS NOT NULL
    )
  `, [INTERVIEW_ID, PRD_ID]);
  emitSection(lines, 'project_skill_settings', skillSettings, 'project_skill_settings', {
    pk: ['project', 'friendly_name'],
  });

  // ── 5. Emit chat threads ──
  const threads = await queryRows(pool, `SELECT * FROM chat_threads WHERE id = ANY($1)`, [threadIds]);
  emitSection(lines, 'chat_threads', threads, 'chat_threads', {
    pk: 'id',
    nullColumns: ['workspace_dir', 'cursor_agent_id', 'active_run_id'],
  });

  // ── 6. Emit chat messages ──
  const messages = await queryRows(pool, `SELECT * FROM chat_messages WHERE thread_id = ANY($1) ORDER BY ts`, [threadIds]);
  emitSection(lines, 'chat_messages', messages, 'chat_messages', { pk: 'id' });

  // ── 7. Emit chat message attachments ──
  const msgIds = messages.map((m) => m.id as string);
  let attachments: Record<string, unknown>[] = [];
  if (msgIds.length > 0) {
    attachments = await queryRows(pool, `SELECT * FROM chat_message_attachments WHERE message_id = ANY($1)`, [msgIds]);
  }
  emitSection(lines, 'chat_message_attachments', attachments, 'chat_message_attachments', { pk: 'id' });

  // ── 8. Emit interview ──
  const interviewRows = await queryRows(pool, `SELECT * FROM interviews WHERE id = $1`, [INTERVIEW_ID]);
  emitSection(lines, 'interviews', interviewRows, 'interviews', { pk: 'id' });

  // ── 9. Emit PRD (with backlog_json) ──
  const prdRows = await queryRows(pool, `SELECT * FROM prds WHERE interview_id = $1`, [INTERVIEW_ID]);
  emitSection(lines, 'prds', prdRows, 'prds', { pk: 'id' });

  // ── 10. Emit design prototypes (before design docs — FK dependency) ──
  const prototypes = await queryRows(pool, `SELECT * FROM design_prototypes WHERE prd_id = $1`, [PRD_ID]);
  emitSection(lines, 'design_prototypes', prototypes, 'design_prototypes', { pk: 'id' });

  // ── 11. Emit design plan ──
  const plans = await queryRows(pool, `SELECT * FROM design_plans WHERE prd_id = $1`, [PRD_ID]);
  emitSection(lines, 'design_plans', plans, 'design_plans', { pk: 'id' });

  // ── 12. Emit design docs ──
  const designDocs = await queryRows(pool, `SELECT * FROM design_docs WHERE prd_id = $1`, [PRD_ID]);
  emitSection(lines, 'design_docs', designDocs, 'design_docs', { pk: 'id' });

  // ── 13. Emit test cases ──
  const testCases = await queryRows(pool, `SELECT * FROM test_cases WHERE prd_id = $1`, [PRD_ID]);
  emitSection(lines, 'test_cases', testCases, 'test_cases', { pk: 'id' });

  // ── 14. Emit design prototype comments ──
  const protoIds = prototypes.map((p) => p.id as string);
  let protoComments: Record<string, unknown>[] = [];
  if (protoIds.length > 0) {
    protoComments = await queryRows(pool, `SELECT * FROM design_prototype_comments WHERE prototype_id = ANY($1)`, [protoIds]);
  }
  emitSection(lines, 'design_prototype_comments', protoComments, 'design_prototype_comments', { pk: 'id' });

  // ── 15. Emit document approver assignments ──
  const approvals = await queryRows(pool, `SELECT * FROM document_approver_assignments WHERE document_id = ANY($1)`, [allDocIds]);
  emitSection(lines, 'document_approver_assignments', approvals, 'document_approver_assignments', { pk: 'id' });

  // ── 16. Emit document owner approvals ──
  const ownerApprovals = await queryRows(pool, `SELECT * FROM document_owner_approvals WHERE document_id = ANY($1)`, [allDocIds]);
  emitSection(lines, 'document_owner_approvals', ownerApprovals, 'document_owner_approvals', { pk: 'id' });

  // ── 17. Emit review comments ──
  const reviewComments = await queryRows(pool, `SELECT * FROM review_comments WHERE document_id = ANY($1)`, [allDocIds]);
  emitSection(lines, 'review_comments', reviewComments, 'review_comments', { pk: 'id' });

  // ── 18. Emit review replies ──
  const commentIds = reviewComments.map((c) => c.id as string);
  let replies: Record<string, unknown>[] = [];
  if (commentIds.length > 0) {
    replies = await queryRows(pool, `SELECT * FROM review_replies WHERE comment_id = ANY($1)`, [commentIds]);
  }
  emitSection(lines, 'review_replies', replies, 'review_replies', { pk: 'id' });

  lines.push('COMMIT;', '');

  // Write output
  const outputDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'pdf-assembly-migration.sql');
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');

  await pool.end();

  const totalRows = users.length + skillSettings.length + threads.length + messages.length +
    attachments.length + interviewRows.length + prdRows.length + prototypes.length +
    plans.length + designDocs.length + testCases.length + protoComments.length +
    approvals.length + ownerApprovals.length + reviewComments.length + replies.length;

  console.log(`\nDone! ${totalRows} total rows.`);
  console.log(`Output: ${outputPath}`);
  console.log('\nNext steps:');
  console.log('  1. Review the generated SQL file');
  console.log('  2. Run against prod:  psql "$PROD_DATABASE_URL" -f scripts/output/pdf-assembly-migration.sql');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
