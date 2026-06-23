/**
 * Prints the next safe migration filename for hand-written SQL files.
 * Prefer `npm run migrate:local:create -- slug` for normal schema migrations.
 *
 * Usage:
 *   node scripts/next-migration-timestamp.mjs
 *     → 20260618140200
 *   node scripts/next-migration-timestamp.mjs sync-changelog-version-1-28-0
 *     → migrations/20260618140200_sync-changelog-version-1-28-0.sql
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const slug = process.argv[2]?.replace(/^_+/, '') ?? null;

const migrationsDir = join(process.cwd(), 'migrations');
const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));

const timestamps = files
  .map((f) => {
    const match = /^(\d+)_/.exec(f);
    return match ? BigInt(match[1]) : null;
  })
  .filter((t) => t !== null);

const latest = timestamps.reduce((max, t) => (t > max ? t : max), 0n);
const now = BigInt(
  new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14),
);

// Prefer current time when ahead of latest file; otherwise bump latest by 100
// (leaves room for paired migrations like 140000 + 140100).
const next = now > latest ? now : latest + 100n;

if (slug) {
  console.log(`migrations/${next}_${slug}.sql`);
} else {
  console.log(String(next));
}
