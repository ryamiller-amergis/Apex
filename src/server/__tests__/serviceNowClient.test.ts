/**
 * Unit tests for serviceNowClient. `fetch` and `sleep` are injected; no network is used.
 */

import {
  ServiceNowRequestError,
  isServiceNowConfigured,
  listAllIncidentsUpdatedSince,
  listIncidentsUpdatedSince,
  resetServiceNowTokenCache,
  type ServiceNowClientDeps,
} from '../services/serviceNowClient';

const INSTANCE = 'https://snow.example.test';
const SECRET = 'SENTINEL_CLIENT_SECRET_9f3a';
const PASSWORD = 'SENTINEL_PASSWORD_41bc';
const TOKEN = 'SENTINEL_TOKEN_77de';
const GROUP_A = 'a'.repeat(32);
const GROUP_B = 'b'.repeat(32);
const SINCE = new Date(Date.UTC(2026, 10, 20, 14, 5, 9));

const ENV_KEYS = [
  'SERVICENOW_INSTANCE_URL',
  'SERVICENOW_CLIENT_ID',
  'SERVICENOW_CLIENT_SECRET',
  'SERVICENOW_USERNAME',
  'SERVICENOW_PASSWORD',
] as const;

function setEnv(): void {
  process.env.SERVICENOW_INSTANCE_URL = `${INSTANCE}/`;
  process.env.SERVICENOW_CLIENT_ID = 'client-id-1';
  process.env.SERVICENOW_CLIENT_SECRET = SECRET;
  process.env.SERVICENOW_USERNAME = 'svc-user';
  process.env.SERVICENOW_PASSWORD = PASSWORD;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

function tokenResponse(token = TOKEN, expiresIn = 1800): Response {
  return jsonResponse(200, { access_token: token, expires_in: expiresIn });
}

function field(value: string, display = value) {
  return { value, display_value: display };
}

function row(n: number, overrides: Record<string, unknown> = {}) {
  return {
    sys_id: field(`id${n}`),
    number: field(`INC00${n}`),
    short_description: field('Cannot save timecard'),
    description: field('Long text'),
    state: field('6', 'Resolved'),
    priority: field('3', '3 - Moderate'),
    impact: field('2', '2 - Medium'),
    urgency: field('2', '2 - Medium'),
    category: field('software', 'Software'),
    subcategory: field('', ''),
    assignment_group: field(GROUP_A, 'MaxView Support'),
    opened_at: field('2026-11-01 10:00:00', '11/01/2026 04:00:00'),
    resolved_at: field('', ''),
    sys_updated_on: field('2026-11-02 11:30:00', '11/02/2026 05:30:00'),
    close_code: field('Solved', 'Solved'),
    close_notes: field('Fixed'),
    ...overrides,
  };
}

interface Call {
  url: string;
  init: RequestInit;
}

function makeDeps(responses: Response[]): { deps: ServiceNowClientDeps; calls: Call[]; sleeps: number[] } {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const queue = [...responses];
  const fetchImpl = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error('unexpected fetch call');
    return next;
  });
  const sleepImpl = jest.fn(async (ms: number) => {
    sleeps.push(ms);
  });
  return { deps: { fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl }, calls, sleeps };
}

const tableCalls = (calls: Call[]) => calls.filter((c) => c.url.includes('/api/now/'));
const tokenCalls = (calls: Call[]) => calls.filter((c) => c.url.includes('/oauth_token.do'));

describe('serviceNowClient', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    setEnv();
    resetServiceNowTokenCache();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    jest.restoreAllMocks();
  });

  it('requests a password-grant token and caches it', async () => {
    const { deps, calls } = makeDeps([
      tokenResponse(),
      jsonResponse(200, { result: [] }),
      jsonResponse(200, { result: [] }),
    ]);
    const args = { groupIds: [GROUP_A], since: SINCE };

    await listIncidentsUpdatedSince(args, deps);
    await listIncidentsUpdatedSince(args, deps);

    const tokens = tokenCalls(calls);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].url).toBe(`${INSTANCE}/oauth_token.do`);
    expect(tokens[0].init.method).toBe('POST');
    const form = new URLSearchParams(String(tokens[0].init.body));
    expect(form.get('grant_type')).toBe('password');
    expect(form.get('client_id')).toBe('client-id-1');
    expect(form.get('client_secret')).toBe(SECRET);
    expect(form.get('username')).toBe('svc-user');
    expect(form.get('password')).toBe(PASSWORD);
    expect(new Headers(tokens[0].init.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(tableCalls(calls)).toHaveLength(2);
    expect(new Headers(tableCalls(calls)[1].init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('refreshes an expired cached token', async () => {
    let now = 1_000_000;
    const { deps, calls } = makeDeps([
      tokenResponse('first', 120),
      jsonResponse(200, { result: [] }),
      jsonResponse(200, { result: [] }),
      tokenResponse('second', 120),
      jsonResponse(200, { result: [] }),
    ]);
    const timed = { ...deps, nowImpl: () => now };
    const args = { groupIds: [GROUP_A], since: SINCE };

    await listIncidentsUpdatedSince(args, timed);
    now += 59_000;
    await listIncidentsUpdatedSince(args, timed);
    expect(tokenCalls(calls)).toHaveLength(1);

    now += 2_000;
    await listIncidentsUpdatedSince(args, timed);
    expect(tokenCalls(calls)).toHaveLength(2);
    expect(new Headers(tableCalls(calls)[2].init.headers).get('authorization')).toBe('Bearer second');
  });

  it('builds the delta query from group sys_ids and watermark with the field allowlist', async () => {
    const { deps, calls } = makeDeps([tokenResponse(), jsonResponse(200, { result: [row(1)] })]);

    const rows = await listIncidentsUpdatedSince(
      { groupIds: [GROUP_A, GROUP_B], since: SINCE, offset: 200, limit: 50 },
      deps,
    );

    const call = tableCalls(calls)[0];
    expect(call.init.method).toBe('GET');
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe(`${INSTANCE}/api/now/table/incident`);
    const params = url.searchParams;
    expect(params.get('sysparm_query')).toBe(
      `assignment_groupIN${GROUP_A},${GROUP_B}^sys_updated_on>=2026-11-20 14:05:09^ORDERBYsys_updated_on`,
    );
    expect(params.get('sysparm_fields')).toBe(
      'sys_id,number,short_description,description,state,priority,impact,urgency,category,subcategory,' +
        'assignment_group,opened_at,resolved_at,sys_updated_on,close_code,close_notes',
    );
    expect(params.get('sysparm_display_value')).toBe('all');
    expect(params.get('sysparm_exclude_reference_link')).toBe('true');
    expect(params.get('sysparm_no_count')).toBe('true');
    expect(params.get('sysparm_limit')).toBe('50');
    expect(params.get('sysparm_offset')).toBe('200');
    for (const banned of ['caller_id', 'opened_by', 'assigned_to', 'u_']) {
      expect(params.get('sysparm_fields')).not.toContain(banned);
    }

    expect(rows).toEqual([
      {
        sysId: 'id1',
        number: 'INC001',
        shortDescription: 'Cannot save timecard',
        description: 'Long text',
        state: 'Resolved',
        priority: '3 - Moderate',
        impact: '2 - Medium',
        urgency: '2 - Medium',
        category: 'Software',
        subcategory: '',
        assignmentGroupSysId: GROUP_A,
        assignmentGroupName: 'MaxView Support',
        openedAt: '2026-11-01 10:00:00',
        resolvedAt: null,
        sysUpdatedOn: '2026-11-02 11:30:00',
        closeCode: 'Solved',
        closeNotes: 'Fixed',
      },
    ]);
  });

  it('defaults to limit 100 and offset 0', async () => {
    const { deps, calls } = makeDeps([tokenResponse(), jsonResponse(200, { result: [] })]);
    await listIncidentsUpdatedSince({ groupIds: [GROUP_A], since: SINCE }, deps);
    const params = new URL(tableCalls(calls)[0].url).searchParams;
    expect(params.get('sysparm_limit')).toBe('100');
    expect(params.get('sysparm_offset')).toBe('0');
  });

  it('rejects empty or malformed group ids before any request', async () => {
    const { deps, calls } = makeDeps([]);
    await expect(listIncidentsUpdatedSince({ groupIds: [], since: SINCE }, deps)).rejects.toThrow(
      /assignment group/i,
    );
    await expect(
      listIncidentsUpdatedSince({ groupIds: ['abc^ORactive=true'], since: SINCE }, deps),
    ).rejects.toThrow(/assignment group/i);
    expect(calls).toHaveLength(0);
  });

  it('pages until a short page', async () => {
    const { deps, calls } = makeDeps([
      tokenResponse(),
      jsonResponse(200, { result: [row(1), row(2)] }),
      jsonResponse(200, { result: [row(3), row(4)] }),
      jsonResponse(200, { result: [row(5)] }),
    ]);

    const pages: string[][] = [];
    for await (const page of listAllIncidentsUpdatedSince({ groupIds: [GROUP_A], since: SINCE, limit: 2 }, deps)) {
      pages.push(page.map((r) => r.sysId));
    }

    expect(pages).toEqual([['id1', 'id2'], ['id3', 'id4'], ['id5']]);
    const offsets = tableCalls(calls).map((c) => new URL(c.url).searchParams.get('sysparm_offset'));
    expect(offsets).toEqual(['0', '2', '4']);
  });

  it('stops at the page cap', async () => {
    const full = () => jsonResponse(200, { result: [row(1)] });
    const { deps, calls } = makeDeps([tokenResponse(), ...Array.from({ length: 60 }, full)]);

    let pageCount = 0;
    for await (const page of listAllIncidentsUpdatedSince({ groupIds: [GROUP_A], since: SINCE, limit: 1 }, deps)) {
      pageCount += page.length > 0 ? 1 : 0;
    }

    expect(pageCount).toBe(50);
    expect(tableCalls(calls)).toHaveLength(50);
  });

  it('refreshes the token once on 401', async () => {
    const { deps, calls } = makeDeps([
      tokenResponse('old-token'),
      jsonResponse(401, { error: { message: 'User Not Authenticated' } }),
      tokenResponse('new-token'),
      jsonResponse(200, { result: [row(1)] }),
    ]);

    const rows = await listIncidentsUpdatedSince({ groupIds: [GROUP_A], since: SINCE }, deps);

    expect(rows).toHaveLength(1);
    expect(tokenCalls(calls)).toHaveLength(2);
    expect(new Headers(tableCalls(calls)[1].init.headers).get('authorization')).toBe('Bearer new-token');
  });

  it('fails when the retried request is also 401', async () => {
    const { deps, calls } = makeDeps([
      tokenResponse('t1'),
      jsonResponse(401, { error: { message: 'User Not Authenticated' } }),
      tokenResponse('t2'),
      jsonResponse(401, { error: { message: 'User Not Authenticated' } }),
    ]);

    const error = await listIncidentsUpdatedSince({ groupIds: [GROUP_A], since: SINCE }, deps).catch((e) => e);

    expect(error).toBeInstanceOf(ServiceNowRequestError);
    expect(error.status).toBe(401);
    expect(error.message).toBe('ServiceNow request failed (HTTP 401): User Not Authenticated');
    expect(tableCalls(calls)).toHaveLength(2);
    expect(tokenCalls(calls)).toHaveLength(2);
  });

  it('honours Retry-After on 429 and then succeeds', async () => {
    const { deps, calls, sleeps } = makeDeps([
      tokenResponse(),
      jsonResponse(429, { error: { message: 'Rate limited' } }, { 'retry-after': '7' }),
      jsonResponse(200, { result: [row(1)] }),
    ]);

    const rows = await listIncidentsUpdatedSince({ groupIds: [GROUP_A], since: SINCE }, deps);

    expect(rows).toHaveLength(1);
    expect(sleeps).toEqual([7000]);
    expect(tableCalls(calls)).toHaveLength(2);
  });

  it('gives up after 3 tries on 429 and caps the wait at 60 seconds', async () => {
    const limited = () => jsonResponse(429, { error: { message: 'Rate limited' } }, { 'retry-after': '500' });
    const { deps, calls, sleeps } = makeDeps([tokenResponse(), limited(), limited(), limited(), limited()]);

    const error = await listIncidentsUpdatedSince({ groupIds: [GROUP_A], since: SINCE }, deps).catch((e) => e);

    expect(error).toBeInstanceOf(ServiceNowRequestError);
    expect(error.status).toBe(429);
    expect(tableCalls(calls)).toHaveLength(3);
    expect(sleeps).toEqual([60_000, 60_000]);
  });

  it('never sends a method other than GET to /api/now', async () => {
    const { deps, calls } = makeDeps([
      tokenResponse(),
      jsonResponse(401, {}),
      tokenResponse(),
      jsonResponse(429, {}, { 'retry-after': '1' }),
      jsonResponse(200, { result: [row(1)] }),
    ]);

    await listIncidentsUpdatedSince({ groupIds: [GROUP_A], since: SINCE }, deps);

    expect(tableCalls(calls).length).toBeGreaterThan(0);
    for (const call of tableCalls(calls)) expect(call.init.method).toBe('GET');
    for (const call of calls.filter((c) => c.init.method !== 'GET')) {
      expect(call.url).toBe(`${INSTANCE}/oauth_token.do`);
      expect(call.init.method).toBe('POST');
    }
  });

  it('secrets never appear in thrown messages or console output', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation(() => undefined),
    );
    const failures: unknown[] = [];
    const attempt = async (responses: Array<Response | Error>) => {
      resetServiceNowTokenCache();
      const queue = [...responses];
      const deps: ServiceNowClientDeps = {
        fetchImpl: (async () => {
          const next = queue.shift();
          if (next instanceof Error) throw next;
          return next as Response;
        }) as unknown as typeof fetch,
        sleepImpl: async () => undefined,
      };
      try {
        await listIncidentsUpdatedSince({ groupIds: [GROUP_A], since: SINCE }, deps);
      } catch (error) {
        failures.push(error);
      }
    };

    await attempt([tokenResponse(), jsonResponse(500, { error: { message: 'Server exploded' } })]);
    await attempt([jsonResponse(401, { error: 'invalid_grant', error_description: `bad ${PASSWORD}` })]);
    await attempt([new Error(`connect failed ${INSTANCE}/oauth_token.do?client_secret=${SECRET}&password=${PASSWORD}`)]);
    await attempt([tokenResponse(), new Error(`socket hang up Bearer ${TOKEN}`)]);

    expect(failures).toHaveLength(4);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(ServiceNowRequestError);
      const text = `${(failure as Error).message}\n${(failure as Error).stack}\n${JSON.stringify(failure)}`;
      for (const sentinel of [SECRET, PASSWORD, TOKEN, 'sysparm_query', 'client_secret']) {
        expect(text).not.toContain(sentinel);
      }
    }
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toMatch(/SENTINEL|sysparm_query|client_secret/);
    }
  });

  describe('isServiceNowConfigured', () => {
    it('is true when every setting is present', () => {
      expect(isServiceNowConfigured()).toBe(true);
    });

    it('is false when any setting is missing', () => {
      for (const key of ENV_KEYS) {
        const saved = process.env[key];
        delete process.env[key];
        expect(isServiceNowConfigured()).toBe(false);
        process.env[key] = saved;
      }
      process.env.SERVICENOW_CLIENT_ID = '   ';
      expect(isServiceNowConfigured()).toBe(false);
    });

    it('reads the environment at call time', async () => {
      delete process.env.SERVICENOW_PASSWORD;
      const { deps, calls } = makeDeps([]);
      await expect(listIncidentsUpdatedSince({ groupIds: [GROUP_A], since: SINCE }, deps)).rejects.toThrow(
        /SERVICENOW_PASSWORD/,
      );
      expect(calls).toHaveLength(0);
    });
  });
});
