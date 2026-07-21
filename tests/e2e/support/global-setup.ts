/**
 * Playwright global setup — runs once before any spec file.
 *
 * Responsibilities:
 * 1. Apply pending migrations to the test database.
 * 2. Validate that the server can be reached (port readiness is handled by
 *    Playwright's webServer config; migrations must finish before that starts).
 */
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import dotenv from 'dotenv';

// Load the repo root .env so TEST_DATABASE_URL / DATABASE_URL defined there are
// available before migrations run. Real environment variables (CI) win.
dotenv.config();

export default async function globalSetup(): Promise<void> {
  // Deployed-target mode (E2E_BASE_URL set): the suite runs read-only smoke
  // against an already-running dev/staging/prod site. We must NOT run migrations
  // or seed data — deployed environments own their own data and expose no
  // /e2e/* endpoints. Skip all local DB setup entirely.
  if (process.env.E2E_BASE_URL) {
    console.log(
      `[E2E] Deployed-target mode (E2E_BASE_URL=${process.env.E2E_BASE_URL}) — ` +
        'skipping migrations and DB seeding.',
    );
    return;
  }

  const dbUrl =
    process.env.TEST_DATABASE_URL ??
    (process.env.DATABASE_URL
      ? process.env.DATABASE_URL.replace(/\/([^/?]+)(\?.*)?$/, '/$1_e2e$2')
      : '');

  if (!dbUrl) {
    throw new Error('[E2E] TEST_DATABASE_URL or DATABASE_URL must be set for E2E tests.');
  }

  // Make TEST_DATABASE_URL available to child processes (migrate:up).
  process.env.TEST_DATABASE_URL = dbUrl;

  // Ensure the temp E2E data/session directory exists so the Express server
  // can write session files without waiting for the E2E process.
  const e2eDataDir = path.join(os.tmpdir(), 'apex-e2e-data');
  fs.mkdirSync(path.join(e2eDataDir, 'sessions'), { recursive: true });

  // Apply any pending migrations to the test database.
  const repoRoot = path.resolve(__dirname, '../../..');
  console.log('[E2E] Running migrations against test database...');
  try {
    execSync('npm run migrate:up', {
      stdio: 'inherit',
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: dbUrl },
    });
  } catch (err) {
    console.error('[E2E] Migration failed. Ensure TEST_DATABASE_URL points to a reachable PostgreSQL 16 instance.');
    throw err;
  }

  // Deterministic data fixups that the migrations alone don't provide for a
  // fresh test database.
  const { Client } = await import('pg');
  const client = new Client({ connectionString: dbUrl });
  try {
    await client.connect();

    // 1. Suppress the "What's New" changelog auto-popup for dev personas so its
    //    overlay never intercepts clicks during tests.
    await client.query(
      "UPDATE app_users SET show_changelog_on_login = false WHERE oid LIKE 'dev-mock-oid-%'",
    );

    // 2. Seed the standard groups and dev-persona memberships. Groups are
    //    created via the app/API in real environments (not migrations), so a
    //    fresh test DB has none — which would leave every group-gated feature
    //    disabled. Seed them here so group-based RBAC can be tested.
    const personaGroups: Array<{ oid: string; group: string }> = [
      { oid: 'dev-mock-oid-00000000-0000-0000-0000-000000000000', group: 'Developer' },
      { oid: 'dev-mock-oid-00000000-0000-0000-0000-000000000001', group: 'BA' },
      { oid: 'dev-mock-oid-00000000-0000-0000-0000-000000000002', group: 'Manager' },
      { oid: 'dev-mock-oid-00000000-0000-0000-0000-000000000003', group: 'Product-Owner' },
      { oid: 'dev-mock-oid-00000000-0000-0000-0000-000000000004', group: 'QA' },
      { oid: 'dev-mock-oid-00000000-0000-0000-0000-000000000005', group: 'UI/UX' },
    ];
    const groupNames = [...new Set(personaGroups.map((p) => p.group))];

    for (const name of groupNames) {
      await client.query(
        `INSERT INTO app_groups (name, description, project, is_default, created_by)
         SELECT $1, $2, NULL, false, 'e2e-setup'
         WHERE NOT EXISTS (SELECT 1 FROM app_groups WHERE name = $1 AND project IS NULL)`,
        [name, `${name} (E2E seeded)`],
      );
    }

    for (const { oid, group } of personaGroups) {
      await client.query(
        `INSERT INTO app_group_members (group_id, user_id, added_by)
         SELECT g.id, $1, 'e2e-setup'
         FROM app_groups g
         WHERE g.name = $2 AND g.project IS NULL
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [oid, group],
      );
    }

    console.log('[E2E] Seeded standard groups and disabled changelog popup for dev personas.');
  } catch (err) {
    console.warn('[E2E] Non-fatal setup fixup error:', (err as Error).message);
  } finally {
    await client.end().catch(() => {});
  }

  console.log('[E2E] Global setup complete.');
}
