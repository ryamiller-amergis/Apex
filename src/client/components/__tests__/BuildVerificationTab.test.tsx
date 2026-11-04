/**
 * PBI-023 AC-0..AC-3 / VT-30..VT-33.
 */
import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  BuildVerificationMatrixResponse,
  BuildVerificationRowView,
} from '../../../shared/types/buildView';
import { BuildVerificationTab } from '../BuildVerificationTab';

const BUILD_ID = 'b1';

const clients: QueryClient[] = [];

function renderTab(props: Partial<React.ComponentProps<typeof BuildVerificationTab>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  clients.push(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      {/* data-testid-exempt */}
      <BuildVerificationTab project="Apex" buildId={BUILD_ID} buildStatus="preview_ready" {...props} />
    </QueryClientProvider>,
  );
}

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function textResponse(status: number, text: string) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
  });
}

function sampleRows(): BuildVerificationRowView[] {
  return [
    {
      id: 'row-retired',
      requirementId: 'AC-1',
      kind: 'ac',
      requirementText: 'Retired criterion',
      tier: 'unit',
      status: 'retired',
      testReferences: [],
      red: null,
      green: null,
      deferralReason: null,
    },
    {
      id: 'row-rd',
      requirementId: 'RD-1',
      kind: 'risk_decision',
      requirementText: 'Keep destructive actions blocked',
      tier: 'unit',
      status: 'pass',
      testReferences: [{ file: 'src/rd.test.ts', name: 'RD-1: blocks delete' }],
      red: { commit: '1111111abcdef', command: 'npx jest src/rd.test.ts', exitCode: 1, recordedAt: '2026-11-03T10:00:00Z' },
      green: { commit: '2222222abcdef', command: 'npx jest src/rd.test.ts', exitCode: 0, recordedAt: '2026-11-03T10:02:00Z' },
      deferralReason: null,
    },
    {
      id: 'row-nfr',
      requirementId: 'NFR-1',
      kind: 'nfr',
      requirementText: 'Loads under 1 second',
      tier: 'e2e',
      status: 'deferred',
      testReferences: [{ file: 'tests/e2e/perf.spec.ts', name: 'NFR-1: loads fast' }],
      red: null,
      green: null,
      deferralReason: 'Playwright environment is not available in unit run',
    },
    {
      id: 'row-br',
      requirementId: 'BR-1',
      kind: 'br',
      requirementText: 'Evidence required for each requirement',
      tier: 'integration',
      status: 'fail',
      testReferences: [{ file: 'src/br.test.ts', name: 'BR-1: enforces evidence' }],
      red: { commit: 'abcdef1234567', command: 'npx jest src/br.test.ts', exitCode: 1, recordedAt: '2026-11-03T10:00:00Z' },
      green: null,
      deferralReason: null,
    },
    {
      id: 'row-dod',
      requirementId: 'DOD-1',
      kind: 'dod',
      requirementText: 'Typecheck passes',
      tier: 'unit',
      status: 'pass',
      testReferences: [{ file: 'src/dod.test.ts', name: 'DOD-1: compiles' }],
      red: { commit: '3333333abcdef', command: 'npx jest src/dod.test.ts', exitCode: 1, recordedAt: '2026-11-03T10:00:00Z' },
      green: { commit: '4444444abcdef', command: 'npx jest src/dod.test.ts', exitCode: 0, recordedAt: '2026-11-03T10:01:00Z' },
      deferralReason: null,
    },
    {
      id: 'row-ac',
      requirementId: 'AC-2',
      kind: 'ac',
      requirementText: 'Shows verification matrix',
      tier: 'unit',
      status: 'pass',
      testReferences: [{ file: 'src/ac2.test.ts', name: 'AC-2: renders matrix' }],
      red: { commit: 'aaaaaaa111111', command: 'npx jest src/ac2.test.ts', exitCode: 1, recordedAt: '2026-11-03T10:00:00Z' },
      green: { commit: 'bbbbbbb222222', command: 'npx jest src/ac2.test.ts', exitCode: 0, recordedAt: '2026-11-03T10:01:00Z' },
      deferralReason: null,
    },
  ];
}

function matrixFixture(overrides: Partial<BuildVerificationMatrixResponse> = {}): BuildVerificationMatrixResponse {
  const rows = overrides.rows ?? sampleRows();
  return {
    buildId: BUILD_ID,
    revisionNumber: 2,
    revisionNumbers: [2, 1],
    summary: {
      total: 6,
      pass: 3,
      fail: 1,
      deferred: 1,
      retired: 1,
    },
    rows,
    ...overrides,
  };
}

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

describe('BuildVerificationTab', () => {
  it('VT-30 PBI-023 AC-0: renders a labelled 8-column table with status text, summary line, revision selector, and retired rows last', async () => {
    fetchMock.mockImplementation(() => jsonResponse(200, matrixFixture()));
    renderTab();

    const summary = await screen.findByTestId('build-verification-summary');
    expect(summary).toHaveAttribute('role', 'status');
    expect(summary).toHaveTextContent('6 requirements: 3 passed, 1 failing, 1 deferred, 1 retired.');

    const select = screen.getByTestId('build-verification-revision-select') as HTMLSelectElement;
    expect(select.value).toBe('2');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['2', '1']);

    const table = screen.getByTestId('build-verification-matrix');
    expect(table.tagName).toBe('TABLE');
    expect(within(table).getByText('Verification matrix for revision 2')).toBeInTheDocument();

    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toEqual([
      'ID',
      'Kind',
      'Requirement',
      'Tier',
      'Status',
      'Test reference',
      'Red evidence',
      'Green evidence',
    ]);

    // Check row ordering: by kind (ac, dod, br, nfr, risk_decision), then ID, with retired rows last
    const bodyRows = within(table).getAllByTestId(/^build-verification-row-/);
    expect(bodyRows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'build-verification-row-AC-2',
      'build-verification-row-DOD-1',
      'build-verification-row-BR-1',
      'build-verification-row-NFR-1',
      'build-verification-row-RD-1',
      'build-verification-row-AC-1',
    ]);

    // Check kind labels and status labels as text
    expect(within(bodyRows[0]).getByText('Acceptance criterion')).toBeInTheDocument();
    expect(screen.getByTestId('build-verification-status-AC-2')).toHaveTextContent('Passed');
    expect(within(bodyRows[0]).getByText('aaaaaaa')).toBeInTheDocument();
    expect(within(bodyRows[0]).getByText('bbbbbbb')).toBeInTheDocument();

    expect(within(bodyRows[1]).getByText('Definition of done')).toBeInTheDocument();
    expect(within(bodyRows[2]).getByText('Business rule')).toBeInTheDocument();
    expect(screen.getByTestId('build-verification-status-BR-1')).toHaveTextContent('Failing');
    // Failing row with null green evidence shows "Missing"
    expect(within(bodyRows[2]).getByText('Missing')).toBeInTheDocument();

    expect(within(bodyRows[3]).getByText('Non-functional requirement')).toBeInTheDocument();
    expect(screen.getByTestId('build-verification-status-NFR-1')).toHaveTextContent('Deferred');

    expect(within(bodyRows[4]).getByText('Risk decision')).toBeInTheDocument();
    expect(screen.getByTestId('build-verification-status-RD-1')).toHaveTextContent('Passed');

    expect(screen.getByTestId('build-verification-status-AC-1')).toHaveTextContent('Retired');
  });

  it('VT-31 PBI-023 AC-1: shows the not-available message on 404 evidence while keeping matrix rows, and Escape returns focus to the trigger button', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/evidence/')) {
        return jsonResponse(404, {
          error: 'Evidence not available',
          code: 'BUILD_EVIDENCE_NOT_AVAILABLE',
        });
      }
      return jsonResponse(200, matrixFixture());
    });

    renderTab();
    const redButton = await screen.findByTestId('build-verification-red-evidence-AC-2');
    expect(redButton).toHaveAttribute('aria-label', 'View red evidence for AC-2');

    await user.click(redButton);

    const dialog = await screen.findByTestId('build-evidence-dialog');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(await screen.findByTestId('build-evidence-unavailable')).toHaveTextContent(
      'This evidence is no longer available. Evidence is kept for 90 days after a build ends.',
    );

    // Matrix remains mounted and usable behind the dialog
    expect(screen.getByTestId('build-verification-matrix')).toBeInTheDocument();
    expect(screen.getByTestId('build-verification-row-AC-2')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('build-evidence-dialog')).not.toBeInTheDocument());
    expect(redButton).toHaveFocus();
  });

  it('VT-32 PBI-023 AC-2: renders the deferral reason inside a deferred row', async () => {
    fetchMock.mockImplementation(() => jsonResponse(200, matrixFixture()));
    renderTab();

    const reason = await screen.findByTestId('build-verification-deferral-reason-NFR-1');
    expect(reason).toHaveTextContent('Playwright environment is not available in unit run');
    const row = screen.getByTestId('build-verification-row-NFR-1');
    expect(row).toContainElement(reason);
  });

  it('VT-33 PBI-023 AC-3: shows forbidden on 403 evidence, empty state when rows are empty, and error banner with working Retry when matrix fails', async () => {
    const user = userEvent.setup();

    // 1. Matrix fails initially, then succeeds with empty rows on Retry
    let callCount = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/evidence/')) {
        return jsonResponse(403, { error: 'Forbidden', code: 'BUILD_FORBIDDEN' });
      }
      callCount += 1;
      if (callCount === 1) {
        return jsonResponse(500, { error: 'Server error' });
      }
      if (callCount === 2) {
        return jsonResponse(
          200,
          matrixFixture({
            rows: [],
            summary: { total: 0, pass: 0, fail: 0, deferred: 0, retired: 0 },
          }),
        );
      }
      return jsonResponse(200, matrixFixture());
    });

    const { unmount } = renderTab();

    const errorBanner = await screen.findByTestId('build-verification-error');
    expect(errorBanner).toHaveTextContent('We could not load the verification results.');

    await user.click(screen.getByTestId('build-verification-retry'));
    const emptyMsg = await screen.findByTestId('build-verification-empty');
    expect(emptyMsg).toHaveTextContent(
      'No verification results yet. Results appear when an agent finishes a task.',
    );
    unmount();

    // 2. Render with rows and open a 403 evidence link
    renderTab();
    const greenButton = await screen.findByTestId('build-verification-green-evidence-AC-2');
    await user.click(greenButton);

    const forbidden = await screen.findByTestId('build-evidence-forbidden');
    expect(forbidden).toHaveTextContent('You do not have access to this evidence.');
    expect(screen.queryByTestId('build-evidence-content')).not.toBeInTheDocument();
  });

  it('PBI-023 AC-0: loads evidence text into a scrollable pre when View is clicked', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/evidence/')) {
        return textResponse(200, 'PASS src/ac2.test.ts\n  ✓ AC-2: renders matrix');
      }
      return jsonResponse(200, matrixFixture());
    });

    renderTab();
    const greenButton = await screen.findByTestId('build-verification-green-evidence-AC-2');
    await user.click(greenButton);

    const pre = await screen.findByTestId('build-evidence-content');
    expect(pre.tagName).toBe('PRE');
    expect(pre).toHaveAttribute('tabindex', '0');
    expect(pre).toHaveTextContent('PASS src/ac2.test.ts');
  });
});
