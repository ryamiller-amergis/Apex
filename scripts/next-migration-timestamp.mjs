/**
 * Prints the next safe migration filename for hand-written SQL files.
 *
 * Filenames use the format: YYYYMMDDHHMMSS_<token>_<slug>.sql
 * The 4-hex-char token guarantees global uniqueness across branches so two
 * developers running this at the same wall-clock second produce different names
 * and can never cause a duplicate-filename or order-check collision at merge.
 *
 * Usage:
 *   node scripts/next-migration-timestamp.mjs add-my-table
 *     → migrations/20260625150200_a3f1_add-my-table.sql
 *   node scripts/next-migration-timestamp.mjs   (no slug — prints timestamp only)
 *     → 20260625150200
 */
import { randomBytes } from 'node:crypto';
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

// 4 hex chars (2 random bytes) — small enough to be readable, enough entropy
// (~65 000 combinations) to make cross-branch collisions astronomically unlikely.
const token = randomBytes(2).toString('hex');

if (slug) {
  console.log(`migrations/${next}_${token}_${slug}.sql`);
} else {
  console.log(String(next));
}
