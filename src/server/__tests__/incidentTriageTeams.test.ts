/**
 * The Teams card carries AI fields and links only, posts once per verdict and severity, and a
 * failed post is recorded for the sweep to retry. The store is mocked; fetch is injected.
 */
import type {
  IncidentTriageAnalysis,
  IncidentTriageIncident,
  IncidentTriageResult,
} from '../../shared/types/incidentTriage';

const mockGetAnalysisForPost = jest.fn();
const mockGetTeamsWebhook = jest.fn();
const mockGetLastPostedAnalysis = jest.fn();
const mockMarkTeamsPosted = jest.fn();
const mockMarkTeamsFailed = jest.fn();
const mockMarkTeamsSkipped = jest.fn();
const mockListFailedTeamsPosts = jest.fn();

jest.mock('../services/incidentTriageStore', () => ({
  MAX_TEAMS_ATTEMPTS: 3,
  getAnalysisForPost: (...args: unknown[]) => mockGetAnalysisForPost(...args),
  getTeamsWebhook: (...args: unknown[]) => mockGetTeamsWebhook(...args),
  getLastPostedAnalysis: (...args: unknown[]) => mockGetLastPostedAnalysis(...args),
  markTeamsPosted: (...args: unknown[]) => mockMarkTeamsPosted(...args),
  markTeamsFailed: (...args: unknown[]) => mockMarkTeamsFailed(...args),
  markTeamsSkipped: (...args: unknown[]) => mockMarkTeamsSkipped(...args),
  listFailedTeamsPosts: (...args: unknown[]) => mockListFailedTeamsPosts(...args),
}));

import { encryptWebhookUrl } from '../services/incidentTriageWebhookCrypto';
import {
  buildIncidentTriageCard,
  postIncidentTriageCard,
  resolveApexBaseUrl,
  retryFailedIncidentTriagePosts,
  sendIncidentTriageTestCard,
} from '../services/incidentTriageTeams';

const PROJECT = 'Apex';
const RUN_ID = '11111111-2222-4333-8444-555555555555';
const INCIDENT_ID = '3f2c1e1a-4b5d-4c6e-8f70-1a2b3c4d5e6f';
const SYS_ID = 'b'.repeat(32);
const WEBHOOK_URL = 'https://prod-12.westus.logic.azure.com/workflows/abc123/triggers/manual/paths/invoke?sig=topsecret9';
const APEX_BASE = 'https://apex.example.test';
const APEX_LINK = `${APEX_BASE}/incident-triage?project=${PROJECT}&incident=${INCIDENT_ID}`;
const SERVICE_NOW_URL = `https://example.service-now.com/nav_to.do?uri=incident.do?sys_id=${SYS_ID}`;
const INCIDENT_TEXT = {
  shortDescription: 'Zebra timecard page throws on save',
  description: 'Quokka users see an error when the shift is missing.',
  closeNotes: 'Walrus template fixed by support.',
};

function result(overrides: Partial<IncidentTriageResult> = {}): IncidentTriageResult {
  return {
    summary: 'Long internal summary that must not be on the card.',
    teamsSummary: 'Timecard save fails when the shift is missing.',
    verdict: 'config',
    area: 'Timecard',
    severity: 'medium',
    confidence: 'high',
    verification: { codeEvidence: ['TimecardService.Save'], telemetryEvidence: ['3 exceptions'] },
    nextAction: 'Fix the shift template.',
    ...overrides,
  };
}

function incident(overrides: Partial<IncidentTriageIncident> = {}): IncidentTriageIncident {
  return {
    id: INCIDENT_ID,
    project: PROJECT,
    sysId: SYS_ID,
    number: 'INC0012345',
    ...INCIDENT_TEXT,
    state: 'In Progress',
    priority: '2 - High',
    impact: '2 - Medium',
    urgency: '2 - Medium',
    category: 'Software',
    subcategory: 'Timecard',
    assignmentGroupName: 'MaxView Support',
    openedAt: '2026-11-19T10:00:00.000Z',
    resolvedAt: null,
    sysUpdatedOn: '2026-11-20T11:30:00.000Z',
    closeCode: null,
    serviceNowUrl: SERVICE_NOW_URL,
    latestAnalysis: null,
    ...overrides,
  };
}

type CompletedAnalysis = IncidentTriageAnalysis & { result: IncidentTriageResult };

function analysis(
  overrides: Partial<Omit<IncidentTriageAnalysis, 'result'>> & { result?: IncidentTriageResult } = {},
): CompletedAnalysis {
  const analysisResult = overrides.result ?? result();
  return {
    runId: RUN_ID,
    status: 'completed',
    requestedBy: null,
    model: 'm',
    verdict: analysisResult.verdict,
    area: analysisResult.area,
    severity: analysisResult.severity,
    result: analysisResult,
    failureDetail: null,
    teamsStatus: 'pending',
    requestedAt: '2026-11-20T11:31:00.000Z',
    completedAt: '2026-11-20T11:40:00.000Z',
    ...overrides,
  };
}

function target(overrides: { analysis?: IncidentTriageAnalysis; teamsAttempts?: number } = {}) {  return {
    project: PROJECT,
    incident: incident(),
    analysis: overrides.analysis ?? analysis(),
    teamsAttempts: overrides.teamsAttempts ?? 0,
  };
}

function cardOf(payload: ReturnType<typeof buildIncidentTriageCard>) {
  return payload.attachments[0].content;
}

function okResponse(status = 202): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
}

let previousSecret: string | undefined;
let previousRedirect: string | undefined;

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  previousSecret = process.env.SESSION_SECRET;
  previousRedirect = process.env.AZURE_REDIRECT_URL;
  process.env.SESSION_SECRET = 'unit-test-session-secret';
  process.env.AZURE_REDIRECT_URL = `${APEX_BASE}/auth/callback`;
  mockGetAnalysisForPost.mockResolvedValue(target());
  mockGetTeamsWebhook.mockResolvedValue(encryptWebhookUrl(PROJECT, WEBHOOK_URL));
  mockGetLastPostedAnalysis.mockResolvedValue(null);
  mockMarkTeamsPosted.mockResolvedValue(undefined);
  mockMarkTeamsFailed.mockResolvedValue(undefined);
  mockMarkTeamsSkipped.mockResolvedValue(undefined);
  mockListFailedTeamsPosts.mockResolvedValue([]);
});

afterEach(() => {
  jest.restoreAllMocks();
  if (previousSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSecret;
  if (previousRedirect === undefined) delete process.env.AZURE_REDIRECT_URL;
  else process.env.AZURE_REDIRECT_URL = previousRedirect;
});

describe('buildIncidentTriageCard', () => {
  it('card has the number, AI summary, verdict, area, severity and both links', () => {
    const payload = buildIncidentTriageCard({
      incident: incident(),
      analysis: analysis(),
      apexBaseUrl: APEX_BASE,
      serviceNowUrl: SERVICE_NOW_URL,
    });

    expect(payload.type).toBe('message');
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    const card = cardOf(payload);
    expect(card).toMatchObject({ type: 'AdaptiveCard', version: '1.4' });
    const text = JSON.stringify(card.body);
    expect(text).toContain('INC0012345');
    expect(text).toContain('Timecard save fails when the shift is missing.');
    const facts = (card.body.find((block) => block.type === 'FactSet') as { facts: Array<{ title: string; value: string }> })
      .facts;
    expect(facts).toEqual([
      { title: 'Verdict', value: 'Config' },
      { title: 'Area', value: 'Timecard' },
      { title: 'Severity', value: 'Medium' },
      { title: 'Confidence', value: 'High' },
    ]);
    expect(card.actions).toEqual([
      { type: 'Action.OpenUrl', title: 'Open in ServiceNow', url: SERVICE_NOW_URL },
      { type: 'Action.OpenUrl', title: 'Open in Apex', url: APEX_LINK },
    ]);
  });

  it('the Open in Apex link carries the encoded project and the incident id', () => {
    const payload = buildIncidentTriageCard({
      incident: incident({ project: 'Max View/Ops' }),
      analysis: analysis(),
      apexBaseUrl: APEX_BASE,
      serviceNowUrl: null,
    });

    const [action] = cardOf(payload).actions;
    const url = new URL(action.url);
    expect(url.pathname).toBe('/incident-triage');
    expect(url.searchParams.get('project')).toBe('Max View/Ops');
    expect(url.searchParams.get('incident')).toBe(INCIDENT_ID);
    expect(action.url).toContain('project=Max%20View%2FOps');
  });

  it('card text from AI contains no link markup', () => {
    const payload = buildIncidentTriageCard({
      incident: incident(),
      analysis: analysis({
        result: result({
          verdict: 'bug',
          teamsSummary: 'Sign in again at [Apex](https://evil.example/login) or https://evil.example/x.',
          area: '[Timecard](http://evil.example)',
          suggestedFix: 'Read (https://evil.example/fix) then [patch](http://evil.example/p).',
        }),
      }),
      apexBaseUrl: APEX_BASE,
      serviceNowUrl: SERVICE_NOW_URL,
    });

    const json = JSON.stringify(cardOf(payload).body);
    expect(json).not.toContain('evil.example');
    expect(json).not.toMatch(/(?<!\\\\)\]\(/);
    expect(json).toContain('Sign in again at Apex or [link].');
  });

  it('card never contains incident text', () => {
    const payload = buildIncidentTriageCard({
      incident: incident(),
      analysis: analysis(),
      apexBaseUrl: APEX_BASE,
      serviceNowUrl: SERVICE_NOW_URL,
    });

    const json = JSON.stringify(payload);
    expect(json).not.toContain(INCIDENT_TEXT.shortDescription);
    expect(json).not.toContain(INCIDENT_TEXT.description);
    expect(json).not.toContain(INCIDENT_TEXT.closeNotes);
    expect(json).not.toContain('Zebra');
    expect(json).not.toContain('Quokka');
    expect(json).not.toContain('Walrus');
    expect(json).not.toContain('Long internal summary');
  });

  it('synthetic email and phone numbers in teamsSummary are masked', () => {
    const payload = buildIncidentTriageCard({
      incident: incident(),
      analysis: analysis({
        result: result({ teamsSummary: 'Ask jane.doe@example.com or call 555-123-4567 about worker 12345678.' }),
      }),
      apexBaseUrl: APEX_BASE,
      serviceNowUrl: SERVICE_NOW_URL,
    });

    const json = JSON.stringify(payload);
    expect(json).toContain('Ask [email] or call [phone] about worker [id].');
    expect(json).not.toContain('jane.doe@example.com');
    expect(json).not.toContain('555-123-4567');
    expect(json).not.toContain('12345678');
  });

  it('suggested fix only for bug', () => {
    const bug = buildIncidentTriageCard({
      incident: incident(),
      analysis: analysis({ result: result({ verdict: 'bug', suggestedFix: `Guard the null shift. ${'x'.repeat(600)}` }) }),
      apexBaseUrl: APEX_BASE,
      serviceNowUrl: SERVICE_NOW_URL,
    });
    const notBug = buildIncidentTriageCard({
      incident: incident(),
      analysis: analysis({ result: result({ verdict: 'config', suggestedFix: 'Guard the null shift.' }) }),
      apexBaseUrl: APEX_BASE,
      serviceNowUrl: SERVICE_NOW_URL,
    });

    const bugText = JSON.stringify(cardOf(bug).body);
    expect(bugText).toContain('Suggested fix');
    expect(bugText).toContain('Guard the null shift.');
    const fix = cardOf(bug).body.find((block) => block.type === 'TextBlock' && block.text.startsWith('Guard'));
    expect((fix as { text: string }).text.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(cardOf(notBug).body)).not.toContain('Suggested fix');
    expect(JSON.stringify(cardOf(notBug).body)).not.toContain('Guard the null shift.');
  });

  it('payload stays under 28 KB', () => {
    const huge = 'word '.repeat(40_000);
    const payload = buildIncidentTriageCard({
      incident: incident({ number: `INC${'9'.repeat(5000)}` }),
      analysis: analysis({
        result: result({ verdict: 'bug', teamsSummary: huge, area: huge, suggestedFix: huge }),
      }),
      apexBaseUrl: APEX_BASE,
      serviceNowUrl: SERVICE_NOW_URL,
    });

    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThan(28 * 1024);
  });

  it('omits the ServiceNow link when the instance URL is not configured', () => {
    const payload = buildIncidentTriageCard({
      incident: incident(),
      analysis: analysis(),
      apexBaseUrl: APEX_BASE,
      serviceNowUrl: null,
    });

    expect(cardOf(payload).actions.map((action) => action.title)).toEqual(['Open in Apex']);
  });
});

describe('resolveApexBaseUrl', () => {
  it('derives the base from the auth redirect URL, then falls back to the dev app', () => {
    process.env.AZURE_REDIRECT_URL = 'https://apex.example.test/auth/callback';
    expect(resolveApexBaseUrl()).toBe('https://apex.example.test');

    delete process.env.AZURE_REDIRECT_URL;
    expect(resolveApexBaseUrl()).toBe('https://app-scrum-dev.azurewebsites.net');
  });
});

describe('postIncidentTriageCard', () => {
  it('posts the card to the decrypted webhook and records posted', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse(202));

    await expect(postIncidentTriageCard(RUN_ID, { fetchImpl })).resolves.toBe('posted');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(WEBHOOK_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(init.signal).toBeDefined();
    const body = JSON.parse(init.body);
    expect(body.type).toBe('message');
    expect(JSON.stringify(body)).toContain('INC0012345');
    expect(JSON.stringify(body)).toContain(APEX_LINK);
    expect(mockMarkTeamsPosted).toHaveBeenCalledWith(RUN_ID);
    expect(mockMarkTeamsFailed).not.toHaveBeenCalled();
    expect(mockGetTeamsWebhook).toHaveBeenCalledWith(PROJECT);
  });

  it('same verdict and severity as the last posted analysis means skipped, no POST', async () => {
    mockGetLastPostedAnalysis.mockResolvedValue({ verdict: 'config', severity: 'medium' });
    const fetchImpl = jest.fn();

    await expect(postIncidentTriageCard(RUN_ID, { fetchImpl })).resolves.toBe('skipped');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockMarkTeamsSkipped).toHaveBeenCalledWith(RUN_ID);
    expect(mockMarkTeamsPosted).not.toHaveBeenCalled();
    expect(mockGetLastPostedAnalysis).toHaveBeenCalledWith(INCIDENT_ID, RUN_ID);
  });

  it.each([
    ['verdict', { verdict: 'bug', severity: 'medium' }],
    ['severity', { verdict: 'config', severity: 'high' }],
  ])('posts again when the %s changed', async (_label, last) => {
    mockGetLastPostedAnalysis.mockResolvedValue(last);
    const fetchImpl = jest.fn().mockResolvedValue(okResponse(200));

    await expect(postIncidentTriageCard(RUN_ID, { fetchImpl })).resolves.toBe('posted');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('non-2xx records failed and increments attempts; the URL is never in console output', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => `error for ${WEBHOOK_URL}`,
      json: async () => ({ message: `error for ${WEBHOOK_URL}` }),
    });

    await expect(postIncidentTriageCard(RUN_ID, { fetchImpl })).resolves.toBe('failed');

    expect(mockMarkTeamsFailed).toHaveBeenCalledWith(RUN_ID);
    expect(mockMarkTeamsPosted).not.toHaveBeenCalled();
    const logged = JSON.stringify([
      ...(console.log as jest.Mock).mock.calls,
      ...(console.warn as jest.Mock).mock.calls,
      ...(console.error as jest.Mock).mock.calls,
    ]);
    expect(logged).toContain('500');
    expect(logged).not.toContain(WEBHOOK_URL);
    expect(logged).not.toContain('topsecret9');
    expect(logged).not.toContain('logic.azure.com');
    expect(logged).not.toContain('error for');
  });

  it('refuses to follow redirects, and a 3xx counts as failed', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse(302));

    await expect(postIncidentTriageCard(RUN_ID, { fetchImpl })).resolves.toBe('failed');

    expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
    expect(mockMarkTeamsFailed).toHaveBeenCalledWith(RUN_ID);
    expect(mockMarkTeamsPosted).not.toHaveBeenCalled();
  });

  it('a throw records failed and never logs the URL carried in the error', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error(`getaddrinfo failed for ${WEBHOOK_URL}`));

    await expect(postIncidentTriageCard(RUN_ID, { fetchImpl })).resolves.toBe('failed');

    expect(mockMarkTeamsFailed).toHaveBeenCalledWith(RUN_ID);
    const logged = JSON.stringify([
      ...(console.warn as jest.Mock).mock.calls,
      ...(console.error as jest.Mock).mock.calls,
    ]);
    expect(logged).not.toContain('topsecret9');
    expect(logged).not.toContain('getaddrinfo');
  });

  it('a stored webhook that cannot be decrypted records failed without a POST', async () => {
    mockGetTeamsWebhook.mockResolvedValue({ iv: 'x' });
    const fetchImpl = jest.fn();

    await expect(postIncidentTriageCard(RUN_ID, { fetchImpl })).resolves.toBe('failed');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockMarkTeamsFailed).toHaveBeenCalledWith(RUN_ID);
  });

  it('no webhook means skipped', async () => {
    mockGetTeamsWebhook.mockResolvedValue(null);
    const fetchImpl = jest.fn();

    await expect(postIncidentTriageCard(RUN_ID, { fetchImpl })).resolves.toBe('skipped');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockMarkTeamsSkipped).toHaveBeenCalledWith(RUN_ID);
  });

  it.each([
    ['an unknown run', null],
    ['a run that is not completed', target({ analysis: { ...analysis({ status: 'running' }), result: null } })],
    ['a row already posted', target({ analysis: analysis({ teamsStatus: 'posted' }) })],
    ['a row already skipped', target({ analysis: analysis({ teamsStatus: 'skipped' }) })],
    ['a failed row out of attempts', target({ analysis: analysis({ teamsStatus: 'failed' }), teamsAttempts: 3 })],
  ])('does nothing for %s', async (_label, row) => {
    mockGetAnalysisForPost.mockResolvedValue(row);
    const fetchImpl = jest.fn();

    await expect(postIncidentTriageCard(RUN_ID, { fetchImpl })).resolves.toBeNull();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockMarkTeamsPosted).not.toHaveBeenCalled();
    expect(mockMarkTeamsFailed).not.toHaveBeenCalled();
    expect(mockMarkTeamsSkipped).not.toHaveBeenCalled();
  });

  it('posts a failed row that still has attempts left', async () => {
    mockGetAnalysisForPost.mockResolvedValue(
      target({ analysis: analysis({ teamsStatus: 'failed' }), teamsAttempts: 2 }),
    );
    const fetchImpl = jest.fn().mockResolvedValue(okResponse(200));

    await expect(postIncidentTriageCard(RUN_ID, { fetchImpl })).resolves.toBe('posted');
  });
});

describe('retryFailedIncidentTriagePosts', () => {
  it('retry only picks failed rows with fewer than 3 attempts', async () => {
    mockListFailedTeamsPosts.mockResolvedValue(['run-a', 'run-b']);
    const fetchImpl = jest.fn().mockResolvedValue(okResponse(200));

    await retryFailedIncidentTriagePosts(5, [PROJECT], { fetchImpl });

    expect(mockListFailedTeamsPosts).toHaveBeenCalledWith(5, [PROJECT]);
    expect(mockGetAnalysisForPost.mock.calls.map(([runId]) => runId)).toEqual(['run-a', 'run-b']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps going when one retry throws', async () => {
    mockListFailedTeamsPosts.mockResolvedValue(['run-a', 'run-b']);
    mockGetAnalysisForPost.mockRejectedValueOnce(new Error('database down'));
    const fetchImpl = jest.fn().mockResolvedValue(okResponse(200));

    await expect(retryFailedIncidentTriagePosts(5, [PROJECT], { fetchImpl })).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('sendIncidentTriageTestCard', () => {
  it('sends a sample card without incident data and reports the status', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse(202));

    await expect(sendIncidentTriageTestCard(PROJECT, { fetchImpl })).resolves.toEqual({ ok: true, status: 202 });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(WEBHOOK_URL);
    expect(init.redirect).toBe('error');
    const body = JSON.parse(init.body);
    expect(body.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(JSON.stringify(body)).toContain('test');
    expect(JSON.stringify(body)).toContain(`${APEX_BASE}/incident-triage`);
    expect(mockGetAnalysisForPost).not.toHaveBeenCalled();
    expect(mockMarkTeamsPosted).not.toHaveBeenCalled();
  });

  it('reports a non-2xx status', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse(500));

    await expect(sendIncidentTriageTestCard(PROJECT, { fetchImpl })).resolves.toEqual({ ok: false, status: 500 });
  });

  it('reports a network error without a status and never logs the URL', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error(`failed ${WEBHOOK_URL}`));

    await expect(sendIncidentTriageTestCard(PROJECT, { fetchImpl })).resolves.toEqual({ ok: false, status: null });

    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('topsecret9');
    expect(JSON.stringify((console.warn as jest.Mock).mock.calls)).not.toContain('topsecret9');
  });

  it('reports no status when no webhook is stored', async () => {
    mockGetTeamsWebhook.mockResolvedValue(null);
    const fetchImpl = jest.fn();

    await expect(sendIncidentTriageTestCard(PROJECT, { fetchImpl })).resolves.toEqual({ ok: false, status: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
