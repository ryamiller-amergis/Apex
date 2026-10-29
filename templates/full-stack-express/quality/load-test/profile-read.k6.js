/* global open, __ENV */
// Sample k6 load test. Every target comes from quality/nfr-manifest.json, so
// this file holds no target numbers. Start it with `pnpm loadtest:run`.
import http from 'k6/http';
import { check, sleep } from 'k6';

const manifest = JSON.parse(open('../nfr-manifest.json'));
const { responseTime, concurrency } = manifest.targets;
const percentileStat = `p(${responseTime.percentile})`;
const baseUrl = __ENV.LOAD_TEST_BASE_URL;
const authHeader = __ENV.LOAD_TEST_AUTH_HEADER;
const durationSeconds = Number(__ENV.LOAD_TEST_DURATION_SECONDS || '30');

export const options = {
  scenarios: {
    profileRead: {
      executor: 'constant-vus',
      vus: concurrency.users,
      duration: `${durationSeconds}s`,
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', percentileStat],
  thresholds: {
    http_req_duration: [`${percentileStat}<=${responseTime.maxMs}`],
    http_req_failed: ['rate==0'],
  },
};

export default function () {
  const params = authHeader ? { headers: { Authorization: authHeader } } : {};
  const response = http.get(`${baseUrl}/api/v1/me`, params);
  check(response, { 'status is 200': (r) => r.status === 200 });
  sleep(1);
}

export function handleSummary(data) {
  const summaryPath = __ENV.LOAD_TEST_SUMMARY_PATH;
  return summaryPath ? { [summaryPath]: JSON.stringify(data) } : {};
}
