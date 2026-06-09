import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { EslintMetricsSnapshot } from '../types/workitem';

interface EslintJsonResult {
  filePath: string;
  errorCount?: number;
  warningCount?: number;
  fixableErrorCount?: number;
  fixableWarningCount?: number;
  messages?: Array<{
    ruleId?: string | null;
    severity?: number;
  }>;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

const DEFAULT_ESLINT_COMMAND = 'npm run --silent lint:check -- --format json';
const DEFAULT_TIMEOUT_MS = 120000;

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
        env: process.env,
      },
      (_error, stdout, stderr) => {
        resolve({ stdout, stderr });
      },
    );
  });
}

function parseEslintJson(output: string): EslintJsonResult[] {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error('ESLint did not return JSON output. Ensure MAXVIEW_ESLINT_COMMAND includes "--format json".');
  }

  try {
    return JSON.parse(trimmed) as EslintJsonResult[];
  } catch {
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('Unable to parse ESLint JSON output. Ensure MAXVIEW_ESLINT_COMMAND uses the JSON formatter.');
    }
    return JSON.parse(trimmed.slice(start, end + 1)) as EslintJsonResult[];
  }
}

function toRelativePath(filePath: string, repoPath: string): string {
  const relative = path.relative(repoPath, filePath);
  return relative && !relative.startsWith('..') ? relative.replace(/\\/g, '/') : filePath.replace(/\\/g, '/');
}

export async function getMaxViewEslintSnapshot(): Promise<EslintMetricsSnapshot> {
  const repoPath = process.env.MAXVIEW_REPO_PATH?.trim();
  if (!repoPath) {
    throw new Error('MAXVIEW_REPO_PATH is not configured');
  }
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    throw new Error(`MAXVIEW_REPO_PATH does not exist or is not a directory: ${repoPath}`);
  }

  const command = process.env.MAXVIEW_ESLINT_COMMAND?.trim() || DEFAULT_ESLINT_COMMAND;
  const timeoutMs = Number(process.env.MAXVIEW_ESLINT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const result = await runCommand(command, repoPath, Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS);
  const eslintResults = parseEslintJson(result.stdout);

  const topRules = new Map<string, { ruleId: string; count: number; errorCount: number; warningCount: number }>();
  const topFiles: EslintMetricsSnapshot['topFiles'] = [];

  let totalFiles = 0;
  let filesWithIssues = 0;
  let errorCount = 0;
  let warningCount = 0;
  let fixableErrorCount = 0;
  let fixableWarningCount = 0;

  for (const file of eslintResults) {
    totalFiles += 1;
    const fileErrors = file.errorCount ?? 0;
    const fileWarnings = file.warningCount ?? 0;
    const fileIssueCount = fileErrors + fileWarnings;

    errorCount += fileErrors;
    warningCount += fileWarnings;
    fixableErrorCount += file.fixableErrorCount ?? 0;
    fixableWarningCount += file.fixableWarningCount ?? 0;

    if (fileIssueCount > 0) {
      filesWithIssues += 1;
      topFiles.push({
        filePath: toRelativePath(file.filePath, repoPath),
        errorCount: fileErrors,
        warningCount: fileWarnings,
        issueCount: fileIssueCount,
      });
    }

    for (const message of file.messages ?? []) {
      const ruleId = message.ruleId ?? 'fatal-parser-error';
      const bucket = topRules.get(ruleId) ?? { ruleId, count: 0, errorCount: 0, warningCount: 0 };
      bucket.count += 1;
      if (message.severity === 2) {
        bucket.errorCount += 1;
      } else {
        bucket.warningCount += 1;
      }
      topRules.set(ruleId, bucket);
    }
  }

  return {
    repoName: 'MaxView',
    capturedAt: new Date().toISOString(),
    totalFiles,
    filesWithIssues,
    errorCount,
    warningCount,
    fixableErrorCount,
    fixableWarningCount,
    issueCount: errorCount + warningCount,
    topRules: Array.from(topRules.values())
      .sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId))
      .slice(0, 10),
    topFiles: topFiles
      .sort((a, b) => b.issueCount - a.issueCount || a.filePath.localeCompare(b.filePath))
      .slice(0, 10),
    stderr: result.stderr.trim() || undefined,
  };
}
