/**
 * Unit tests for CreateAdoItemsModal
 *
 * Covers:
 *  - Rendering: icons, badges, locked vs enabled vs in-ADO states
 *  - Design doc ↔ feature matching: exact, contains, case-insensitive, scorecard
 *  - Checkbox behaviour: epic auto-selects only enabled children; unchecking cascades
 *  - Pending-features banner visibility
 *  - Summary bar: PBI vs TBI counted separately
 *  - Submit: correct payload sent, button disabled states
 *  - Cancel: button, overlay click, Escape key
 */

import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { CreateAdoItemsModal } from '../CreateAdoItemsModal';
import type {
  Prd,
  DesignDocSummary,
  CreatePrdAdoItemsRequest,
} from '../../../shared/types/interview';

/* ── Module mocks ─────────────────────────────────────────────────────────── */

jest.mock('../../hooks/useProjects', () => ({
  useProjectAreaPaths: jest.fn(() => ({
    data: ['MyProject\\Team A', 'MyProject\\Team B'],
    isLoading: false,
    isError: false,
  })),
}));

/* ── Fixture helpers ──────────────────────────────────────────────────────── */

function makePrd(backlogJson: unknown): Prd {
  return {
    id: 'prd-1',
    interviewId: 'int-1',
    chatThreadId: 'thread-1',
    authorId: 'user-1',
    project: 'MyProject',
    title: 'My PRD',
    status: 'approved',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    content: '# PRD Content',
    backlogJson,
  };
}

function makeDesignDoc(overrides: Partial<DesignDocSummary> = {}): DesignDocSummary {
  return {
    id: 'doc-1',
    prdId: 'prd-1',
    project: 'MyProject',
    chatThreadId: null,
    authorId: 'user-1',
    title: 'Feature Auth',
    status: 'approved',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

/**
 * Two-epic backlog.
 * Epic 0 → Feature Auth (PBI + TBI), Feature Reports (PBI only)
 * Epic 1 → Feature Notifications (PBI only)
 */
const BACKLOG = {
  epics: [
    {
      title: 'Epic One',
      priority: 'Must Have',
      features: [
        {
          title: 'Feature Auth',
          priority: 'Must Have',
          items: [
            { type: 'PBI' as const, id: 'pbi-1', title: 'Login form' },
            { type: 'TBI' as const, id: 'tbi-1', title: 'OAuth wiring' },
          ],
        },
        {
          title: 'Feature Reports',
          priority: 'Should Have',
          items: [
            { type: 'PBI' as const, id: 'pbi-2', title: 'Dashboard charts' },
          ],
        },
      ],
    },
    {
      title: 'Epic Two',
      priority: 'Could Have',
      features: [
        {
          title: 'Feature Notifications',
          items: [
            { type: 'PBI' as const, id: 'pbi-3', title: 'Email alerts' },
          ],
        },
      ],
    },
  ],
};

/** Backlog where the epic and one feature are already in ADO. */
const BACKLOG_PARTIAL_ADO = {
  epics: [
    {
      title: 'Epic ADO',
      adoWorkItemId: 100,
      adoWorkItemUrl: 'https://dev.azure.com/epic/100',
      features: [
        {
          title: 'Feature Done',
          adoWorkItemId: 200,
          adoWorkItemUrl: 'https://dev.azure.com/feat/200',
          items: [
            { type: 'PBI' as const, id: 'pbi-a', title: 'Task done', adoWorkItemId: 300, adoWorkItemUrl: 'https://dev.azure.com/pbi/300' },
          ],
        },
        {
          title: 'Feature New',
          items: [
            { type: 'PBI' as const, id: 'pbi-b', title: 'Task new' },
          ],
        },
      ],
    },
  ],
};

/* ── Render helper ────────────────────────────────────────────────────────── */

interface RenderOptions {
  backlogJson?: unknown;
  designDocs?: DesignDocSummary[];
  isPending?: boolean;
  onSubmit?: jest.Mock;
  onCancel?: jest.Mock;
}

function renderModal(opts: RenderOptions = {}) {
  const {
    backlogJson = BACKLOG,
    designDocs = [makeDesignDoc()],
    isPending = false,
    onSubmit = jest.fn().mockResolvedValue(undefined),
    onCancel = jest.fn(),
  } = opts;

  render(
    <CreateAdoItemsModal
      prd={makePrd(backlogJson)}
      isPending={isPending}
      designDocs={designDocs}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />,
  );

  return { onSubmit, onCancel };
}

/**
 * Finds the .tree-node row that contains `labelText`, then returns the
 * checkbox inside it.  Using `.tree-node` works because identity-obj-proxy
 * returns CSS-module keys verbatim as the class string.
 */
function getRowCheckbox(labelText: string): HTMLInputElement {
  const label = screen.getByText(labelText);
  const row = label.closest('.tree-node');
  if (!row) throw new Error(`Could not find .tree-node ancestor for "${labelText}"`);
  return within(row as HTMLElement).getByRole('checkbox') as HTMLInputElement;
}

/** Returns the textContent of the summary bar (data-testid="summary-bar"). */
function summaryText(): string {
  return screen.getByTestId('summary-bar').textContent ?? '';
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/* Rendering                                                                  */
/* ═══════════════════════════════════════════════════════════════════════════ */

describe('CreateAdoItemsModal – rendering', () => {
  it('renders the dialog and header', () => {
    renderModal();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Create Work Items in ADO')).toBeInTheDocument();
  });

  it('shows the project name', () => {
    renderModal();
    expect(screen.getByText('MyProject')).toBeInTheDocument();
  });

  it('renders an area-path <select> with options from the hook', () => {
    renderModal();
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
    expect(within(select).getByText('MyProject\\Team A')).toBeInTheDocument();
    expect(within(select).getByText('MyProject\\Team B')).toBeInTheDocument();
  });

  it('renders both epics', () => {
    renderModal();
    expect(screen.getByText('Epic One')).toBeInTheDocument();
    expect(screen.getByText('Epic Two')).toBeInTheDocument();
  });

  it('renders epic rows with 👑 icon', () => {
    renderModal();
    const crowns = screen.getAllByText('👑');
    expect(crowns.length).toBeGreaterThanOrEqual(2);
  });

  it('renders feature rows with ⭐ icon', () => {
    renderModal();
    expect(screen.getByText('Feature Auth')).toBeInTheDocument();
    const stars = screen.getAllByText('⭐');
    expect(stars.length).toBeGreaterThanOrEqual(3);
  });

  it('renders PBI rows with 📋 icon and TBI rows with 🔧 icon', () => {
    renderModal();
    expect(screen.getByText('Login form')).toBeInTheDocument();
    expect(screen.getByText('OAuth wiring')).toBeInTheDocument();
    expect(screen.getAllByText('📋').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('🔧').length).toBeGreaterThanOrEqual(1);
  });

  it('shows PBI and TBI type badges', () => {
    renderModal();
    expect(screen.getAllByText('PBI').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('TBI').length).toBeGreaterThanOrEqual(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════ */
/* Design doc matching — enabled vs locked features                           */
/* ═══════════════════════════════════════════════════════════════════════════ */

describe('CreateAdoItemsModal – design doc matching', () => {
  it('enables a feature whose title exactly matches the approved design doc', () => {
    renderModal({
      designDocs: [makeDesignDoc({ title: 'Feature Auth', status: 'approved' })],
    });
    expect(getRowCheckbox('Feature Auth')).not.toBeDisabled();
  });

  it('enables a feature via contains match (shorter doc title inside feature title)', () => {
    // "Auth" is a substring of "Feature Auth"
    renderModal({
      designDocs: [makeDesignDoc({ title: 'Auth', status: 'approved' })],
    });
    expect(getRowCheckbox('Feature Auth')).not.toBeDisabled();
  });

  it('matches case-insensitively', () => {
    renderModal({
      designDocs: [makeDesignDoc({ title: 'FEATURE AUTH', status: 'approved' })],
    });
    expect(getRowCheckbox('Feature Auth')).not.toBeDisabled();
  });

  it('matches via validationScorecard.features[].feature_title', () => {
    const docWithScorecard = makeDesignDoc({
      title: 'Unrelated Doc Title',
      status: 'approved',
      validationScorecard: {
        slug: 'auth',
        generated_at: '2026-01-01T00:00:00Z',
        review_phase: 'final',
        overall_score: 90,
        ready_threshold: 80,
        is_ready: true,
        verdict: 'ready',
        features: [
          {
            feature_slug: 'feature-auth',
            feature_title: 'Feature Auth',
            design_score: 90,
            tech_spec_score: 88,
            assumptions_score: 85,
            overall_score: 88,
            verdict: 'ready',
            gaps: [],
          },
        ],
        cross_cutting_checks: {},
        accepted_gaps: [],
        deferred_gaps: [],
      },
    });
    renderModal({ designDocs: [docWithScorecard] });
    expect(getRowCheckbox('Feature Auth')).not.toBeDisabled();
  });

  it('locks a feature with no matching approved design doc (multi-doc scenario)', () => {
    // Two approved docs — only Feature Auth matches; Feature Reports stays locked.
    renderModal({
      designDocs: [
        makeDesignDoc({ id: 'doc-1', title: 'Feature Auth', status: 'approved' }),
        makeDesignDoc({ id: 'doc-2', title: 'Unmatched Doc', status: 'approved' }),
      ],
    });
    expect(getRowCheckbox('Feature Reports')).toBeDisabled();
  });

  it('with a single total design doc (approved) all features are unlocked', () => {
    // PRD has exactly ONE doc total → holistic single-doc pattern → all features unlocked.
    renderModal({
      designDocs: [makeDesignDoc({ title: 'Any Doc Title', status: 'approved' })],
    });
    expect(getRowCheckbox('Feature Auth')).not.toBeDisabled();
    expect(getRowCheckbox('Feature Reports')).not.toBeDisabled();
    expect(getRowCheckbox('Feature Notifications')).not.toBeDisabled();
  });

  it('with multiple total docs only one approved still locks unmatched features', () => {
    // PRD has 2 docs total; only Feature Auth doc is approved.
    // Feature Reports has a doc but it is pending_review → stays locked.
    renderModal({
      designDocs: [
        makeDesignDoc({ id: 'doc-1', title: 'Feature Auth', status: 'approved' }),
        makeDesignDoc({ id: 'doc-2', title: 'Feature Reports', status: 'pending_review' }),
      ],
    });
    expect(getRowCheckbox('Feature Auth')).not.toBeDisabled();
    expect(getRowCheckbox('Feature Reports')).toBeDisabled();
  });

  it('locks a feature whose design doc is pending_review (not approved)', () => {
    renderModal({
      designDocs: [makeDesignDoc({ title: 'Feature Auth', status: 'pending_review' })],
    });
    expect(getRowCheckbox('Feature Auth')).toBeDisabled();
  });

  it('shows "Design doc pending" badge on a locked feature (multi-doc scenario)', () => {
    renderModal({
      designDocs: [
        makeDesignDoc({ id: 'doc-1', title: 'Feature Auth', status: 'approved' }),
        makeDesignDoc({ id: 'doc-2', title: 'Unmatched Doc', status: 'approved' }),
      ],
    });
    expect(screen.getAllByText('Design doc pending').length).toBeGreaterThanOrEqual(1);
  });

  it('shows "✓ Design Doc" links on all features when there is a single approved doc', () => {
    // Single approved doc → every feature gets a link to that doc
    renderModal({
      designDocs: [makeDesignDoc({ id: 'doc-42', title: 'Feature Auth', status: 'approved' })],
    });
    const links = screen.getAllByText('✓ Design Doc');
    expect(links.length).toBeGreaterThanOrEqual(1);
    links.forEach(link => {
      expect(link).toHaveAttribute('href', '/backlog/design-doc/doc-42');
      expect(link).toHaveAttribute('target', '_blank');
    });
  });

  it('does not show the design doc link on locked features (multi-doc scenario)', () => {
    renderModal({
      designDocs: [
        makeDesignDoc({ id: 'doc-1', title: 'Feature Auth', status: 'approved' }),
        makeDesignDoc({ id: 'doc-2', title: 'Unmatched Doc', status: 'approved' }),
      ],
    });
    // Only Feature Auth is matched; Feature Reports and Feature Notifications are locked
    const links = screen.getAllByText('✓ Design Doc');
    expect(links).toHaveLength(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════ */
/* Pending-features banner                                                    */
/* ═══════════════════════════════════════════════════════════════════════════ */

describe('CreateAdoItemsModal – pending banner', () => {
  it('shows the banner when some features have no approved design doc (multi-doc scenario)', () => {
    renderModal({
      designDocs: [
        makeDesignDoc({ id: 'doc-1', title: 'Feature Auth', status: 'approved' }),
        makeDesignDoc({ id: 'doc-2', title: 'Unmatched Doc', status: 'approved' }),
      ],
    });
    expect(screen.getByText(/locked/i)).toBeInTheDocument();
  });

  it('hides the banner when all features have approved design docs', () => {
    renderModal({
      designDocs: [
        makeDesignDoc({ id: 'doc-1', title: 'Feature Auth', status: 'approved' }),
        makeDesignDoc({ id: 'doc-2', title: 'Feature Reports', status: 'approved' }),
        makeDesignDoc({ id: 'doc-3', title: 'Feature Notifications', status: 'approved' }),
      ],
    });
    expect(screen.queryByText(/locked/i)).not.toBeInTheDocument();
  });

  it('shows the correct count of locked features (multi-doc scenario)', () => {
    // Two approved docs, only Feature Auth matches → Feature Reports + Feature Notifications locked → 2
    renderModal({
      designDocs: [
        makeDesignDoc({ id: 'doc-1', title: 'Feature Auth', status: 'approved' }),
        makeDesignDoc({ id: 'doc-2', title: 'Unmatched Doc', status: 'approved' }),
      ],
    });
    expect(screen.getByText(/2 features/i)).toBeInTheDocument();
  });

  it('uses singular when exactly one feature is locked', () => {
    // Only one backlog with one feature that has no approved doc
    const singleFeatureBacklog = {
      epics: [{ title: 'E', features: [{ title: 'Only Feature', items: [] }] }],
    };
    renderModal({ backlogJson: singleFeatureBacklog, designDocs: [] });
    expect(screen.getByText(/1 feature\b/i)).toBeInTheDocument();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════ */
/* Items already in ADO                                                       */
/* ═══════════════════════════════════════════════════════════════════════════ */

describe('CreateAdoItemsModal – items already in ADO', () => {
  it('shows "In ADO" badge and disables the epic already in ADO', () => {
    renderModal({
      backlogJson: BACKLOG_PARTIAL_ADO,
      designDocs: [makeDesignDoc({ title: 'Feature New', status: 'approved' })],
    });
    expect(getRowCheckbox('Epic ADO')).toBeDisabled();
    expect(screen.getAllByText('In ADO').length).toBeGreaterThanOrEqual(1);
  });

  it('disables the feature already in ADO while its sibling remains enabled', () => {
    renderModal({
      backlogJson: BACKLOG_PARTIAL_ADO,
      designDocs: [makeDesignDoc({ title: 'Feature New', status: 'approved' })],
    });
    expect(getRowCheckbox('Feature Done')).toBeDisabled();
    expect(getRowCheckbox('Feature New')).not.toBeDisabled();
  });

  it('disables PBI already in ADO', () => {
    renderModal({
      backlogJson: BACKLOG_PARTIAL_ADO,
      designDocs: [makeDesignDoc({ title: 'Feature New', status: 'approved' })],
    });
    expect(getRowCheckbox('Task done')).toBeDisabled();
  });

  it('shows View link for items already in ADO', () => {
    renderModal({
      backlogJson: BACKLOG_PARTIAL_ADO,
      designDocs: [],
    });
    const viewLinks = screen.getAllByText('View');
    expect(viewLinks.length).toBeGreaterThanOrEqual(1);
    expect(viewLinks[0]).toHaveAttribute('href', expect.stringContaining('dev.azure.com'));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════ */
/* Checkbox cascade behaviour                                                 */
/* ═══════════════════════════════════════════════════════════════════════════ */

describe('CreateAdoItemsModal – checkbox cascade', () => {
  it('checking the epic auto-checks enabled features and their PBIs/TBIs', () => {
    renderModal({
      designDocs: [makeDesignDoc({ title: 'Feature Auth', status: 'approved' })],
    });
    fireEvent.click(getRowCheckbox('Epic One'));

    expect(getRowCheckbox('Feature Auth')).toBeChecked();
    expect(getRowCheckbox('Login form')).toBeChecked();
    expect(getRowCheckbox('OAuth wiring')).toBeChecked();
  });

  it('checking the epic does NOT auto-check locked features or their items (multi-doc scenario)', () => {
    renderModal({
      designDocs: [
        makeDesignDoc({ id: 'doc-1', title: 'Feature Auth', status: 'approved' }),
        makeDesignDoc({ id: 'doc-2', title: 'Unmatched Doc', status: 'approved' }),
      ],
    });
    fireEvent.click(getRowCheckbox('Epic One'));

    const reportsCb = getRowCheckbox('Feature Reports');
    expect(reportsCb).toBeDisabled();
    expect(reportsCb).not.toBeChecked();

    const chartsCb = getRowCheckbox('Dashboard charts');
    expect(chartsCb).toBeDisabled();
    expect(chartsCb).not.toBeChecked();
  });

  it('unchecking the epic deselects all previously-selected children', () => {
    renderModal({
      designDocs: [makeDesignDoc({ title: 'Feature Auth', status: 'approved' })],
    });
    fireEvent.click(getRowCheckbox('Epic One')); // check
    fireEvent.click(getRowCheckbox('Epic One')); // uncheck

    expect(getRowCheckbox('Feature Auth')).not.toBeChecked();
    expect(getRowCheckbox('Login form')).not.toBeChecked();
    expect(getRowCheckbox('OAuth wiring')).not.toBeChecked();
  });

  it('checking a feature auto-checks its non-ADO children', () => {
    renderModal({
      designDocs: [makeDesignDoc({ title: 'Feature Auth', status: 'approved' })],
    });
    fireEvent.click(getRowCheckbox('Feature Auth'));

    expect(getRowCheckbox('Login form')).toBeChecked();
    expect(getRowCheckbox('OAuth wiring')).toBeChecked();
  });

  it('unchecking a feature deselects its children', () => {
    renderModal({
      designDocs: [makeDesignDoc({ title: 'Feature Auth', status: 'approved' })],
    });
    fireEvent.click(getRowCheckbox('Feature Auth'));
    fireEvent.click(getRowCheckbox('Feature Auth'));

    expect(getRowCheckbox('Login form')).not.toBeChecked();
    expect(getRowCheckbox('OAuth wiring')).not.toBeChecked();
  });

  it('PBIs under a locked feature are disabled and start unchecked (multi-doc scenario)', () => {
    renderModal({
      designDocs: [
        makeDesignDoc({ id: 'doc-1', title: 'Feature Auth', status: 'approved' }),
        makeDesignDoc({ id: 'doc-2', title: 'Unmatched Doc', status: 'approved' }),
      ],
    });
    // Dashboard charts belongs to locked Feature Reports → must be disabled + unchecked
    const pbiCb = getRowCheckbox('Dashboard charts');
    expect(pbiCb).toBeDisabled();
    expect(pbiCb).not.toBeChecked();
  });

  it('individual PBI can be deselected after epic cascade-check', () => {
    renderModal({
      designDocs: [makeDesignDoc({ title: 'Feature Auth', status: 'approved' })],
    });
    fireEvent.click(getRowCheckbox('Epic One'));
    fireEvent.click(getRowCheckbox('Login form')); // deselect one

    expect(getRowCheckbox('Login form')).not.toBeChecked();
    expect(getRowCheckbox('OAuth wiring')).toBeChecked(); // sibling stays checked
  });
});

/* ═══════════════════════════════════════════════════════════════════════════ */
/* Summary bar                                                                */
/* ═══════════════════════════════════════════════════════════════════════════ */

describe('CreateAdoItemsModal – summary bar', () => {
  it('starts at 0 for all types', () => {
    renderModal();
    const text = summaryText();
    expect(text).toMatch(/0.*Epic/i);
    expect(text).toMatch(/0.*Feature/i);
    expect(text).toMatch(/0.*PBI/i);
  });

  it('updates counts after checking the epic (multi-doc: only Feature Auth enabled)', () => {
    renderModal({
      designDocs: [
        makeDesignDoc({ id: 'doc-1', title: 'Feature Auth', status: 'approved' }),
        makeDesignDoc({ id: 'doc-2', title: 'Unmatched Doc', status: 'approved' }),
      ],
    });
    fireEvent.click(getRowCheckbox('Epic One'));

    const text = summaryText();
    // 1 epic, 1 feature (Feature Auth), 1 PBI, 1 TBI
    expect(text).toMatch(/1.*Epic/i);
    expect(text).toMatch(/1.*Feature/i);
    expect(text).toMatch(/1.*PBI/i);
    expect(text).toMatch(/1.*TBI/i);
  });

  it('updates counts after checking the epic (single-doc: all features enabled)', () => {
    renderModal({
      designDocs: [makeDesignDoc({ title: 'Single Doc', status: 'approved' })],
    });
    fireEvent.click(getRowCheckbox('Epic One'));

    const text = summaryText();
    // 1 epic, 2 features (Auth + Reports), 2 PBIs, 1 TBI
    expect(text).toMatch(/1.*Epic/i);
    expect(text).toMatch(/2.*Features/i);
    expect(text).toMatch(/2.*PBIs/i);
    expect(text).toMatch(/1.*TBI/i);
  });

  it('does not show TBI count when no TBIs are selected', () => {
    // Feature Reports has only a PBI (no TBI)
    renderModal({
      designDocs: [makeDesignDoc({ title: 'Feature Reports', status: 'approved' })],
    });
    fireEvent.click(getRowCheckbox('Feature Reports'));

    expect(summaryText()).not.toMatch(/TBI/i);
  });

  it('uses plural label for multiple epics selected', () => {
    renderModal({
      designDocs: [
        makeDesignDoc({ id: 'doc-1', title: 'Feature Auth', status: 'approved' }),
        makeDesignDoc({ id: 'doc-3', title: 'Feature Notifications', status: 'approved' }),
      ],
    });
    fireEvent.click(getRowCheckbox('Epic One'));
    fireEvent.click(getRowCheckbox('Epic Two'));

    expect(summaryText()).toMatch(/2.*Epics/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════ */
/* Submit                                                                     */
/* ═══════════════════════════════════════════════════════════════════════════ */

describe('CreateAdoItemsModal – submit', () => {
  it('submit button is disabled when nothing is selected', () => {
    renderModal();
    expect(screen.getByRole('button', { name: 'Create in ADO' })).toBeDisabled();
  });

  it('shows "Creating..." and disables the button while isPending=true', () => {
    renderModal({ isPending: true });
    const btn = screen.getByRole('button', { name: /creating/i });
    expect(btn).toBeDisabled();
  });

  it('submit button becomes enabled after selecting an item', () => {
    renderModal({
      designDocs: [makeDesignDoc({ title: 'Feature Auth', status: 'approved' })],
    });
    fireEvent.click(getRowCheckbox('Feature Auth'));
    expect(screen.getByRole('button', { name: 'Create in ADO' })).not.toBeDisabled();
  });

  it('calls onSubmit with the correct structure on submit', () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    renderModal({
      designDocs: [makeDesignDoc({ title: 'Feature Auth', status: 'approved' })],
      onSubmit,
    });

    fireEvent.click(getRowCheckbox('Feature Auth'));
    fireEvent.click(screen.getByRole('button', { name: 'Create in ADO' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const req: CreatePrdAdoItemsRequest = onSubmit.mock.calls[0][0];
    expect(req.project).toBe('MyProject');
    expect(req.selectedItems.epics).toHaveLength(1);
    expect(req.selectedItems.epics[0].title).toBe('Epic One');
    const features = req.selectedItems.epics[0].features ?? [];
    expect(features).toHaveLength(1);
    expect(features[0].title).toBe('Feature Auth');
    expect(features[0].items).toHaveLength(2); // PBI + TBI
  });

  it('does NOT include locked features in the submit payload (multi-doc scenario)', () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    renderModal({
      designDocs: [
        makeDesignDoc({ id: 'doc-1', title: 'Feature Auth', status: 'approved' }),
        makeDesignDoc({ id: 'doc-2', title: 'Unmatched Doc', status: 'approved' }),
      ],
      onSubmit,
    });

    fireEvent.click(getRowCheckbox('Epic One')); // cascades only to enabled features
    fireEvent.click(screen.getByRole('button', { name: 'Create in ADO' }));

    const req: CreatePrdAdoItemsRequest = onSubmit.mock.calls[0][0];
    const featureTitles = req.selectedItems.epics[0].features?.map(f => f.title) ?? [];
    expect(featureTitles).toContain('Feature Auth');
    expect(featureTitles).not.toContain('Feature Reports');
  });

  it('uses the selected area path in the payload', () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    renderModal({
      designDocs: [makeDesignDoc({ title: 'Feature Auth', status: 'approved' })],
      onSubmit,
    });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'MyProject\\Team B' } });
    fireEvent.click(getRowCheckbox('Feature Auth'));
    fireEvent.click(screen.getByRole('button', { name: 'Create in ADO' }));

    const req: CreatePrdAdoItemsRequest = onSubmit.mock.calls[0][0];
    expect(req.areaPath).toBe('MyProject\\Team B');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════ */
/* Cancel / close                                                             */
/* ═══════════════════════════════════════════════════════════════════════════ */

describe('CreateAdoItemsModal – cancel / close', () => {
  it('calls onCancel when the Cancel button is clicked', () => {
    const { onCancel } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when the × close button is clicked', () => {
    const { onCancel } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when the overlay backdrop is clicked', () => {
    const { onCancel } = renderModal();
    // The overlay is the dialog element itself — clicking it (not the panel inside)
    const overlay = screen.getByRole('dialog');
    fireEvent.click(overlay);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when the Escape key is pressed', () => {
    const { onCancel } = renderModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onCancel when clicking inside the panel content', () => {
    const { onCancel } = renderModal();
    fireEvent.click(screen.getByText('Create Work Items in ADO'));
    expect(onCancel).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════ */
/* Collapse / expand                                                          */
/* ═══════════════════════════════════════════════════════════════════════════ */

describe('CreateAdoItemsModal – collapse / expand', () => {
  it('renders feature rows visible by default', () => {
    renderModal();
    expect(screen.getByText('Feature Auth')).toBeInTheDocument();
    expect(screen.getByText('Feature Reports')).toBeInTheDocument();
  });

  it('adds the collapsed CSS class to the children wrapper when toggled', () => {
    renderModal();
    // The Epic One row has a collapse/expand button
    const collapseButtons = screen.getAllByRole('button', { name: /expand|collapse/i });
    fireEvent.click(collapseButtons[0]); // collapse Epic One

    // The children container should now carry the collapsed class
    // identity-obj-proxy returns class names verbatim, so we can query by class
    const childrenDivs = document.querySelectorAll('.children');
    const collapsedDivs = document.querySelectorAll('.children-collapsed');
    expect(childrenDivs.length).toBeGreaterThanOrEqual(1);
    expect(collapsedDivs.length).toBeGreaterThanOrEqual(1);
  });

  it('removes the collapsed class after clicking the button again', () => {
    renderModal();
    const collapseButtons = screen.getAllByRole('button', { name: /expand|collapse/i });
    fireEvent.click(collapseButtons[0]); // collapse
    fireEvent.click(collapseButtons[0]); // expand

    const collapsedDivs = document.querySelectorAll('.children-collapsed');
    expect(collapsedDivs.length).toBe(0);
  });
});
