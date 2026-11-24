/* global __ENV, __VU, __ITER */
/**
 * VT-50 — Chat Harness k6 smoke & concurrency load check.
 *
 * Models:
 *  - 50 concurrent open WebSocket connections (`vus: 50`) subscribed to
 *    `/api/interactive/threads/:id/stream`.
 *  - 10 concurrent turn submissions per project against
 *    `POST /api/harness/threads/:id/commands` and reload verification via
 *    `GET /api/harness/threads/:id/snapshot`.
 *
 * Thresholds (per FEAT-002 NFR / VT-50):
 *  - `harness_command_receipt_ms`: p(95) < 500 ms
 *  - `harness_snapshot_ms`:        p(95) < 2000 ms
 *  - `http_req_failed`:            rate < 0.01
 *
 * Usage:
 *   k6 run \
 *     -e BASE_URL=https://apex-dev.example.com \
 *     -e AUTH_COOKIE="connect.sid=..." \
 *     -e THREAD_IDS="uuid-1,uuid-2,..." \
 *     scripts/load-tests/chat-harness-smoke.k6.js
 */
import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
const WS_BASE_URL = BASE_URL.replace(/^http/, 'ws');
const AUTH_COOKIE = __ENV.AUTH_COOKIE || '';
const THREAD_IDS = (__ENV.THREAD_IDS || '10000000-0000-4000-8000-000000000001')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const DURATION = __ENV.DURATION || '60s';

export const harnessCommandReceiptMs = new Trend('harness_command_receipt_ms', true);
export const harnessSnapshotMs = new Trend('harness_snapshot_ms', true);
export const harnessWsStateFrames = new Counter('harness_ws_state_frames');

export const options = {
  scenarios: {
    // 50 open WebSocket connections per project streaming state + live frames
    wsOpenConnections: {
      executor: 'constant-vus',
      exec: 'openWebSocketStream',
      vus: 50,
      duration: DURATION,
    },
    // 10 concurrent turn submissions + snapshot checks per project
    concurrentTurns: {
      executor: 'constant-vus',
      exec: 'submitTurnAndSnapshot',
      vus: 10,
      duration: DURATION,
    },
  },
  thresholds: {
    harness_command_receipt_ms: ['p(95)<500'],
    harness_snapshot_ms: ['p(95)<2000'],
    http_req_failed: ['rate<0.01'],
  },
};

function requestHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (AUTH_COOKIE) {
    headers.Cookie = AUTH_COOKIE;
  }
  return headers;
}

function pickThreadId() {
  return THREAD_IDS[(__VU - 1) % THREAD_IDS.length];
}

function deterministicUuid(vu, iter) {
  const a = String(vu % 10000).padStart(4, '0');
  const b = String(iter % 1000000000000).padStart(12, '0');
  return `90000000-${a}-4000-8000-${b}`;
}

export function openWebSocketStream() {
  const threadId = pickThreadId();
  const url = `${WS_BASE_URL}/api/interactive/threads/${threadId}/stream`;
  const params = AUTH_COOKIE ? { headers: { Cookie: AUTH_COOKIE } } : {};

  const res = ws.connect(url, params, (socket) => {
    socket.on('message', (raw) => {
      try {
        const frame = JSON.parse(raw);
        if (frame && frame.type === 'state') {
          harnessWsStateFrames.add(1);
        }
      } catch {
        // Ignore non-JSON keepalive frames
      }
    });

    socket.setTimeout(() => {
      socket.close();
    }, 10000);
  });

  check(res, {
    'ws upgraded (101)': (r) => r && r.status === 101,
  });
  sleep(1);
}

export function submitTurnAndSnapshot() {
  const threadId = pickThreadId();
  const headers = requestHeaders();
  const commandId = deterministicUuid(__VU, __ITER);

  const cmdStart = Date.now();
  const cmdRes = http.post(
    `${BASE_URL}/api/harness/threads/${threadId}/commands`,
    JSON.stringify({
      commandId,
      kind: 'send',
      text: `Load check turn vu=${__VU} iter=${__ITER}`,
    }),
    { headers },
  );
  harnessCommandReceiptMs.add(Date.now() - cmdStart);

  check(cmdRes, {
    'command receipt status 200': (r) => r.status === 200,
    'command receipt has commandId': (r) => {
      try {
        const body = r.json();
        return body && body.commandId === commandId;
      } catch {
        return false;
      }
    },
  });

  const snapStart = Date.now();
  const snapRes = http.get(
    `${BASE_URL}/api/harness/threads/${threadId}/snapshot`,
    { headers },
  );
  harnessSnapshotMs.add(Date.now() - snapStart);

  check(snapRes, {
    'snapshot status 200': (r) => r.status === 200,
    'snapshot has state': (r) => {
      try {
        const body = r.json();
        return Boolean(body && body.state && Array.isArray(body.messages));
      } catch {
        return false;
      }
    },
  });

  sleep(1);
}
