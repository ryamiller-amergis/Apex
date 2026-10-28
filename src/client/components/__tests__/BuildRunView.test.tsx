/**
 * PBI-016 AC-0..AC-3, PBI-017 AC-0..AC-3, PBI-018 AC-0..AC-3 / VT-19..VT-29, VT-31..VT-34.
 */
import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import type { BuildDetailResponse, BuildTaskView } from '../../../shared/types/buildView';
import { BuildRunView } from '../BuildRunView';

let flagState: { flags: Record<string, boolean>; isPending: boolean } = {
  flags: { 'build-from-prompt': true },
  isPending: false,
};
jest.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlags: () => flagState,
}));

const BUILD_ID = '00000000-0000-4000-8000-000000000001';

function task(key: string, overrides: Partial<BuildTaskView> = {}): BuildTaskView {
  return {
    key,
    role: 'implementer',
    dependsOn: [],
    ownedFiles: [`src/${key}.ts`],
    reuse: [],
    runMode: 'own_agent',
    branch: `apex/build/${BUILD_ID}/${key}`,
    status: 'pending',
    attempt: 1,
    omittedReason: null,
    ...overrides,
  };
}

function detail(overrides: Partial<BuildDetailResponse> = {}): BuildDetailResponse {
  return {
    build: {
      id: BUILD_ID,
      project: 'Apex',
      repository: 'apex',
      status: 'building',
      currentRevisionNumber: 1,
      intakeInterviewId: 'iv-1',
      createdAt: '2026-10-28T10:00:00.000Z',
      endedAt: null,
    },
    stage: { kind: 'stage', key: 'building', tasks: { merged: 3, total: 5 }, queuePosition: null, suspendReason: null },
    timing: { elapsedSeconds: 125, targetSeconds: 300, state: 'within', includesDeployment: true },
    caps: {
      cost: { usedUsd: '3.5000', limitUsd: '25.0000' },
      revisions: { used: 0, limit: 5 },
      elapsedSeconds: { used: 125, limit: 3600 },
      parallelism: { used: 2, limit: 3 },
    },
    supportContacts: [{ displayName: 'Dana', email: 'dana@example.com' }],
    revisions: [{ number: 1, createdAt: '2026-10-28T10:00:00.000Z', classification: 'small', deploymentStatus: 'not_started', previewUrl: null }],
    currentRevision: {
      number: 1,
      classification: 'small',
      repairAttempts: 0,
      brief: {
        status: 'ok',
        overview: null,
        requirements: [
          { id: 'AC-10', kind: 'ac', text: 'Tenth criterion', retired: false },
          { id: 'AC-2', kind: 'ac', text: 'Second criterion', retired: true },
          { id: 'BR-1', kind: 'br', text: 'A business rule', retired: false },
        ],
        assumptions: ['Users are signed in'],
        exclusions: ['No mobile layout'],
        riskDecisions: [{ id: 'RD-1', category: 'access', rating: 'high', decision: 'Use the read role', rationale: 'Least access' }],
      },
      tasks: [
        task('a', { status: 'merged' }),
        task('b', { status: 'merged', dependsOn: ['a'], reuse: [{ path: 'src/client/hooks/useBuilds.ts', symbol: 'useBuild' }] }),
        task('c', { status: 'merged' }),
        task('d', { status: 'running', dependsOn: ['b', 'c'] }),
        task('e', { status: 'pending', dependsOn: ['d'] }),
        task('qa', { role: 'qa', status: 'omitted', omittedReason: 'No user-facing change to test' }),
      ],
    },
    verificationSummary: { total: 0, pass: 0, fail: 0, deferred: 0, retired: 0 },
    lease: null,
    ...overrides,
  };
}

function json(status: number, body: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) });
}

type Handler = (url: string) => Promise<unknown>;
let fetchMock: jest.Mock;

function stubFetch(detailHandler: Handler, eventsHandler: Handler = () => json(200, { events: [], total: 0 })) {
  fetchMock = jest.fn((url: string) => (url.includes('/events') ? eventsHandler(url) : detailHandler(url)));
  global.fetch = fetchMock as unknown as typeof fetch;
}

function detailCalls() {
  return fetchMock.mock.calls.filter(([url]) => !String(url).includes('/events')).length;
}

const LocationProbe: React.FC = () => {
  const location = useLocation();
  return <span {...{ 'data-testid': 'location' }}>{location.pathname}</span>;
};

const RoutedView: React.FC = () => {
  const { buildId, tab } = useParams();
  return <BuildRunView project="Apex" buildId={buildId ?? ''} tab={tab} />;
};

function renderAt(path: string) {
  const queryClient = new QueryClient();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/builds/:buildId/:tab?" element={<RoutedView />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

beforeEach(() => {
  flagState = { flags: { 'build-from-prompt': true }, isPending: false };
  stubFetch(() => json(200, detail()));
});

describe('header (PBI-016)', () => {
  it('VT-19 PBI-016 AC-0 shows the stage, elapsed against the target and four cap lines', async () => {
    renderAt(`/builds/${BUILD_ID}`);
    expect(await screen.findByTestId('build-run-stage-text')).toHaveTextContent('Building, 3 of 5 tasks');
    expect(screen.getByTestId('build-run-elapsed')).toHaveTextContent('Elapsed (includes deployment): 2 min 5 s');
    expect(screen.getByTestId('build-run-target')).toHaveTextContent('Target: 5 min');
    expect(screen.getByTestId('build-run-cap-cost')).toHaveTextContent('Estimated cost: $3.50 of $25.00');
    expect(screen.getByTestId('build-run-cap-revisions')).toHaveTextContent('Revisions: 0 of 5');
    expect(screen.getByTestId('build-run-cap-elapsed')).toHaveTextContent('Time used');
    expect(screen.getByTestId('build-run-cap-parallelism')).toHaveTextContent('Parallel agents: 2 of 3');
    expect(fetchMock).toHaveBeenCalledWith(`/api/builds/${BUILD_ID}?project=Apex`, expect.objectContaining({ credentials: 'include' }));
  });

  it('VT-21 PBI-016 AC-2 reads "Building, 3 of 5 tasks"', async () => {
    renderAt(`/builds/${BUILD_ID}`);
    expect(await screen.findByTestId('build-run-stage-text')).toHaveTextContent(/^Building, 3 of 5 tasks$/);
  });

  it('VT-23 puts only the stage sentence in a polite live region and updates it', async () => {
    let status: 'building' | 'checking' = 'building';
    stubFetch(() => json(200, detail(status === 'checking'
      ? { stage: { kind: 'stage', key: 'checking', tasks: null, queuePosition: null, suspendReason: null } }
      : {})));
    const { queryClient } = renderAt(`/builds/${BUILD_ID}`);
    const region = await screen.findByTestId('build-run-stage');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent(/^Building, 3 of 5 tasks$/);
    expect(region).not.toContainElement(screen.getByTestId('build-run-elapsed'));
    expect(region).not.toContainElement(screen.getByTestId('build-run-caps'));
    status = 'checking';
    await act(async () => { await queryClient.refetchQueries({ queryKey: ['build', 'Apex', BUILD_ID] }); });
    await waitFor(() => expect(screen.getByTestId('build-run-stage')).toHaveTextContent(/^Checking$/));
  });

  it('VT-20 PBI-016 AC-1 keeps the last stage with a stale indicator and retries', async () => {
    let fail = false;
    stubFetch(() => (fail ? json(500, { error: 'boom' }) : json(200, detail())));
    const { queryClient } = renderAt(`/builds/${BUILD_ID}`);
    await screen.findByTestId('build-run-stage-text');
    fail = true;
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['build', 'Apex', BUILD_ID] }).catch(() => undefined);
    });
    expect(await screen.findByTestId('build-run-stale-indicator', {}, { timeout: 6000 }))
      .toHaveTextContent(/Could not refresh\. Retrying\./);
    expect(screen.getByTestId('build-run-stage-text')).toHaveTextContent('Building, 3 of 5 tasks');
    const before = detailCalls();
    await userEvent.click(screen.getByTestId('build-run-stale-retry'));
    await waitFor(() => expect(detailCalls()).toBeGreaterThan(before));
  }, 15000);

  it('VT-22 PBI-016 AC-3 explains a suspended build and names who to contact', async () => {
    stubFetch(() => json(200, detail({
      build: { ...detail().build, status: 'suspended' },
      stage: { kind: 'exception', key: 'suspended', tasks: null, queuePosition: null, suspendReason: 'cost_cap' },
    })));
    renderAt(`/builds/${BUILD_ID}`);
    expect(await screen.findByTestId('build-run-exception-cause')).toHaveTextContent(/cost limit/);
    expect(screen.getByTestId('build-run-exception-contacts')).toHaveTextContent('Contact a Project Admin.');
    expect(screen.getByTestId('build-run-exception-resume')).toHaveTextContent(/can resume this build/);
    expect(screen.queryByTestId('build-run-actions')).not.toBeInTheDocument();
  });

  it('VT-22 names the support contacts for deployment failed and flags a missing suspend reason', async () => {
    stubFetch(() => json(200, detail({
      build: { ...detail().build, status: 'deployment_failed' },
      stage: { kind: 'exception', key: 'deployment_failed', tasks: null, queuePosition: null, suspendReason: null },
    })));
    const first = renderAt(`/builds/${BUILD_ID}`);
    expect(await screen.findByTestId('build-run-exception-cause')).toHaveTextContent('Dana (dana@example.com) have been notified');
    first.unmount();

    stubFetch(() => json(200, detail({
      build: { ...detail().build, status: 'suspended' },
      stage: { kind: 'exception', key: 'suspended', tasks: null, queuePosition: null, suspendReason: null },
    })));
    renderAt(`/builds/${BUILD_ID}`);
    expect(await screen.findByTestId('build-run-exception-cause')).toHaveTextContent(/reason is missing\. This is a data error/);
  });
});

describe('access and loading (PBI-017 AC-3)', () => {
  it('VT-27 shows the forbidden screen with no build content and does not retry', async () => {
    stubFetch(() => json(403, { error: 'Forbidden' }));
    renderAt(`/builds/${BUILD_ID}/overview`);
    expect(await screen.findByTestId('build-run-forbidden')).toHaveTextContent('You do not have access to this build.');
    expect(screen.queryByTestId('build-run-header')).not.toBeInTheDocument();
    expect(screen.queryByTestId('build-run-tabs')).not.toBeInTheDocument();
    expect(detailCalls()).toBe(1);
  });

  it('VT-27 shows the not-found screen for a 404', async () => {
    stubFetch(() => json(404, { error: 'Not found' }));
    renderAt(`/builds/${BUILD_ID}`);
    expect(await screen.findByTestId('build-run-not-found')).toHaveTextContent('This build does not exist in this project.');
    expect(detailCalls()).toBe(1);
  });
});

describe('tabs (PBI-017 AC-0)', () => {
  it('VT-28 follows the tab pattern with arrows, Home, End and Enter', async () => {
    const user = userEvent.setup();
    renderAt(`/builds/${BUILD_ID}`);
    const overview = await screen.findByTestId('build-run-tab-overview');
    const plan = screen.getByTestId('build-run-tab-plan');
    const timeline = screen.getByTestId('build-run-tab-timeline');
    expect(screen.getByTestId('build-run-tabs')).toHaveAttribute('role', 'tablist');
    expect(overview).toHaveAttribute('aria-selected', 'true');
    expect(overview).toHaveAttribute('tabindex', '0');
    expect(plan).toHaveAttribute('tabindex', '-1');
    const panel = screen.getByTestId('build-run-panel-overview');
    expect(panel).toHaveAttribute('role', 'tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', overview.id);
    expect(overview).toHaveAttribute('aria-controls', panel.id);

    overview.focus();
    await user.keyboard('{ArrowRight}');
    expect(plan).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(overview).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(timeline).toHaveFocus();
    await user.keyboard('{Home}');
    expect(overview).toHaveFocus();
    await user.keyboard('{End}');
    expect(timeline).toHaveFocus();
    await user.keyboard('{ArrowLeft}{Enter}');
    expect(screen.getByTestId('location')).toHaveTextContent(`/builds/${BUILD_ID}/plan`);
    expect(await screen.findByTestId('build-run-panel-plan')).toBeInTheDocument();
  });

  it('VT-28 redirects an unknown tab segment to Overview', async () => {
    renderAt(`/builds/${BUILD_ID}/unknown`);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/builds/${BUILD_ID}/overview`));
    expect(await screen.findByTestId('build-run-panel-overview')).toBeInTheDocument();
  });
});

describe('Overview tab (PBI-017)', () => {
  it('VT-24 PBI-017 AC-0 shows overview, grouped requirements, assumptions, exclusions and risk decisions', async () => {
    renderAt(`/builds/${BUILD_ID}/overview`);
    expect(await screen.findByTestId('build-overview-summary')).toHaveTextContent('Overview not available.');
    const rows = screen.getAllByTestId('build-overview-requirement');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('AC-2'),
      expect.stringContaining('AC-10'),
      expect.stringContaining('BR-1'),
    ]);
    expect(screen.getByText('Acceptance criteria')).toBeInTheDocument();
    expect(screen.getByText('Business rules')).toBeInTheDocument();
    expect(screen.getByTestId('build-overview-assumptions')).toHaveTextContent('Users are signed in');
    expect(screen.getByTestId('build-overview-exclusions')).toHaveTextContent('No mobile layout');
    const risks = screen.getByTestId('build-overview-risk-decisions');
    expect(within(risks).getByText('Rating: High')).toBeInTheDocument();
    expect(within(risks).getByText('Least access')).toBeInTheDocument();
  });

  it('VT-26 PBI-017 AC-2 keeps a retired requirement marked Retired', async () => {
    renderAt(`/builds/${BUILD_ID}/overview`);
    const retired = await screen.findByTestId('build-overview-requirement-retired');
    expect(retired).toHaveTextContent('Retired');
    expect(retired.closest('li')).toHaveTextContent('Second criterion');
  });

  it('VT-25 PBI-017 AC-1 shows an error with retry while the header stays', async () => {
    const unavailable = detail();
    unavailable.currentRevision = { ...unavailable.currentRevision!, brief: { status: 'unavailable' } };
    stubFetch(() => json(200, unavailable));
    renderAt(`/builds/${BUILD_ID}/overview`);
    expect(await screen.findByTestId('build-overview-error')).toHaveTextContent('Could not load the brief.');
    expect(screen.getByTestId('build-run-header')).toBeInTheDocument();
    const before = detailCalls();
    await userEvent.click(screen.getByTestId('build-overview-retry'));
    await waitFor(() => expect(detailCalls()).toBeGreaterThan(before));
  });
});

describe('Plan tab (PBI-018)', () => {
  it('VT-29 PBI-018 AC-0 groups tasks by blockers with role, files, reuse, branch and status', async () => {
    renderAt(`/builds/${BUILD_ID}/plan`);
    const groups = await screen.findAllByTestId('build-plan-group');
    const keysPerGroup = groups.map((group) => within(group).getAllByTestId('build-plan-task')
      .map((row) => row.querySelector('span')?.textContent));
    expect(keysPerGroup).toEqual([['a', 'c', 'qa'], ['b'], ['d'], ['e']]);
    const taskB = within(groups[1]).getByTestId('build-plan-task');
    expect(taskB).toHaveTextContent('Implementer');
    expect(taskB).toHaveTextContent('Owns: src/b.ts');
    expect(taskB).toHaveTextContent('Reuses: useBuild (src/client/hooks/useBuilds.ts)');
    expect(taskB).toHaveTextContent(`Branch: apex/build/${BUILD_ID}/b`);
    expect(within(taskB).getByTestId('build-plan-task-status')).toHaveTextContent('Merged');
    expect(screen.getByTestId('build-plan-task-no-reuse-a')).toHaveTextContent('Nothing reusable found');
  });

  it('VT-31 PBI-018 AC-2 shows an omitted specialist with its reason', async () => {
    renderAt(`/builds/${BUILD_ID}/plan`);
    const reason = await screen.findByTestId('build-plan-task-omitted-reason');
    expect(reason).toHaveTextContent('No user-facing change to test');
    expect(within(reason.closest('li') as HTMLElement).getByTestId('build-plan-task-status')).toHaveTextContent('Omitted');
  });

  it('VT-32 renders 50 tasks in under a second', async () => {
    const many = detail();
    many.currentRevision = {
      ...many.currentRevision!,
      tasks: Array.from({ length: 50 }, (_, index) => task(`t${index}`, { dependsOn: index > 0 ? [`t${index - 1}`] : [] })),
    };
    stubFetch(() => json(200, many));
    const started = performance.now();
    renderAt(`/builds/${BUILD_ID}/plan`);
    await waitFor(() => expect(screen.getAllByTestId('build-plan-task')).toHaveLength(50));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('shows the empty-plan text before a plan exists', async () => {
    const empty = detail();
    empty.currentRevision = { ...empty.currentRevision!, tasks: [] };
    stubFetch(() => json(200, empty));
    renderAt(`/builds/${BUILD_ID}/plan`);
    expect(await screen.findByTestId('build-plan-empty')).toHaveTextContent('No plan yet.');
  });
});

describe('Timeline tab (PBI-018)', () => {
  it('VT-33 PBI-018 AC-3 renders messages as text in an ordered list with times and a total', async () => {
    stubFetch(() => json(200, detail()), () => json(200, {
      events: [
        { id: 'e1', occurredAt: '2026-10-28T10:00:00.000Z', kind: 'task.merged', message: '<img src=x onerror=alert(1)>', taskKey: 'a' },
        { id: 'e2', occurredAt: '2026-10-28T10:01:00.000Z', kind: 'task.failed', message: 'Token [REDACTED:bearer-token]', taskKey: null },
      ],
      total: 600,
    }));
    renderAt(`/builds/${BUILD_ID}/timeline`);
    const list = await screen.findByTestId('build-timeline-list');
    expect(list.tagName).toBe('OL');
    expect(list.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(screen.getByText('Token [REDACTED:bearer-token]')).toBeInTheDocument();
    expect(list.querySelectorAll('time[datetime]')).toHaveLength(2);
    expect(screen.getByTestId('build-timeline-total')).toHaveTextContent('Showing the latest 2 of 600');
    expect(fetchMock).toHaveBeenCalledWith(`/api/builds/${BUILD_ID}/events?project=Apex`, expect.objectContaining({ credentials: 'include' }));
  });

  it('VT-33 PBI-018 AC-1 shows an error with retry when events fail', async () => {
    let fail = true;
    stubFetch(() => json(200, detail()), () => (fail ? json(403, { error: 'Forbidden' }) : json(200, { events: [], total: 0 })));
    renderAt(`/builds/${BUILD_ID}/timeline`);
    expect(await screen.findByTestId('build-timeline-error')).toHaveTextContent('Could not load the timeline.');
    fail = false;
    await userEvent.click(screen.getByTestId('build-timeline-retry'));
    expect(await screen.findByTestId('build-timeline-empty')).toHaveTextContent('Nothing has happened yet.');
  });

  it('TBI-015 loads events only while the Timeline tab is open', async () => {
    renderAt(`/builds/${BUILD_ID}/overview`);
    await screen.findByTestId('build-run-panel-overview');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/events'))).toBe(false);
  });
});

describe('flag banner', () => {
  it('VT-34 shows no banner while flags load', async () => {
    flagState = { flags: {}, isPending: true };
    renderAt(`/builds/${BUILD_ID}`);
    await screen.findByTestId('build-run-header');
    expect(screen.queryByTestId('build-run-flag-off-banner')).not.toBeInTheDocument();
  });

  it('VT-34 shows the read-only banner and no actions or back link when the flag is off', async () => {
    flagState = { flags: { 'build-from-prompt': false }, isPending: false };
    renderAt(`/builds/${BUILD_ID}`);
    expect(await screen.findByTestId('build-run-flag-off-banner'))
      .toHaveTextContent('Builds are turned off for this project. You can still read this build.');
    expect(await screen.findByTestId('build-run-header')).toBeInTheDocument();
    expect(screen.queryByTestId('build-run-actions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('build-run-back-link')).not.toBeInTheDocument();
  });

  it('VT-34 shows no banner when the flag is on', async () => {
    renderAt(`/builds/${BUILD_ID}`);
    await screen.findByTestId('build-run-header');
    expect(screen.queryByTestId('build-run-flag-off-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('build-run-back-link')).toBeInTheDocument();
  });
});
