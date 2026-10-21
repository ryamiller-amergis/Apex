/**
 * In-process egress recorder for the playbook engine verification spike (FEAT-001, TBI-005).
 *
 * TBI-005 asks whether the engine emits outbound telemetry, and its non-functional requirement is
 * that absence must be *measured* rather than assumed. This records every outbound attempt the
 * process makes, at three layers:
 *
 *   1. `undici:request:create` via diagnostics_channel — global `fetch` and undici clients.
 *   2. `http.request` / `https.request` / `.get` — the classic Node HTTP clients.
 *   3. `net.Socket.prototype.connect` — raw TCP, which catches anything the two layers above miss.
 *
 * This sits inside the process rather than on the network, which is deliberate: a proxy only sees
 * traffic from libraries that honour HTTP_PROXY, whereas a library that dials out directly would
 * slip past it unseen. The cost is that a native addon bypassing Node's socket layer would go
 * unrecorded — the control run is what rules that out. If the control run records nothing, the
 * recorder is broken and the result is void.
 */
import http from 'http';
import https from 'https';
import net from 'net';
import diagnosticsChannel from 'diagnostics_channel';

export type EgressLayer = 'undici' | 'http' | 'https' | 'tcp';

export interface EgressCall {
  layer: EgressLayer;
  method?: string;
  host: string;
  port?: number;
  path?: string;
  at: string;
}

export interface EgressRecorder {
  /** Every outbound attempt observed since start, in order. */
  readonly calls: EgressCall[];
  /** Calls excluding destinations matched by `isLocal` — what TBI-005 actually asserts on. */
  external(): EgressCall[];
  /** Restores every patched function. Safe to call twice. */
  stop(): void;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/** True for loopback destinations — the scratch database, not telemetry. */
export function isLocal(call: EgressCall): boolean {
  return LOCAL_HOSTS.has(call.host);
}

type RequestFn = typeof http.request;

function describeArgs(args: unknown[]): { host: string; port?: number; path?: string; method?: string } {
  const [first, second] = args;
  if (typeof first === 'string' || first instanceof URL) {
    const opts = (typeof second === 'object' && second !== null ? second : {}) as http.RequestOptions;
    try {
      const url = new URL(String(first));
      return {
        host: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: url.pathname + url.search,
        method: opts.method ?? 'GET',
      };
    } catch {
      // A recorder must never change the behaviour of the code it observes, so an unparseable
      // target is recorded verbatim rather than thrown.
      return { host: String(first), method: opts.method ?? 'GET' };
    }
  }
  const opts = (first ?? {}) as http.RequestOptions;
  return {
    host: opts.hostname ?? opts.host ?? 'unknown',
    port: typeof opts.port === 'string' ? Number(opts.port) : (opts.port ?? undefined),
    path: opts.path ?? undefined,
    method: opts.method ?? 'GET',
  };
}

/**
 * Socket.prototype.connect is reached by three different shapes: an options object from the http
 * agent, a `[options, callback]` array from `net.connect`/`net.createConnection` (which normalise
 * their arguments before delegating), and a positional `(port, host)` pair. Unix socket paths have
 * no host and are not egress, so they are skipped.
 */
function describeConnectArgs(args: unknown[]): { host: string; port?: number } | null {
  let first = args[0];
  let rest = args.slice(1);
  if (Array.isArray(first)) {
    rest = first.slice(1);
    first = first[0];
  }
  if (typeof first === 'number') {
    return { host: typeof rest[0] === 'string' ? (rest[0] as string) : 'localhost', port: first };
  }
  if (typeof first === 'object' && first !== null) {
    const opts = first as { host?: string; port?: number | string; path?: string };
    if (opts.path && opts.host === undefined && opts.port === undefined) return null;
    return {
      host: opts.host ?? 'unknown',
      port: typeof opts.port === 'string' ? Number(opts.port) : opts.port,
    };
  }
  return null;
}

export function startEgressRecorder(): EgressRecorder {
  const calls: EgressCall[] = [];
  const record = (call: Omit<EgressCall, 'at'>) => {
    calls.push({ ...call, at: new Date().toISOString() });
  };

  // --- Layer 1: undici / global fetch -------------------------------------------------------
  const onUndici = (message: unknown) => {
    const request = (message as { request?: { origin?: unknown; path?: string; method?: string } })?.request;
    if (!request) return;
    let host = 'unknown';
    let port: number | undefined;
    try {
      const origin = new URL(String(request.origin));
      host = origin.hostname;
      port = origin.port ? Number(origin.port) : undefined;
    } catch {
      /* origin may be absent on malformed requests — keep the record, mark it unknown. */
    }
    record({ layer: 'undici', method: request.method, host, port, path: request.path });
  };
  diagnosticsChannel.subscribe('undici:request:create', onUndici);

  // --- Layer 2: http / https clients --------------------------------------------------------
  const originals = {
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
  };

  const wrap = (fn: RequestFn, layer: 'http' | 'https'): RequestFn =>
    function patched(this: unknown, ...args: Parameters<RequestFn>) {
      record({ layer, ...describeArgs(args) });
      return (fn as (...a: unknown[]) => http.ClientRequest).apply(this, args);
    } as RequestFn;

  // `get` does not route through the module's exported `request`, so both need patching.
  http.request = wrap(originals.httpRequest, 'http');
  http.get = wrap(originals.httpGet, 'http');
  https.request = wrap(originals.httpsRequest, 'https');
  https.get = wrap(originals.httpsGet, 'https');

  // --- Layer 3: raw TCP ---------------------------------------------------------------------
  // Verified empirically: this fires for undici (`net.connect`), the http agent
  // (`net.createConnection`) and direct dials alike, so one hook covers all three.
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patchedConnect(this: net.Socket, ...args: unknown[]) {
    const target = describeConnectArgs(args);
    if (target) record({ layer: 'tcp', ...target });
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  let stopped = false;
  return {
    calls,
    external() {
      return calls.filter((c) => !isLocal(c));
    },
    stop() {
      if (stopped) return;
      stopped = true;
      diagnosticsChannel.unsubscribe('undici:request:create', onUndici);
      http.request = originals.httpRequest;
      http.get = originals.httpGet;
      https.request = originals.httpsRequest;
      https.get = originals.httpsGet;
      net.Socket.prototype.connect = originalConnect;
    },
  };
}

/**
 * Runs `fn` with a recorder active and restores every patch even if `fn` throws.
 *
 * Prefer this over calling `startEgressRecorder` directly. The recorder patches globals that the
 * test runner itself uses, so a failed assertion between start and stop would leave `http`,
 * `https` and `net` patched for the remainder of the worker's life — which hangs the run rather
 * than reporting the failure.
 */
export async function withEgressRecorder<T>(
  fn: (recorder: EgressRecorder) => Promise<T>
): Promise<{ result: T; calls: EgressCall[]; external: EgressCall[] }> {
  const recorder = startEgressRecorder();
  try {
    const result = await fn(recorder);
    return { result, calls: [...recorder.calls], external: recorder.external() };
  } finally {
    recorder.stop();
  }
}
