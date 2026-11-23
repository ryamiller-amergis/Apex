import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { IncidentTriagePage } from '../IncidentTriagePage';
import { useFeatureFlag } from '../../hooks/useFeatureFlags';
import { INCIDENT_TRIAGE_FLAG } from '../../../shared/types/featureFlags';
import { INCIDENT_TRIAGE_PERMISSIONS } from '../../../shared/types/incidentTriage';
import type {
  IncidentTriageAnalysis,
  IncidentTriageDetailResponse,
  IncidentTriageIncident,
  IncidentTriageListResponse,
  IncidentTriageResult,
  IncidentTriageSettings,
} from '../../../shared/types/incidentTriage';

jest.mock('../../hooks/useFeatureFlags', () => ({ useFeatureFlag: jest.fn() }));

const flag = useFeatureFlag as jest.Mock;

const SYS_ID_A = 'a'.repeat(32);
const SYS_ID_B = 'b'.repeat(32);

function incident(overrides: Partial<IncidentTriageIncident> = {}): IncidentTriageIncident {
  return {
    id: 'inc-1',
    project: 'MaxView',
    sysId: 'sys-1',
    number: 'INC0012345',
    shortDescription: 'Timecard page fails to load',
    description: 'User [redacted] cannot open the timecard page.',
    closeNotes: null,
    state: 'In Progress',
    priority: '2 - High',
    impact: null,
    urgency: null,
    category: null,
    subcategory: null,
    assignmentGroupName: 'MaxView Support',
    openedAt: '2026-11-18T14:30:00.000Z',
    resolvedAt: null,
    sysUpdatedOn: null,
    closeCode: null,
    serviceNowUrl: 'https://example.service-now.com/incident.do?sys_id=sys-1',
    latestAnalysis: null,
    ...overrides,
  };
}

const analyzedIncident = incident({
  id: 'inc-2',
  number: 'INC0012346',
  state: 'Resolved',
  shortDescription: 'Invoice export shows wrong totals',
  serviceNowUrl: 'https://example.service-now.com/incident.do?sys_id=sys-2',
  latestAnalysis: {
    runId: 'run-1',
    status: 'completed',
    requestedBy: null,
    model: 'composer-2.5',
    verdict: 'bug',
    area: 'Invoicing',
    severity: 'high',
    result: null,
    failureDetail: null,
    teamsStatus: 'posted',
    requestedAt: '2026-11-19T10:00:00.000Z',
    completedAt: '2026-11-19T10:05:00.000Z',
  },
});

const settings: IncidentTriageSettings = {
  project: 'MaxView',
  enabled: true,
  assignmentGroupIds: [SYS_ID_A],
  backfillDays: 14,
  watermark: null,
  lastSweepAt: null,
  lastSweepError: null,
  teamsWebhookMasked: 'prod-12.westus.logic.azure.com…',
};

interface FetchResponse {
  status: number;
  body: unknown;
}

interface FetchState {
  list: IncidentTriageListResponse;
  sweepResult: { fetched: number; upserted: number; newAnalyses: number };
  details?: Record<string, IncidentTriageDetailResponse>;
  analyze?: FetchResponse;
  testPost?: FetchResponse;
}

function webhookMask(url: string | null | undefined, current: string | null): string | null {
  if (url === undefined) return current;
  return url === null ? null : `${new URL(url).host}…`;
}

function installFetch(state: FetchState) {
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const respond = (body: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });

    if (url.pathname === '/api/incident-triage/incidents' && method === 'GET') {
      return respond(state.list);
    }
    const detail = /^\/api\/incident-triage\/incidents\/([^/]+)$/.exec(url.pathname);
    if (detail && method === 'GET') {
      const found = state.list.incidents.find((row) => row.id === detail[1]);
      const body: IncidentTriageDetailResponse = state.details?.[detail[1]]
        ?? { incident: found ?? incident(), analyses: [] };
      return respond(body);
    }
    const analyze = /^\/api\/incident-triage\/incidents\/([^/]+)\/analyze$/.exec(url.pathname);
    if (analyze && method === 'POST') {
      return respond(state.analyze?.body ?? { runId: 'run-new' }, state.analyze?.status ?? 200);
    }
    if (url.pathname === '/api/incident-triage/settings/test-post' && method === 'POST') {
      return respond(state.testPost?.body ?? { ok: true }, state.testPost?.status ?? 200);
    }
    if (url.pathname === '/api/incident-triage/sweep' && method === 'POST') {
      return respond(state.sweepResult);
    }
    if (url.pathname === '/api/incident-triage/settings' && method === 'GET') {
      return respond(settings);
    }
    if (url.pathname === '/api/incident-triage/settings' && method === 'PUT') {
      const { teamsWebhookUrl, ...rest } = JSON.parse(String(init?.body)) as {
        teamsWebhookUrl?: string | null;
      };
      return respond({
        ...settings,
        ...rest,
        teamsWebhookMasked: webhookMask(teamsWebhookUrl, settings.teamsWebhookMasked),
      });
    }
    return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function callsTo(fetchMock: jest.Mock, pathname: string, method: string) {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const url = new URL(String(input), 'http://localhost');
    return url.pathname === pathname && ((init as RequestInit | undefined)?.method ?? 'GET') === method;
  });
}

const ADMIN_PERMISSIONS = new Set<string>(Object.values(INCIDENT_TRIAGE_PERMISSIONS));
const MEMBER_PERMISSIONS = new Set<string>([INCIDENT_TRIAGE_PERMISSIONS.view]);

function renderPage(permissions: Set<string> = ADMIN_PERMISSIONS, search = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(
    <MemoryRouter initialEntries={[`/incident-triage${search}`]}>
      <QueryClientProvider client={client}>
        <IncidentTriagePage
          project="MaxView"
          can={(key) => permissions.has(key)}
          isSuperAdmin={false}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { client, ...rendered };
}

const bugResult: IncidentTriageResult = {
  summary: 'Invoice totals are summed before currency conversion.',
  teamsSummary: 'Totals wrong.',
  verdict: 'bug',
  area: 'Invoicing',
  severity: 'high',
  confidence: 'medium',
  verification: {
    codeEvidence: ['InvoiceExport sums Amount before conversion <b>raw</b>'],
    telemetryEvidence: ['12 exceptions in the last 24 hours'],
  },
  suggestedFix: 'Convert each line to the invoice currency before summing.',
  nextAction: 'Assign to the Invoicing team.',
};

function analysis(overrides: Partial<IncidentTriageAnalysis> = {}): IncidentTriageAnalysis {
  return {
    ...analyzedIncident.latestAnalysis as IncidentTriageAnalysis,
    result: bugResult,
    ...overrides,
  };
}

function detailFor(
  latest: IncidentTriageAnalysis | null,
  analyses: IncidentTriageAnalysis[] = latest ? [latest] : [],
): IncidentTriageDetailResponse {
  return { incident: { ...analyzedIncident, latestAnalysis: latest }, analyses };
}

async function openDetail(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByTestId('incident-triage-view-inc-2'));
  const drawer = await screen.findByTestId('incident-triage-detail');
  await within(drawer).findByText(/cannot open the timecard page/);
  return drawer;
}

function stateWithDetail(
  latest: IncidentTriageAnalysis | null,
  extra: Partial<FetchState> = {},
  analyses?: IncidentTriageAnalysis[],
): FetchState {
  return {
    list: { incidents: [analyzedIncident] },
    sweepResult: { fetched: 0, upserted: 0, newAnalyses: 0 },
    details: { 'inc-2': detailFor(latest, analyses) },
    ...extra,
  };
}

describe('IncidentTriagePage', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    flag.mockReturnValue(true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('renders nothing when the flag is off (VT-24)', () => {
    flag.mockReturnValue(false);
    const fetchMock = installFetch({
      list: { incidents: [incident()] },
      sweepResult: { fetched: 0, upserted: 0, newAnalyses: 0 },
    });
    const { container } = renderPage();

    expect(flag).toHaveBeenCalledWith(INCIDENT_TRIAGE_FLAG, 'MaxView');
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens the detail when the URL has ?incident=<uuid>', async () => {
    const deepLinkId = '3f2c1e1a-4b5d-4c6e-8f70-1a2b3c4d5e6f';
    const linked = { ...analyzedIncident, id: deepLinkId };
    const fetchMock = installFetch({
      list: { incidents: [incident(), linked] },
      sweepResult: { fetched: 0, upserted: 0, newAnalyses: 0 },
    });
    renderPage(ADMIN_PERMISSIONS, `?project=MaxView&incident=${deepLinkId}`);

    const drawer = await screen.findByTestId('incident-triage-detail');
    await within(drawer).findByText(/INC0012346/);
    expect(callsTo(fetchMock, `/api/incident-triage/incidents/${deepLinkId}`, 'GET')).toHaveLength(1);
  });

  it('ignores a non-UUID incident param', async () => {
    const fetchMock = installFetch({
      list: { incidents: [incident()] },
      sweepResult: { fetched: 0, upserted: 0, newAnalyses: 0 },
    });
    renderPage(ADMIN_PERMISSIONS, '?project=MaxView&incident=inc-1');

    await screen.findByTestId('incident-triage-row-inc-1');
    expect(screen.queryByTestId('incident-triage-detail')).not.toBeInTheDocument();
    expect(callsTo(fetchMock, '/api/incident-triage/incidents/inc-1', 'GET')).toHaveLength(0);
  });

  it('lists incidents with number, state, verdict and severity (VT-25)', async () => {
    installFetch({
      list: { incidents: [incident(), analyzedIncident] },
      sweepResult: { fetched: 0, upserted: 0, newAnalyses: 0 },
    });
    renderPage(MEMBER_PERMISSIONS);

    const plainRow = await screen.findByTestId('incident-triage-row-inc-1');
    expect(within(plainRow).getByText('INC0012345')).toBeInTheDocument();
    expect(within(plainRow).getByText('In Progress')).toBeInTheDocument();
    expect(within(plainRow).getByText('MaxView Support')).toBeInTheDocument();

    const analyzedRow = screen.getByTestId('incident-triage-row-inc-2');
    expect(within(analyzedRow).getByText('INC0012346')).toBeInTheDocument();
    expect(within(analyzedRow).getByText('Resolved')).toBeInTheDocument();
    expect(within(analyzedRow).getByText('Bug')).toBeInTheDocument();
    expect(within(analyzedRow).getByText('High')).toBeInTheDocument();
    expect(within(analyzedRow).getByText('Posted')).toBeInTheDocument();
  });

  it('hides the sweep button and settings without the run/manage permissions (VT-25)', async () => {
    const fetchMock = installFetch({
      list: { incidents: [incident()] },
      sweepResult: { fetched: 0, upserted: 0, newAnalyses: 0 },
    });
    renderPage(MEMBER_PERMISSIONS);

    await screen.findByTestId('incident-triage-row-inc-1');
    expect(screen.queryByTestId('incident-triage-sweep-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('incident-triage-settings')).not.toBeInTheDocument();
    expect(callsTo(fetchMock, '/api/incident-triage/settings', 'GET')).toHaveLength(0);
  });

  it('shows the sweep button and settings with the run and manage permissions', async () => {
    installFetch({
      list: { incidents: [incident()] },
      sweepResult: { fetched: 0, upserted: 0, newAnalyses: 0 },
    });
    renderPage();

    expect(await screen.findByTestId('incident-triage-sweep-btn')).toHaveTextContent('Check ServiceNow now');
    expect(await screen.findByTestId('incident-triage-settings')).toBeInTheDocument();
  });

  it('clicking Check ServiceNow now calls the sweep endpoint and refetches (VT-26)', async () => {
    const state: FetchState = {
      list: { incidents: [incident()] },
      sweepResult: { fetched: 3, upserted: 2, newAnalyses: 1 },
    };
    const fetchMock = installFetch(state);
    renderPage();

    await screen.findByTestId('incident-triage-row-inc-1');
    expect(callsTo(fetchMock, '/api/incident-triage/incidents', 'GET')).toHaveLength(1);

    state.list = { incidents: [incident(), analyzedIncident] };
    fireEvent.click(screen.getByTestId('incident-triage-sweep-btn'));

    await waitFor(() => {
      expect(callsTo(fetchMock, '/api/incident-triage/sweep', 'POST')).toHaveLength(1);
    });
    const [, init] = callsTo(fetchMock, '/api/incident-triage/sweep', 'POST')[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ project: 'MaxView' });
    expect((init as RequestInit).credentials).toBe('include');

    expect(await screen.findByTestId('incident-triage-row-inc-2')).toBeInTheDocument();
    expect(callsTo(fetchMock, '/api/incident-triage/incidents', 'GET').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('incident-triage-sweep-result')).toHaveTextContent('3 fetched');
  });

  it('sends the verdict filter and search text to the list endpoint', async () => {
    const fetchMock = installFetch({
      list: { incidents: [incident()] },
      sweepResult: { fetched: 0, upserted: 0, newAnalyses: 0 },
    });
    renderPage(MEMBER_PERMISSIONS);
    await screen.findByTestId('incident-triage-row-inc-1');

    fireEvent.change(screen.getByTestId('incident-triage-verdict-filter'), { target: { value: 'bug' } });

    await waitFor(() => {
      const urls = callsTo(fetchMock, '/api/incident-triage/incidents', 'GET').map(([input]) => String(input));
      expect(urls.some((url) => url.includes('verdict=bug'))).toBe(true);
    });
    fireEvent.change(screen.getByTestId('incident-triage-search'), { target: { value: 'timecard' } });

    await waitFor(() => {
      const urls = callsTo(fetchMock, '/api/incident-triage/incidents', 'GET').map(([input]) => String(input));
      expect(urls.some((url) => url.includes('verdict=bug') && url.includes('q=timecard'))).toBe(true);
    });
    expect(
      callsTo(fetchMock, '/api/incident-triage/incidents', 'GET')
        .map(([input]) => String(input))
        .every((url) => url.includes('project=MaxView')),
    ).toBe(true);
  });

  it('opens the detail with the ServiceNow link and the not-analyzed placeholder', async () => {
    installFetch({
      list: { incidents: [incident()] },
      sweepResult: { fetched: 0, upserted: 0, newAnalyses: 0 },
    });
    renderPage(MEMBER_PERMISSIONS);

    fireEvent.click(await screen.findByTestId('incident-triage-view-inc-1'));

    const drawer = await screen.findByTestId('incident-triage-detail');
    expect(await within(drawer).findByText(/cannot open the timecard page/)).toBeInTheDocument();
    const link = within(drawer).getByTestId('incident-triage-detail-servicenow-link');
    expect(link).toHaveAttribute('href', 'https://example.service-now.com/incident.do?sys_id=sys-1');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    expect(within(drawer).getByTestId('incident-triage-detail-not-analyzed')).toHaveTextContent('Not analyzed yet');

    fireEvent.click(within(drawer).getByTestId('incident-triage-detail-close'));
    expect(screen.queryByTestId('incident-triage-detail')).not.toBeInTheDocument();
  });

  it('settings save sends the update', async () => {
    const fetchMock = installFetch({
      list: { incidents: [] },
      sweepResult: { fetched: 0, upserted: 0, newAnalyses: 0 },
    });
    renderPage();

    const groups = await screen.findByTestId('incident-triage-settings-groups');
    await waitFor(() => expect(groups).toHaveValue(SYS_ID_A));
    const webhook = screen.getByTestId('incident-triage-settings-webhook');
    expect(webhook).toHaveAttribute('type', 'password');
    expect(webhook).not.toHaveAttribute('readonly');
    expect(webhook).toHaveValue('');
    expect(webhook).toHaveAttribute('placeholder', 'prod-12.westus.logic.azure.com…');

    fireEvent.change(groups, { target: { value: `${SYS_ID_A}\n${SYS_ID_B}` } });
    fireEvent.change(screen.getByTestId('incident-triage-settings-backfill'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('incident-triage-settings-enabled'));
    fireEvent.click(screen.getByTestId('incident-triage-settings-save'));

    await waitFor(() => {
      expect(callsTo(fetchMock, '/api/incident-triage/settings', 'PUT')).toHaveLength(1);
    });
    const [, init] = callsTo(fetchMock, '/api/incident-triage/settings', 'PUT')[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      project: 'MaxView',
      enabled: false,
      assignmentGroupIds: [SYS_ID_A, SYS_ID_B],
      backfillDays: 30,
    });
  });

  it('rejects a group id that is not a sys_id without calling the server', async () => {
    const fetchMock = installFetch({
      list: { incidents: [] },
      sweepResult: { fetched: 0, upserted: 0, newAnalyses: 0 },
    });
    renderPage();

    const groups = await screen.findByTestId('incident-triage-settings-groups');
    await waitFor(() => expect(groups).toHaveValue(SYS_ID_A));
    fireEvent.change(groups, { target: { value: 'not-a-sys-id' } });
    fireEvent.click(screen.getByTestId('incident-triage-settings-save'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/32-character/);
    expect(callsTo(fetchMock, '/api/incident-triage/settings', 'PUT')).toHaveLength(0);
  });

  describe('analysis in the detail drawer', () => {
    it('detail shows summary, verdict, severity, code and telemetry evidence, and next action (VT-25)', async () => {
      installFetch(stateWithDetail(analysis()));
      renderPage(MEMBER_PERMISSIONS);

      const drawer = await openDetail();
      const panel = await within(drawer).findByTestId('incident-triage-detail-analysis');

      expect(within(panel).getByText('Invoice totals are summed before currency conversion.')).toBeInTheDocument();
      expect(within(panel).getByTestId('incident-triage-detail-verdict')).toHaveTextContent('Bug');
      expect(within(panel).getByTestId('incident-triage-detail-severity')).toHaveTextContent('High');
      expect(within(panel).getByTestId('incident-triage-detail-confidence')).toHaveTextContent('Medium');
      expect(within(panel).getByTestId('incident-triage-detail-area')).toHaveTextContent('Invoicing');

      const code = within(panel).getByTestId('incident-triage-detail-code-evidence');
      expect(code).toHaveTextContent('InvoiceExport sums Amount before conversion <b>raw</b>');
      expect(code.querySelector('b')).toBeNull();
      expect(within(panel).getByTestId('incident-triage-detail-telemetry-evidence'))
        .toHaveTextContent('12 exceptions in the last 24 hours');
      expect(within(panel).getByTestId('incident-triage-detail-next-action'))
        .toHaveTextContent('Assign to the Invoicing team.');
      expect(within(panel).getByTestId('incident-triage-detail-model')).toHaveTextContent('composer-2.5');
    });

    it('shows the suggested fix only for a bug verdict', async () => {
      installFetch(stateWithDetail(analysis()));
      const first = renderPage(MEMBER_PERMISSIONS);
      const bugDrawer = await openDetail();
      expect(within(bugDrawer).getByTestId('incident-triage-detail-suggested-fix'))
        .toHaveTextContent('Convert each line to the invoice currency before summing.');
      first.unmount();

      installFetch(stateWithDetail(analysis({
        verdict: 'config',
        result: { ...bugResult, verdict: 'config' },
      })));
      renderPage(MEMBER_PERMISSIONS);
      const configDrawer = await openDetail();
      await within(configDrawer).findByTestId('incident-triage-detail-next-action');
      expect(within(configDrawer).getByTestId('incident-triage-detail-verdict')).toHaveTextContent('Config');
      expect(within(configDrawer).queryByTestId('incident-triage-detail-suggested-fix')).not.toBeInTheDocument();
      expect(within(configDrawer).queryByText(/Convert each line/)).not.toBeInTheDocument();
    });

    it('shows a spinner while the analysis is queued or running', async () => {
      installFetch(stateWithDetail(analysis({
        status: 'running',
        verdict: null,
        area: null,
        severity: null,
        result: null,
        completedAt: null,
      })));
      renderPage(MEMBER_PERMISSIONS);

      const drawer = await openDetail();
      const running = await within(drawer).findByTestId('incident-triage-detail-running');
      expect(running).toHaveAttribute('role', 'status');
      expect(running).toHaveTextContent('Analyzing');
    });

    it('failed analysis shows the failure detail', async () => {
      installFetch(stateWithDetail(analysis({
        status: 'failed',
        verdict: null,
        area: null,
        severity: null,
        result: null,
        completedAt: '2026-11-19T10:05:00.000Z',
        failureDetail: 'The run ended before it wrote a result.',
      })));
      renderPage(MEMBER_PERMISSIONS);

      const drawer = await openDetail();
      const failure = await within(drawer).findByTestId('incident-triage-detail-failure');
      expect(failure).toHaveTextContent('Analysis failed');
      expect(failure).toHaveTextContent('The run ended before it wrote a result.');
    });

    it('lists earlier analyses under the latest one', async () => {
      const earlier = analysis({
        runId: 'run-0',
        verdict: 'insufficient_evidence',
        severity: 'low',
        result: null,
        requestedAt: '2026-11-18T10:00:00.000Z',
        completedAt: '2026-11-18T10:05:00.000Z',
      });
      const latest = analysis();
      installFetch(stateWithDetail(latest, {}, [latest, earlier]));
      renderPage(MEMBER_PERMISSIONS);

      const drawer = await openDetail();
      const history = await within(drawer).findByTestId('incident-triage-detail-history');
      expect(within(history).getAllByRole('listitem')).toHaveLength(1);
      expect(history).toHaveTextContent('Insufficient evidence');
      expect(history).toHaveTextContent('Low');
    });
  });

  describe('re-analyze', () => {
    it('calls the analyze endpoint and refetches the detail', async () => {
      const fetchMock = installFetch(stateWithDetail(analysis()));
      renderPage();

      const drawer = await openDetail();
      const detailGets = () => callsTo(fetchMock, '/api/incident-triage/incidents/inc-2', 'GET').length;
      expect(detailGets()).toBe(1);
      fireEvent.click(within(drawer).getByTestId('incident-triage-detail-reanalyze'));

      await waitFor(() => {
        expect(callsTo(fetchMock, '/api/incident-triage/incidents/inc-2/analyze', 'POST')).toHaveLength(1);
      });
      const [, init] = callsTo(fetchMock, '/api/incident-triage/incidents/inc-2/analyze', 'POST')[0];
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({ project: 'MaxView' });
      await waitFor(() => expect(detailGets()).toBeGreaterThanOrEqual(2));
    });

    it("shows 'Analysis already running' on 409", async () => {
      installFetch(stateWithDetail(analysis(), {
        analyze: { status: 409, body: { error: 'conflict' } },
      }));
      renderPage();

      const drawer = await openDetail();
      fireEvent.click(within(drawer).getByTestId('incident-triage-detail-reanalyze'));

      expect(await within(drawer).findByTestId('incident-triage-detail-reanalyze-message'))
        .toHaveTextContent('Analysis already running');
    });

    it('is hidden without the run permission', async () => {
      installFetch(stateWithDetail(analysis()));
      renderPage(MEMBER_PERMISSIONS);

      const drawer = await openDetail();
      await within(drawer).findByTestId('incident-triage-detail-analysis');
      expect(within(drawer).queryByTestId('incident-triage-detail-reanalyze')).not.toBeInTheDocument();
    });
  });

  describe('polling', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('detail polls while the latest analysis is running and stops when completed', async () => {
      const running = analysis({
        status: 'running',
        verdict: null,
        area: null,
        severity: null,
        result: null,
        completedAt: null,
      });
      const state = stateWithDetail(running);
      const fetchMock = installFetch(state);
      renderPage(MEMBER_PERMISSIONS);

      const drawer = await openDetail();
      const detailGets = () => callsTo(fetchMock, '/api/incident-triage/incidents/inc-2', 'GET').length;
      expect(detailGets()).toBe(1);

      await act(async () => { await jest.advanceTimersByTimeAsync(9_000); });
      expect(detailGets()).toBe(1);
      await act(async () => { await jest.advanceTimersByTimeAsync(1_000); });
      expect(detailGets()).toBe(2);

      state.details = { 'inc-2': detailFor(analysis()) };
      await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
      expect(detailGets()).toBe(3);
      expect(await within(drawer).findByTestId('incident-triage-detail-verdict')).toHaveTextContent('Bug');

      await act(async () => { await jest.advanceTimersByTimeAsync(60_000); });
      expect(detailGets()).toBe(3);
    });
  });

  describe('webhook settings', () => {
    const WEBHOOK_URL = 'https://prod-1.westus.logic.azure.com/workflows/secret-token-9876';

    async function openSettings() {
      const rendered = renderPage();
      const input = await screen.findByTestId('incident-triage-settings-webhook');
      return { ...rendered, input };
    }

    it('save webhook sends teamsWebhookUrl and the URL is not rendered back', async () => {
      const fetchMock = installFetch({
        list: { incidents: [] },
        sweepResult: { fetched: 0, upserted: 0, newAnalyses: 0 },
      });
      const { client, input } = await openSettings();

      fireEvent.change(input, { target: { value: WEBHOOK_URL } });
      fireEvent.click(screen.getByTestId('incident-triage-settings-webhook-save'));

      await waitFor(() => {
        expect(callsTo(fetchMock, '/api/incident-triage/settings', 'PUT')).toHaveLength(1);
      });
      const [, init] = callsTo(fetchMock, '/api/incident-triage/settings', 'PUT')[0];
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({
        project: 'MaxView',
        teamsWebhookUrl: WEBHOOK_URL,
      });

      await waitFor(() => expect(input).toHaveValue(''));
      expect(input).toHaveAttribute('placeholder', 'prod-1.westus.logic.azure.com…');
      expect(document.body.innerHTML).not.toContain('secret-token');
      expect(document.body.innerHTML).not.toContain('9876');
      const cached = JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data));
      expect(cached).not.toContain('secret-token');
      await waitFor(() => {
        const variables = JSON.stringify(client.getMutationCache().getAll().map((mutation) => mutation.state.variables));
        expect(variables).not.toContain('secret-token');
      });
    });

    it('rejects an empty or non-https webhook without calling the server', async () => {
      const fetchMock = installFetch({
        list: { incidents: [] },
        sweepResult: { fetched: 0, upserted: 0, newAnalyses: 0 },
      });
      const { input } = await openSettings();

      fireEvent.click(screen.getByTestId('incident-triage-settings-webhook-save'));
      expect(await screen.findByTestId('incident-triage-settings-webhook-error')).toHaveTextContent(/https/i);

      fireEvent.change(input, { target: { value: 'http://example.com/hook' } });
      fireEvent.click(screen.getByTestId('incident-triage-settings-webhook-save'));
      await waitFor(() => {
        expect(screen.getByTestId('incident-triage-settings-webhook-error')).toHaveTextContent(/https/i);
      });
      expect(callsTo(fetchMock, '/api/incident-triage/settings', 'PUT')).toHaveLength(0);
    });

    it('remove sends null after a confirm', async () => {
      const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
      const fetchMock = installFetch({
        list: { incidents: [] },
        sweepResult: { fetched: 0, upserted: 0, newAnalyses: 0 },
      });
      const { input } = await openSettings();

      fireEvent.click(screen.getByTestId('incident-triage-settings-webhook-remove'));

      await waitFor(() => {
        expect(callsTo(fetchMock, '/api/incident-triage/settings', 'PUT')).toHaveLength(1);
      });
      const [, init] = callsTo(fetchMock, '/api/incident-triage/settings', 'PUT')[0];
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({
        project: 'MaxView',
        teamsWebhookUrl: null,
      });
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(input).toHaveAttribute('placeholder', 'Not set'));
      confirmSpy.mockRestore();
    });

    it('remove does nothing when the confirm is declined', async () => {
      const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
      const fetchMock = installFetch({
        list: { incidents: [] },
        sweepResult: { fetched: 0, upserted: 0, newAnalyses: 0 },
      });
      await openSettings();

      fireEvent.click(screen.getByTestId('incident-triage-settings-webhook-remove'));

      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(callsTo(fetchMock, '/api/incident-triage/settings', 'PUT')).toHaveLength(0);
      confirmSpy.mockRestore();
    });

    it.each([
      ['200', { status: 200, body: { ok: true } }, 'Posted'],
      ['409', { status: 409, body: { error: 'no webhook' } }, 'No webhook set'],
      ['502', { status: 502, body: { error: 'Teams returned 500' } }, 'Teams returned 500'],
    ])('Send test card shows the result for %s', async (_label, testPost, expected) => {
      const fetchMock = installFetch({
        list: { incidents: [] },
        sweepResult: { fetched: 0, upserted: 0, newAnalyses: 0 },
        testPost,
      });
      await openSettings();

      fireEvent.click(screen.getByTestId('incident-triage-settings-test-post'));

      expect(await screen.findByTestId('incident-triage-settings-test-post-result')).toHaveTextContent(expected);
      const [, init] = callsTo(fetchMock, '/api/incident-triage/settings/test-post', 'POST')[0];
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({ project: 'MaxView' });
    });
  });
});
