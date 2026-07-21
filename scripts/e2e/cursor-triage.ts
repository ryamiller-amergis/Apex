/**
 * Cursor Enterprise SDK failure triage script.
 *
 * When Playwright tests fail, this script feeds the failure metadata to a
 * Cursor agent and requests a structured classification. It produces a JSON
 * report only — it cannot change the CI job result, and the agent is
 * prohibited from rewriting test files as part of this script.
 *
 * Usage (manually or via CI failure hook):
 *   ts-node -P tsconfig.server.json scripts/e2e/cursor-triage.ts \
 *     --results-dir playwright-results \
 *     --run-id <github-run-id>
 *
 * Required environment variables:
 *   CURSOR_API_KEY  — Cursor Enterprise service-account key
 *
 * Prerequisites:
 *   Verify Cursor Enterprise service-account entitlement before enabling in CI.
 *   Playwright delivery is independent of this script.
 */

import fs from 'fs';
import path from 'path';
import { Agent, CursorAgentError } from '@cursor/sdk';

// ── Types ──────────────────────────────────────────────────────────────────────

interface TriageResult {
  testName: string;
  classification: 'product_defect' | 'test_defect' | 'environment_issue' | 'probable_flake';
  evidence: string;
  suggestedAction: string;
}

interface TriageReport {
  runId: string;
  timestamp: string;
  totalFailed: number;
  results: TriageResult[];
}

// ── Argument parsing ───────────────────────────────────────────────────────────

function parseArgs(): { resultsDir: string; runId: string } {
  const args = process.argv.slice(2);
  let resultsDir = 'playwright-results';
  let runId = 'local';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--results-dir' && args[i + 1]) {
      resultsDir = args[i + 1];
      i++;
    } else if (args[i] === '--run-id' && args[i + 1]) {
      runId = args[i + 1];
      i++;
    }
  }

  return { resultsDir, runId };
}

// ── JUnit parser ──────────────────────────────────────────────────────────────

interface FailedTest {
  name: string;
  classname: string;
  failure?: string;
  error?: string;
}

function extractFailedTestsFromJUnit(resultsDir: string): FailedTest[] {
  const junitPath = path.join(resultsDir, 'results.xml');
  if (!fs.existsSync(junitPath)) {
    console.warn('[cursor-triage] No JUnit results found at', junitPath);
    return [];
  }

  const xml = fs.readFileSync(junitPath, 'utf8');
  const failed: FailedTest[] = [];

  // Minimal regex-based extraction — avoids adding an XML parser dependency.
  const testcaseRegex = /<testcase[^>]+name="([^"]+)"[^>]+classname="([^"]+)"[^>]*>([\s\S]*?)<\/testcase>/g;
  const failureRegex = /<failure[^>]*>([\s\S]*?)<\/failure>/;
  const errorRegex = /<error[^>]*>([\s\S]*?)<\/error>/;

  let match: RegExpExecArray | null;
  while ((match = testcaseRegex.exec(xml)) !== null) {
    const [, name, classname, body] = match;
    const failureMatch = failureRegex.exec(body);
    const errorMatch = errorRegex.exec(body);

    if (failureMatch || errorMatch) {
      failed.push({
        name,
        classname,
        failure: failureMatch?.[1]?.trim(),
        error: errorMatch?.[1]?.trim(),
      });
    }
  }

  return failed;
}

// ── Cursor triage ─────────────────────────────────────────────────────────────

const TRIAGE_PROMPT_TEMPLATE = (tests: FailedTest[]) => `
You are a senior QA engineer triaging Playwright E2E test failures for the Apex web application.

Classify each failed test into exactly one of:
- product_defect: The application has a bug that caused this test to fail.
- test_defect: The test itself is incorrect, brittle, or uses wrong selectors.
- environment_issue: A CI/infrastructure problem unrelated to product or test correctness.
- probable_flake: Timing or state-dependent failure that is likely non-deterministic.

For each test, provide:
1. classification (one of the four values above)
2. evidence: 1-2 sentences citing the failure message
3. suggestedAction: concrete next step

Do NOT suggest rewriting or modifying any test files. Do NOT suggest changing the CI result.
Return your response as a valid JSON array with objects matching:
{ "testName": string, "classification": string, "evidence": string, "suggestedAction": string }

Failed tests:
${tests
  .map(
    (t, i) => `
Test ${i + 1}: ${t.name}
Class: ${t.classname}
Failure: ${(t.failure ?? t.error ?? 'No details').slice(0, 800)}
`,
  )
  .join('\n---\n')}
`.trim();

async function triageWithCursor(
  tests: FailedTest[],
  runId: string,
): Promise<TriageReport> {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    throw new Error('[cursor-triage] CURSOR_API_KEY is not set. Verify Cursor Enterprise entitlement first.');
  }

  console.log(`[cursor-triage] Triaging ${tests.length} failed test(s)...`);

  let rawResponse = '';

  try {
    const result = await Agent.prompt(TRIAGE_PROMPT_TEMPLATE(tests), {
      apiKey,
      model: { id: 'composer-2.5' },
      local: { cwd: process.cwd(), settingSources: [] },
    });

    rawResponse = result.result ?? '';
  } catch (err) {
    if (err instanceof CursorAgentError) {
      throw new Error(
        `[cursor-triage] Cursor SDK startup failed (retryable=${err.isRetryable}): ${err.message}`,
      );
    }
    throw err;
  }

  // Extract JSON from the response (agent may wrap it in a code block).
  const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
  const parsed: TriageResult[] = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

  return {
    runId,
    timestamp: new Date().toISOString(),
    totalFailed: tests.length,
    results: parsed,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { resultsDir, runId } = parseArgs();

  const failedTests = extractFailedTestsFromJUnit(resultsDir);

  if (failedTests.length === 0) {
    console.log('[cursor-triage] No failed tests found. Nothing to triage.');
    process.exit(0);
  }

  console.log(`[cursor-triage] Found ${failedTests.length} failed test(s).`);

  const report = await triageWithCursor(failedTests, runId);

  const reportPath = path.join(resultsDir, 'cursor-triage-report.json');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(`[cursor-triage] Report written to ${reportPath}`);
  console.log('\nTriage summary:');
  for (const r of report.results) {
    console.log(`  ${r.testName}: ${r.classification} — ${r.suggestedAction}`);
  }

  // Exit 0 regardless — triage is informational; it must never block CI.
  process.exit(0);
}

main().catch((err) => {
  console.error('[cursor-triage] Fatal error:', err);
  // Still exit 0: the triage script failing should not block the CI pipeline.
  process.exit(0);
});
