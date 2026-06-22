/**
 * Simulates merge-to-main migration apply against a fresh Postgres instance:
 * 1. Apply migrations/ as they exist on the PR base commit (main)
 * 2. Apply migrations/ from the PR head (new/changed files)
 *
 * Requires DATABASE_URL and GITHUB_BASE_SHA.
 */
import { execSync } from 'node:child_process';

const databaseUrl = process.env.DATABASE_URL;
const baseSha = process.env.GITHUB_BASE_SHA;

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

if (!baseSha) {
  console.error('GITHUB_BASE_SHA is required');
  process.exit(1);
}

const env = { ...process.env, DATABASE_URL: databaseUrl };

function run(command) {
  console.log(`> ${command}`);
  execSync(command, { stdio: 'inherit', env });
}

console.log(`Applying base migrations from ${baseSha}...`);
run(`git checkout ${baseSha} -- migrations/`);
run('npx node-pg-migrate up');

console.log('Applying PR migration delta...');
run('git checkout HEAD -- migrations/');
run('npx node-pg-migrate up');

console.log('Migration validation passed.');
