/** grafana/k6 2.3.0, digest read from Docker Hub on 2026-10-27. */
export const K6_IMAGE =
  'grafana/k6:2.3.0@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8';

export const LOAD_TEST_DEFINITION = 'quality/load-test/profile-read.k6.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Pass or fail per NFR target. A target with no measurement is NOT MEASURED,
 * and the overall result passes only when every target passes.
 *
 * @param {{ targets: { responseTime: { percentile: number, maxMs: number }, concurrency: { users: number }, dataVolume: { table: string, rows: number } } }} manifest
 * @param {{ percentileMs?: number, vusMax?: number, failedRequests?: number, rows?: number }} measured
 */
export function evaluateTargets(manifest, measured) {
  const { responseTime, concurrency, dataVolume } = manifest.targets;
  const results = [];

  if (typeof measured.percentileMs === 'number') {
    results.push({
      target: 'responseTime',
      verdict: measured.percentileMs <= responseTime.maxMs ? 'PASS' : 'FAIL',
      detail: `p${responseTime.percentile} ${round(measured.percentileMs)} ms (target at most ${responseTime.maxMs} ms)`,
    });
  } else {
    results.push(
      notMeasured('responseTime', 'the load test reported no response times')
    );
  }

  if (
    typeof measured.vusMax === 'number' &&
    typeof measured.failedRequests === 'number'
  ) {
    const held = measured.vusMax >= concurrency.users;
    const clean = measured.failedRequests === 0;
    results.push({
      target: 'concurrency',
      verdict: held && clean ? 'PASS' : 'FAIL',
      detail: `${measured.vusMax} users held, ${measured.failedRequests} failed request(s) (target ${concurrency.users} users, no failures)`,
    });
  } else {
    results.push(
      notMeasured(
        'concurrency',
        'the load test reported no user or failure counts'
      )
    );
  }

  if (typeof measured.rows === 'number') {
    results.push({
      target: 'dataVolume',
      verdict: measured.rows >= dataVolume.rows ? 'PASS' : 'FAIL',
      detail: `${measured.rows} rows in ${dataVolume.table} (target at least ${dataVolume.rows})`,
    });
  } else {
    results.push(
      notMeasured('dataVolume', 'set LOAD_TEST_DATABASE_URL to count rows')
    );
  }

  return {
    results,
    pass: results.every((result) => result.verdict === 'PASS'),
  };
}

function notMeasured(target, detail) {
  return { target, verdict: 'NOT MEASURED', detail };
}

function round(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Reads the measurements from a k6 handleSummary export. Missing metrics stay
 * undefined, so evaluateTargets reports them as NOT MEASURED.
 */
export function measurementsFromSummary(summary, percentile) {
  const metrics = summary?.metrics ?? {};
  const duration = metrics.http_req_duration?.values?.[`p(${percentile})`];
  const vus = metrics.vus_max?.values;
  const failed = metrics.http_req_failed?.values;
  return {
    percentileMs: typeof duration === 'number' ? duration : undefined,
    vusMax: typeof vus?.max === 'number' ? vus.max : vus?.value,
    failedRequests:
      typeof failed?.passes === 'number' ? failed.passes : undefined,
  };
}

/**
 * Parses LOAD_TEST_BASE_URL. Returns the URL to print (no credentials, no
 * trailing slash) and the URL the k6 container uses, where a local host
 * becomes host.docker.internal.
 */
export function resolveTarget(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return undefined;
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  const display = `${url.origin}${pathname}`;
  const container = new URL(display);
  if (LOCAL_HOSTS.has(container.hostname)) {
    container.hostname = 'host.docker.internal';
  }
  return {
    display,
    container: `${container.origin}${pathname}`,
    usesHostGateway: LOCAL_HOSTS.has(url.hostname),
  };
}
