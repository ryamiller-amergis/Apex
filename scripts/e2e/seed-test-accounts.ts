/**
 * Give the apex-test-0N Entra test accounts their persona access in one database.
 *
 * For each persona in src/shared/constants/testAccounts.ts:
 *   - adds the email to the dev allowlist (only the dev site reads it);
 *   - if the account has signed in at least once (has an app_users row), adds it
 *     to the persona's global group and assigns it to the project;
 *   - otherwise records a pending project assignment, which Apex resolves on
 *     first sign-in. Rerun after that first sign-in to add the group membership.
 *
 * Groups are not created here: a group without roles grants nothing. The script
 * stops if a persona group is missing.
 *
 * Usage (prints the plan; add --apply to write):
 *   DATABASE_URL="postgresql://..." npx ts-node -P tsconfig.server.json scripts/e2e/seed-test-accounts.ts [--project Apex] [--apply]
 */
import { Pool } from 'pg';
import { DEV_MOCK_USERS } from '../../src/shared/constants/devMockUsers';
import { testAccountEmailForPersona } from '../../src/shared/constants/testAccounts';

const SEEDED_BY = 'seed-test-accounts';

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (!databaseUrl) throw new Error('Set DATABASE_URL to the target database.');
  const project = argValue('--project') ?? 'Apex';
  const apply = process.argv.includes('--apply');
  const useSSL = !/localhost|127\.0\.0\.1/.test(databaseUrl) || databaseUrl.includes('sslmode=require');

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: useSSL ? { rejectUnauthorized: true } : undefined,
  });
  const client = await pool.connect();

  try {
    const groupNames = [...new Set(DEV_MOCK_USERS.map((u) => u.groupName))];
    const groupRows = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM app_groups WHERE project IS NULL AND name = ANY($1)`,
      [groupNames],
    );
    const groupIdByName = new Map(groupRows.rows.map((r) => [r.name, r.id]));
    const missingGroups = groupNames.filter((name) => !groupIdByName.has(name));
    if (missingGroups.length > 0) {
      throw new Error(
        `Missing global groups: ${missingGroups.join(', ')}. Create them with the right roles first.`,
      );
    }

    await client.query('BEGIN');
    for (const persona of DEV_MOCK_USERS) {
      const email = testAccountEmailForPersona(persona.id);
      const groupId = groupIdByName.get(persona.groupName) as string;

      await client.query(
        `INSERT INTO dev_env_allowlist (email, created_by) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [email, SEEDED_BY],
      );

      const user = await client.query<{ oid: string }>(
        `SELECT oid FROM app_users WHERE LOWER(email) = $1 LIMIT 1`,
        [email],
      );
      const oid = user.rows[0]?.oid;

      if (!oid) {
        await client.query(
          `INSERT INTO pending_project_assignments (email, project, assigned_by, assigned_at)
           VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING`,
          [email, project, SEEDED_BY],
        );
        console.log(`${persona.id.padEnd(14)} ${email}: allowlisted, pending ${project}; sign in once, then rerun for group ${persona.groupName}`);
        continue;
      }

      await client.query(
        `INSERT INTO app_group_members (group_id, user_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [groupId, oid, SEEDED_BY],
      );
      await client.query(
        `INSERT INTO user_project_assignments (user_id, project, assigned_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [oid, project, SEEDED_BY],
      );
      console.log(`${persona.id.padEnd(14)} ${email}: allowlisted, group ${persona.groupName}, project ${project}`);
    }

    if (apply) {
      await client.query('COMMIT');
      console.log('Applied.');
    } else {
      await client.query('ROLLBACK');
      console.log('Dry run: nothing written. Rerun with --apply to write.');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
