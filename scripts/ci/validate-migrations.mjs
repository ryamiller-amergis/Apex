/**
 * Simulates merge-to-main migration apply against a fresh Postgres instance:
 * 1. Fetch and apply migrations/ as they exist on the latest origin/main.
 * 2. Apply migrations/ from the PR head (new/changed files) with --no-check-order.
 *
 * Using origin/main rather than GITHUB_BASE_SHA ensures the PR is always validated
 * against the real current state of main, not the potentially stale snapshot taken
 * when the PR was opened. This catches genuine same-object conflicts between
 * concurrent PRs before they reach the deploy pipeline.
 *
 * Requires DATABASE_URL.
 */
import { execSync } from 'node:child_process';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const env = { ...process.env, DATABASE_URL: databaseUrl };

function run(command) {
  console.log(`> ${command}`);
  execSync(command, { stdio: 'inherit', env });
}

// Fetch the latest main so origin/main always reflects the current branch tip
// regardless of when the PR was opened.
console.log('Fetching latest origin/main...');
run('git fetch origin main');

console.log('Applying base migrations from origin/main...');
run('git checkout origin/main -- migrations/');
run('npx node-pg-migrate up --no-check-order');

console.log('Applying PR migration delta...');
run('git checkout HEAD -- migrations/');
run('npx node-pg-migrate up --no-check-order');

console.log('Migration validation passed.');
