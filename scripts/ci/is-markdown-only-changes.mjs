/**
 * Detects whether a pull request only changes Markdown (.md) files.
 *
 * pull_request: true when every changed file between base and head ends with .md.
 * Other events: always false.
 *
 * Writes markdown_only=true|false to GITHUB_OUTPUT when set.
 */
import { execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

function getChangedFiles(base, head) {
  if (!base || !head) return null;
  const diff = execSync(`git diff --name-only ${base} ${head}`, {
    encoding: 'utf8',
  }).trim();
  if (!diff) return [];
  return diff.split('\n').filter(Boolean);
}

function writeGithubOutput(value) {
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(output, `markdown_only=${value}\n`);
  }
}

const eventName = process.env.GITHUB_EVENT_NAME ?? 'push';

if (eventName !== 'pull_request') {
  writeGithubOutput('false');
  console.log('markdown_only=false (not a pull_request event)');
  process.exit(0);
}

const base = process.env.GITHUB_BASE_SHA;
const head = process.env.GITHUB_SHA ?? 'HEAD';
const files = getChangedFiles(base, head);

if (files === null) {
  console.error('pull_request requires GITHUB_BASE_SHA and GITHUB_SHA');
  process.exit(1);
}

const markdownOnly = files.length > 0 && files.every((file) => file.endsWith('.md'));
const value = markdownOnly ? 'true' : 'false';

writeGithubOutput(value);
console.log(
  markdownOnly
    ? `Markdown-only PR (${files.length} file(s)): ${files.join(', ')}`
    : files.length === 0
      ? 'No file changes detected'
      : `Non-markdown files changed (${files.length} total)`,
);
console.log(`markdown_only=${value}`);
process.exit(0);
