/**
 * Writes a promptfoo case file from finished cloud-agent runs.
 *
 * The file contains the saved prompt head and the outcome signals Apex already
 * stores (pull request, unit/e2e/WCAG checks, leftover acceptance criteria).
 * Promptfoo then shows which runs missed the outcome you wanted.
 *
 * Usage:
 *   npm run cloud-agent:report
 *   npx ts-node --project tsconfig.server.json scripts/export-cloud-agent-eval-cases.ts
 *   npx ts-node --project tsconfig.server.json scripts/export-cloud-agent-eval-cases.ts --limit 20
 *   npx ts-node --project tsconfig.server.json scripts/export-cloud-agent-eval-cases.ts --example
 */
import { config as loadEnv } from 'dotenv';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import {
  formatCloudAgentEvalReport,
  sampleCloudAgentEvalCases,
  scoreCloudAgentEvalCase,
  summarizeCloudAgentEval,
  type CloudAgentEvalCase,
  type CloudAgentEvalScore,
  type CloudAgentEvalSummary,
} from '../src/shared/utils/cloudAgentEval';

const DEFAULT_CASES = path.join('evals', 'cloud-agent', 'cases.json');
const DEFAULT_SUMMARY = path.join('evals', 'cloud-agent', 'summary.json');

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} needs a value.`);
  }
  return value;
}

function readLimit(): number {
  const raw = readArg('--limit') ?? '20';
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('--limit must be an integer from 1 to 100.');
  }
  return limit;
}

interface PromptfooTest {
  description: string;
  vars: {
    report: string;
  };
  metadata: {
    scoreJson: string;
  };
}

function toPromptfooTests(
  rows: Array<{ evalCase: CloudAgentEvalCase; score: CloudAgentEvalScore }>,
): PromptfooTest[] {
  return rows.map(({ evalCase, score }) => ({
    description: `${evalCase.kind} · ${evalCase.title} · ${evalCase.runId}`,
    vars: {
      report: formatCloudAgentEvalReport(evalCase, score),
    },
    metadata: {
      scoreJson: JSON.stringify(score),
    },
  }));
}

function printSummary(summary: CloudAgentEvalSummary): void {
  console.log(`Finished cloud-agent runs: ${summary.total}`);
  console.log(`Outcome: ${summary.pass} pass, ${summary.fail} fail, ${summary.gap} gap`);
  if (summary.outcomeMisses.length > 0) {
    console.log('Outcome misses:');
    for (const miss of summary.outcomeMisses) {
      const parts = [
        miss.fail > 0 ? `${miss.fail} fail` : null,
        miss.gap > 0 ? `${miss.gap} gap` : null,
      ].filter((part): part is string => Boolean(part));
      console.log(`- ${miss.label}: ${parts.join(', ')}`);
    }
  }
  if (summary.promptMisses.length > 0) {
    console.log('Prompt rules missing:');
    for (const miss of summary.promptMisses) {
      console.log(`- ${miss.count} ${miss.label}`);
    }
  }
}

async function writeScorecard(cases: CloudAgentEvalCase[], casesPath: string, summaryPath: string): Promise<void> {
  const scored = cases.map((evalCase) => ({
    kind: evalCase.kind,
    evalCase,
    score: scoreCloudAgentEvalCase(evalCase),
  }));
  const summary = summarizeCloudAgentEval(scored);
  await mkdir(path.dirname(casesPath), { recursive: true });
  await writeFile(casesPath, `${JSON.stringify(toPromptfooTests(scored), null, 2)}\n`);
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  printSummary(summary);
  console.log(`Wrote ${scored.length} cases to ${casesPath}`);
  if (process.env.CLOUD_AGENT_REPORT === '1') return;
  console.log('Open the report with: npm run cloud-agent:report');
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('Export finished cloud-agent runs to evals/cloud-agent/cases.json');
    console.log('  --example   write four sample runs and skip the database');
    console.log('  --limit N   how many finished runs to export (1-100, default 20)');
    console.log('  --out path  case file (default evals/cloud-agent/cases.json)');
    console.log('  --summary path');
    return;
  }

  loadEnv({ path: '.env.local' });
  loadEnv();

  const casesPath = path.resolve(readArg('--out') ?? DEFAULT_CASES);
  const summaryPath = path.resolve(readArg('--summary') ?? DEFAULT_SUMMARY);
  if (process.argv.includes('--example')) {
    await writeScorecard(sampleCloudAgentEvalCases(), casesPath, summaryPath);
    return;
  }

  // Require after env is loaded. A static import would open the pool first.
  const { loadCloudAgentEvalCases } = require('../src/server/services/cloudAgentEvalCases') as typeof import('../src/server/services/cloudAgentEvalCases');
  const pool = (require('../src/server/db') as typeof import('../src/server/db')).default;
  try {
    const cases = await loadCloudAgentEvalCases(readLimit());
    if (cases.length === 0) {
      console.log('No finished cloud-agent runs. Re-run with --example to write a sample scorecard.');
      return;
    }
    await writeScorecard(cases, casesPath, summaryPath);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
