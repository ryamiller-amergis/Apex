/**
 * Pre-push Cursor Bugbot-style code review via @cursor/sdk.
 *
 * Reviews the branch diff against origin/main (or the upstream base) before
 * `git push` completes. Blocks the push (exit 1) when critical or high-severity
 * bugs are detected.
 *
 * Environment variables (loaded from .env / .env.local automatically):
 *   CURSOR_API_KEY          — Cursor API key used by @cursor/sdk
 *   CURSOR_PRE_PUSH_MODEL   — Model ID (default: composer-2.5)
 *   SKIP_CURSOR_PRE_PUSH=1  — Bypass this check for a single push
 *   CURSOR_PRE_PUSH_STRICT=1 — Block push if CURSOR_API_KEY is missing
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { Agent, CursorAgentError } from '@cursor/sdk';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const MAX_DIFF_CHARS = 60_000;

function git(command) {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch {
    return '';
  }
}

function resolveDiffRange() {
  const hasOriginMain = Boolean(git('git rev-parse --verify origin/main'));
  if (hasOriginMain) {
    const mergeBase = git('git merge-base origin/main HEAD');
    if (mergeBase) {
      return `${mergeBase}..HEAD`;
    }
  }
  const upstream = git('git rev-parse --abbrev-ref --symbolic-full-name @{u}');
  if (upstream) {
    return `${upstream}..HEAD`;
  }
  return 'HEAD~1..HEAD';
}

function buildPrompt(changedFiles, diffText) {
  return `
You are Cursor Bugbot running as a pre-push code review gate for the Apex repository.
Review the git diff below for real bugs only:
- Logic errors, broken control flow, null/undefined dereferences, race conditions
- Security issues (auth bypass, missing RBAC checks, secret leaks, injection, SSRF)
- Broken TypeScript/runtime contracts or unintended regressions

Do NOT flag:
- Style nitpicks, formatting, naming preferences, or speculative refactors
- Intentional test fixtures or mocks

Return ONLY a valid JSON object matching this exact schema (no markdown prose outside JSON):
{
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "file": "repo/relative/path.ts",
      "line": 42,
      "finding": "One concise sentence describing the bug and how to fix it."
    }
  ]
}

If there are no bugs, return:
{ "findings": [] }

Changed files:
${changedFiles.join('\n')}

Diff:
${diffText}
`.trim();
}

function parseFindings(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed?.findings)) return [];
    return parsed.findings.filter(
      (item) =>
        item &&
        typeof item === 'object' &&
        typeof item.severity === 'string' &&
        typeof item.file === 'string' &&
        typeof item.finding === 'string',
    );
  } catch {
    return [];
  }
}

async function main() {
  if (process.env.SKIP_CURSOR_PRE_PUSH === '1' || process.env.CI === 'true') {
    process.exit(0);
  }

  const range = resolveDiffRange();
  const changedFilesRaw = git(`git diff --name-only --diff-filter=ACMR ${range}`);
  const changedFiles = changedFilesRaw
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => !f.endsWith('.md') && !f.startsWith('data/'));

  if (changedFiles.length === 0) {
    process.exit(0);
  }

  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey) {
    const msg =
      '[cursor-pre-push] CURSOR_API_KEY is not set; skipping local Cursor review.';
    if (process.env.CURSOR_PRE_PUSH_STRICT === '1') {
      console.error(`${msg} (CURSOR_PRE_PUSH_STRICT=1)`);
      process.exit(1);
    }
    console.warn(msg);
    process.exit(0);
  }

  const rawDiff = git(`git diff ${range} -- ${changedFiles.map((f) => `"${f}"`).join(' ')}`);
  if (!rawDiff) {
    process.exit(0);
  }

  const diffText =
    rawDiff.length > MAX_DIFF_CHARS
      ? `${rawDiff.slice(0, MAX_DIFF_CHARS)}\n\n... [diff truncated at ${MAX_DIFF_CHARS} chars]`
      : rawDiff;

  const modelId = process.env.CURSOR_PRE_PUSH_MODEL?.trim() || 'composer-2.5';
  console.log(
    `[cursor-pre-push] Reviewing ${changedFiles.length} file(s) in ${range} with Cursor (${modelId})...`,
  );

  let rawResponse = '';
  try {
    const result = await Agent.prompt(buildPrompt(changedFiles, diffText), {
      apiKey,
      model: { id: modelId },
      tools: [],
      local: { cwd: process.cwd(), settingSources: [] },
    });
    rawResponse = result.result ?? '';
  } catch (err) {
    const detail =
      err instanceof CursorAgentError
        ? `${err.message} (retryable=${err.isRetryable})`
        : err instanceof Error
          ? err.message
          : String(err);
    console.warn(`[cursor-pre-push] Cursor review could not run: ${detail}`);
    process.exit(0);
  }

  const findings = parseFindings(rawResponse);
  if (findings.length === 0) {
    console.log('[cursor-pre-push] Bugbot found no bugs.');
    process.exit(0);
  }

  const blocking = findings.filter(
    (f) => f.severity === 'critical' || f.severity === 'high',
  );
  const nonBlocking = findings.filter(
    (f) => f.severity !== 'critical' && f.severity !== 'high',
  );

  for (const item of [...blocking, ...nonBlocking]) {
    const tag = item.severity.toUpperCase();
    const loc = item.line ? `${item.file}:${item.line}` : item.file;
    const logger =
      item.severity === 'critical' || item.severity === 'high'
        ? console.error
        : console.warn;
    logger(`  [${tag}] ${loc} — ${item.finding}`);
  }

  if (blocking.length > 0) {
    console.error(
      `\n[cursor-pre-push] Push blocked: ${blocking.length} high/critical finding(s). Fix them or push with SKIP_CURSOR_PRE_PUSH=1 to bypass.\n`,
    );
    process.exit(1);
  }

  console.log(
    `[cursor-pre-push] Passed (${nonBlocking.length} low/medium advisory finding(s)).`,
  );
  process.exit(0);
}

// Keep unused fs import for future cache extensions without lint complaints
void fs;

main().catch((err) => {
  console.warn('[cursor-pre-push] Unexpected error:', err);
  process.exit(0);
});
