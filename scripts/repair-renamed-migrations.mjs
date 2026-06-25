/**
 * Repair local DBs that applied migrations under temporary PR rename filenames.
 *
 * 1. Renames pgmigrations rows to canonical main branch filenames.
 * 2. Realigns run_on timestamps to match migration filename order (required by node-pg-migrate checkOrder).
 *
 * Usage:
 *   npx dotenv -e .env -- node scripts/repair-renamed-migrations.mjs
 *   npx dotenv -e .env.local -- node scripts/repair-renamed-migrations.mjs
 */
import pg from 'pg';

const RENAMES = [
  ['20260618121500_add-model-audit-columns', '20260618130100_add-model-audit-columns'],
  ['20260618130000_sync-changelog-version-1-27-0', '20260618130200_sync-changelog-version-1-27-0'],
  ['20260618150000_page-screenshots', '20260618130000_page-screenshots'],
  ['20260618140000_design-doc-prototype-link', '20260619000100_design-doc-prototype-link'],
  ['20260618140100_drop-design-doc-qa', '20260619000200_drop-design-doc-qa'],
  ['20260624120000_developer-workbench', '20260624140000_developer-workbench'],
];

function runOnFromMigrationName(name) {
  const ts = name.match(/^(\d{14})_/)?.[1];
  if (!ts) return null;
  return new Date(
    `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}.000Z`,
  );
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  const { rows } = await client.query('SELECT name FROM pgmigrations ORDER BY name');
  const applied = new Set(rows.map((r) => r.name));
  let renamed = 0;

  for (const [oldName, newName] of RENAMES) {
    if (!applied.has(oldName)) continue;
    if (applied.has(newName)) {
      console.log(`skip rename ${oldName} → ${newName} (canonical name already recorded)`);
      continue;
    }
    await client.query('UPDATE pgmigrations SET name = $1 WHERE name = $2', [newName, oldName]);
    applied.delete(oldName);
    applied.add(newName);
    console.log(`renamed ${oldName} → ${newName}`);
    renamed += 1;
  }

  const { rows: allRows } = await client.query('SELECT name FROM pgmigrations ORDER BY name');
  let realigned = 0;
  for (const { name } of allRows) {
    const runOn = runOnFromMigrationName(name);
    if (!runOn) continue;
    await client.query('UPDATE pgmigrations SET run_on = $1 WHERE name = $2', [runOn, name]);
    realigned += 1;
  }

  if (renamed === 0) {
    console.log('No renamed migration rows found.');
  } else {
    console.log(`Renamed ${renamed} pgmigrations row(s).`);
  }
  console.log(`Realigned run_on for ${realigned} migration row(s) to match filename order.`);
  console.log('Run: npx dotenv -e .env -- npm run migrate:up');
} finally {
  await client.end();
}
