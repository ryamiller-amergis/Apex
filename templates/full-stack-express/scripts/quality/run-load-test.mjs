import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOCKER_UNAVAILABLE,
  dockerAvailable,
} from '../supply-chain/docker.mjs';
import { runCommand } from '../supply-chain/run-command.mjs';
import {
  evaluateTargets,
  K6_IMAGE,
  LOAD_TEST_DEFINITION,
  measurementsFromSummary,
  resolveTarget,
} from './lib/load-test.mjs';
import { validateManifests } from './lib/manifests.mjs';
import { findingLine } from './lib/report.mjs';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);
const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_CANNOT_RUN = 2;
const PROBE_LIMIT_MS = 5000;

function stop(code, message) {
  console.error(`loadtest:run: ${message}`);
  process.exit(code);
}

async function probe(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health/live`, {
      signal: AbortSignal.timeout(PROBE_LIMIT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function countRows(connectionString, table) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    // table matches ^[a-z_][a-z0-9_]*$ in the schema, so quoting is enough.
    const result = await client.query(
      `SELECT count(*)::bigint AS rows FROM "${table}"`
    );
    await client.query('COMMIT');
    return { rows: Number(result.rows[0].rows) };
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? error.code
        : 'unknown';
    return { failure: `could not count rows in ${table} (error code ${code})` };
  } finally {
    await client.end().catch(() => {});
  }
}

const rawBaseUrl = process.env.LOAD_TEST_BASE_URL;
if (!rawBaseUrl || !rawBaseUrl.trim()) {
  stop(
    EXIT_CANNOT_RUN,
    'LOAD_TEST_BASE_URL is not set. Set it to the base URL of the environment to test. There is no default.'
  );
}
const target = resolveTarget(rawBaseUrl.trim());
if (!target) {
  stop(EXIT_CANNOT_RUN, 'LOAD_TEST_BASE_URL must be an http or https URL.');
}
const durationSeconds = process.env.LOAD_TEST_DURATION_SECONDS ?? '30';
if (!/^[1-9]\d*$/.test(durationSeconds)) {
  stop(
    EXIT_CANNOT_RUN,
    'LOAD_TEST_DURATION_SECONDS must be a positive whole number.'
  );
}

const validation = await validateManifests(root);
if (validation.errors.length > 0) {
  for (const finding of validation.errors) {
    console.error(findingLine('ERROR', finding));
  }
  stop(EXIT_CANNOT_RUN, 'fix the manifest errors above, then run again.');
}
if (!existsSync(path.join(root, LOAD_TEST_DEFINITION))) {
  stop(EXIT_CANNOT_RUN, `${LOAD_TEST_DEFINITION} is missing.`);
}
const manifest = validation.nfr;
const { responseTime, dataVolume } = manifest.targets;

console.log(`Target: ${target.display}`);
if (!(await probe(target.display))) {
  stop(
    EXIT_FAIL,
    `cannot reach ${target.display}/health/live. Start the API or check LOAD_TEST_BASE_URL.`
  );
}
if (!(await dockerAvailable())) {
  stop(
    EXIT_CANNOT_RUN,
    `${DOCKER_UNAVAILABLE} The load test runs k6 in a container.`
  );
}

const outDir = mkdtempSync(path.join(tmpdir(), 'loadtest-'));
// The k6 image runs as a non-root user and must write the summary here.
chmodSync(outDir, 0o777);
try {
  const args = [
    'run',
    '--rm',
    '--mount',
    `type=bind,source=${path.join(root, 'quality')},target=/quality,readonly`,
    '--mount',
    `type=bind,source=${outDir},target=/out`,
    '-e',
    'LOAD_TEST_BASE_URL',
    '-e',
    'LOAD_TEST_DURATION_SECONDS',
    '-e',
    'LOAD_TEST_SUMMARY_PATH',
  ];
  if (target.usesHostGateway) {
    args.push('--add-host', 'host.docker.internal:host-gateway');
  }
  if (process.env.LOAD_TEST_AUTH_HEADER) {
    // Name only: docker reads the value from this process's environment.
    args.push('-e', 'LOAD_TEST_AUTH_HEADER');
  }
  args.push(K6_IMAGE, 'run', '--quiet', `/${LOAD_TEST_DEFINITION}`);

  const childEnv = {
    ...process.env,
    LOAD_TEST_BASE_URL: target.container,
    LOAD_TEST_DURATION_SECONDS: durationSeconds,
    LOAD_TEST_SUMMARY_PATH: '/out/summary.json',
  };
  delete childEnv.LOAD_TEST_DATABASE_URL;

  console.log(
    `Running ${LOAD_TEST_DEFINITION} for ${durationSeconds}s with ${K6_IMAGE}`
  );
  const run = await runCommand('docker', args, {
    env: childEnv,
    stdio: 'inherit',
  });
  if (run.error) {
    throw new Error('loadtest:run: could not start docker.');
  }

  const summaryFile = path.join(outDir, 'summary.json');
  const summary = existsSync(summaryFile)
    ? JSON.parse(readFileSync(summaryFile, 'utf8'))
    : undefined;
  const measured = measurementsFromSummary(summary, responseTime.percentile);

  if (process.env.LOAD_TEST_DATABASE_URL) {
    const counted = await countRows(
      process.env.LOAD_TEST_DATABASE_URL,
      dataVolume.table
    );
    if (counted.failure) {
      console.warn(`WARN ${counted.failure}`);
    } else {
      measured.rows = counted.rows;
    }
  }

  const verdict = evaluateTargets(manifest, measured);
  console.log('');
  for (const result of verdict.results) {
    console.log(
      `${result.verdict.padEnd(12)} ${result.target.padEnd(12)} ${result.detail}`
    );
  }
  console.log(
    `loadtest:run: ${verdict.pass ? 'all targets passed' : 'not every target passed'}`
  );
  process.exitCode = verdict.pass ? EXIT_PASS : EXIT_FAIL;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
