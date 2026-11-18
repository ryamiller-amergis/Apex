/**
 * Exports finished cloud-agent runs, scores them, and opens the local report.
 * Promptfoo exits non-zero when a run misses the rubric. The page still opens.
 *
 * Usage: npm run cloud-agent:report
 */
import { spawnSync } from 'node:child_process';

function run(args) {
  const result = spawnSync('npx', args, {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, CLOUD_AGENT_REPORT: '1' },
  });
  return result.status ?? 1;
}

const exported = run([
  'ts-node',
  '-P',
  'tsconfig.server.json',
  'scripts/export-cloud-agent-eval-cases.ts',
]);
if (exported !== 0) process.exit(exported);

run(['promptfoo', 'eval', '-c', 'evals/cloud-agent/promptfooconfig.yaml']);
process.exit(run(['promptfoo', 'view']));
