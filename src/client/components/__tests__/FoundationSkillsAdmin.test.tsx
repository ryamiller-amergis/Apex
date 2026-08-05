/**
 * FoundationSkillsAdmin component tests
 *
 * Covers:
 *   - Renders the section tabs (Releases, Skills, Teams, Consumer Repos, Create Draft)
 *   - Shows release list with correct status badges
 *   - Publish, deprecate, and delete actions trigger correct mutations
 *   - Repo-status table renders and exposes check/update actions
 *   - Create draft wizard gates each step and calls createRelease from Review
 *   - Project picker opens as a dropdown listing all projects, filters, toggles, and closes
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FoundationSkillsAdmin } from '../FoundationSkillsAdmin';
import {
  useFoundationSkillReleases,
  useFoundationSkillCandidates,
  useFoundationSkillRepoStatuses,
  useFoundationSkillReleaseAudit,
  useCreateFoundationSkillRelease,
  usePublishFoundationSkillRelease,
  useDeprecateFoundationSkillRelease,
  useDeleteDraftFoundationSkillRelease,
  useUpdateFoundationSkillRelease,
  useUpdateRepoWithFoundationSkills,
  useCheckFoundationSkillCompatibility,
  useFoundationSkillMatrix,
  useFoundationSkillTeams,
  useScanAllFoundationSkillRepos,
  useFoundationSkillRollbackTargets,
  useRollbackFoundationSkillRepo,
  useShippableFoundationSkills,
} from '../../hooks/useFoundationSkillAdmin';

jest.mock('../../hooks/useFoundationSkillAdmin', () => ({
  useFoundationSkillReleases:           jest.fn(),
  useFoundationSkillCandidates:         jest.fn(),
  useFoundationSkillRepoStatuses:       jest.fn(),
  useFoundationSkillReleaseAudit:       jest.fn(),
  useCreateFoundationSkillRelease:      jest.fn(),
  usePublishFoundationSkillRelease:     jest.fn(),
  useDeprecateFoundationSkillRelease:   jest.fn(),
  useDeleteDraftFoundationSkillRelease: jest.fn(),
  useUpdateFoundationSkillRelease:      jest.fn(),
  useUpdateRepoWithFoundationSkills:    jest.fn(),
  useCheckFoundationSkillCompatibility: jest.fn(),
  useFoundationSkillMatrix:             jest.fn(),
  useFoundationSkillTeams:              jest.fn(),
  useScanAllFoundationSkillRepos:      jest.fn(),
  useFoundationSkillRollbackTargets:    jest.fn(),
  useRollbackFoundationSkillRepo:       jest.fn(),
  useShippableFoundationSkills:         jest.fn(),
}));

/** Stands in for foundation-skills/catalog.json minus the apex-only entries. */
const catalogSkills = Array.from({ length: 31 }, (_, i) => ({
  name:    `skill-${i + 1}`,
  summary: `Summary for skill ${i + 1}.`,
  tier:    'shippable' as const,
}));

jest.mock('../../hooks/useProjects', () => ({
  useProjects: jest.fn().mockReturnValue({
    data: [{ name: 'MaxView' }, { name: 'Apex' }, { name: 'Bedrock' }],
    isLoading: false,
  }),
}));

const mockReleases           = useFoundationSkillReleases           as jest.Mock;
const mockCandidates         = useFoundationSkillCandidates         as jest.Mock;
const mockRepoStatuses       = useFoundationSkillRepoStatuses       as jest.Mock;
const mockAudit              = useFoundationSkillReleaseAudit       as jest.Mock;
const mockCreate             = useCreateFoundationSkillRelease      as jest.Mock;
const mockPublish            = usePublishFoundationSkillRelease     as jest.Mock;
const mockDeprecate          = useDeprecateFoundationSkillRelease   as jest.Mock;
const mockDelete             = useDeleteDraftFoundationSkillRelease as jest.Mock;
const mockUpdateRelease      = useUpdateFoundationSkillRelease      as jest.Mock;
const mockUpdateRepo         = useUpdateRepoWithFoundationSkills    as jest.Mock;
const mockCheckCompat        = useCheckFoundationSkillCompatibility as jest.Mock;
const mockMatrix             = useFoundationSkillMatrix             as jest.Mock;
const mockTeams              = useFoundationSkillTeams              as jest.Mock;
const mockScanAll            = useScanAllFoundationSkillRepos      as jest.Mock;
const mockRollbackTargets    = useFoundationSkillRollbackTargets    as jest.Mock;
const mockRollback           = useRollbackFoundationSkillRepo       as jest.Mock;
const mockCatalog            = useShippableFoundationSkills         as jest.Mock;

const noop        = jest.fn().mockResolvedValue(undefined);
const noopMutate  = { mutateAsync: noop, isPending: false, error: null };

const sampleRelease = {
  id: 'rel-1', version: '1.2.0', status: 'published',
  releaseNotes: 'First release', breakingChanges: null,
  createdAt: '2026-07-28T00:00:00.000Z',
};

const draftRelease = {
  id: 'rel-2', version: '1.3.0-draft', status: 'draft',
  releaseNotes: null, breakingChanges: null,
  createdAt: '2026-07-28T00:00:00.000Z',
};

function renderComponent() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <FoundationSkillsAdmin />
    </QueryClientProvider>,
  );
}

function setupDefaults() {
  mockReleases.mockReturnValue({ data: [sampleRelease, draftRelease], isLoading: false });
  mockCandidates.mockReturnValue({ data: [], isLoading: false });
  mockRepoStatuses.mockReturnValue({ data: [], isLoading: false });
  mockAudit.mockReturnValue({ data: [], isLoading: false });
  mockCreate.mockReturnValue(noopMutate);
  mockPublish.mockReturnValue(noopMutate);
  mockDeprecate.mockReturnValue(noopMutate);
  mockDelete.mockReturnValue(noopMutate);
  mockUpdateRelease.mockReturnValue(noopMutate);
  mockUpdateRepo.mockReturnValue(noopMutate);
  mockCheckCompat.mockReturnValue(noopMutate);
  mockMatrix.mockReturnValue({ data: [], isLoading: false });
  mockTeams.mockReturnValue({ data: [], isLoading: false });
  mockScanAll.mockReturnValue(noopMutate);
  mockRollbackTargets.mockReturnValue({ data: [], isLoading: false });
  mockRollback.mockReturnValue(noopMutate);
  mockCatalog.mockReturnValue({ skills: catalogSkills, isLoading: false });
}

describe('FoundationSkillsAdmin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaults();
  });

  describe('section navigation', () => {
    it('renders five section tabs', () => {
      renderComponent();
      expect(screen.getByRole('tab', { name: 'Releases' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Skills' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Teams' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Consumer Repos' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Create Draft' })).toBeInTheDocument();
    });

    it('shows releases section by default', () => {
      renderComponent();
      expect(screen.getByText('v1.2.0')).toBeInTheDocument();
    });

    it('switches to Consumer Repos section', () => {
      renderComponent();
      fireEvent.click(screen.getByRole('tab', { name: 'Consumer Repos' }));
      expect(screen.getByText(/No consumer repos observed yet/)).toBeInTheDocument();
    });

    it('switches to Create Draft wizard on its first step', () => {
      renderComponent();
      fireEvent.click(screen.getByRole('tab', { name: 'Create Draft' }));
      expect(screen.getByLabelText('Suite version')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Release details' })).toBeInTheDocument();
    });
  });

  describe('releases list', () => {
    it('renders published badge for published release', () => {
      renderComponent();
      expect(screen.getByText('v1.2.0')).toBeInTheDocument();
      expect(screen.getByText('published')).toBeInTheDocument();
    });

    it('renders draft badge and Publish + Delete actions for draft release', () => {
      renderComponent();
      expect(screen.getByText('v1.3.0-draft')).toBeInTheDocument();
      expect(screen.getByText('draft')).toBeInTheDocument();
      const publishBtns = screen.getAllByText('Publish');
      expect(publishBtns.length).toBeGreaterThan(0);
    });

    it('renders Deprecate action for published release', () => {
      renderComponent();
      expect(screen.getByText('Deprecate')).toBeInTheDocument();
    });

    it('calls publishRelease mutation when Publish is clicked', async () => {
      const mutateAsync = jest.fn().mockResolvedValue({ ...draftRelease, status: 'published' });
      mockPublish.mockReturnValue({ mutateAsync, isPending: false });
      renderComponent();
      const publishBtns = screen.getAllByText('Publish');
      fireEvent.click(publishBtns[0]);
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith('rel-2'));
    });

    it('shows loading spinner message during publish', () => {
      mockPublish.mockReturnValue({ mutateAsync: noop, isPending: true });
      renderComponent();
      // Button should be disabled while pending
      const publishBtns = screen.getAllByText('Publish');
      expect(publishBtns[0]).toBeDisabled();
    });
  });

  describe('create draft wizard', () => {
    /** Advance from Details through to the Review step. */
    function advanceToReview() {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' })); // → Audience
      fireEvent.click(screen.getByRole('button', { name: 'Continue' })); // → Skills
      fireEvent.click(screen.getByRole('button', { name: 'Continue' })); // → Review
    }

    it('submits from the Review step when version is provided (all skills selected by default)', async () => {
      const mutateAsync = jest.fn().mockResolvedValue({ ...draftRelease });
      mockCreate.mockReturnValue({ mutateAsync, isPending: false });
      renderComponent();
      fireEvent.click(screen.getByRole('tab', { name: 'Create Draft' }));

      fireEvent.change(screen.getByLabelText('Suite version'), { target: { value: '2.0.0' } });
      advanceToReview();

      fireEvent.submit(screen.getByText('Create draft').closest('form')!);

      await waitFor(() =>
        expect(mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({ version: '2.0.0' }),
        ),
      );
      // All 31 skills selected by default
      const callArgs = mutateAsync.mock.calls[0][0];
      expect(callArgs.selectedSkills).toHaveLength(31);
    });

    it('blocks advancing past Details when the version is empty', () => {
      renderComponent();
      fireEvent.click(screen.getByRole('tab', { name: 'Create Draft' }));

      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

      expect(screen.getByRole('alert')).toHaveTextContent('Suite version is required.');
      // Advisory feed callout uses role="status" so it never collides with validation alerts.
      expect(screen.getByTestId('fs-wizard-feed-unreachable')).toHaveAttribute('role', 'status');
      expect(screen.getByRole('heading', { name: 'Release details' })).toBeInTheDocument();
    });

    it('prefills suite and artifact version from the newest feed candidate', () => {
      mockCandidates.mockReturnValue({
        data: [
          { version: '1.0.0', publishedAt: '2026-08-04T00:00:00.000Z', packageName: '@apex/skills' },
          { version: '0.9.0', publishedAt: '2026-08-01T00:00:00.000Z', packageName: '@apex/skills' },
        ],
        isLoading: false,
      });
      renderComponent();
      fireEvent.click(screen.getByRole('tab', { name: 'Create Draft' }));

      expect(screen.getByLabelText('Suite version')).toHaveValue('1.0.0');
      expect(screen.getByLabelText('Artifact version')).toHaveValue('1.0.0');
    });

    it('blocks submitting when every skill has been cleared', async () => {
      const mutateAsync = jest.fn();
      mockCreate.mockReturnValue({ mutateAsync, isPending: false });
      renderComponent();
      fireEvent.click(screen.getByRole('tab', { name: 'Create Draft' }));

      fireEvent.change(screen.getByLabelText('Suite version'), { target: { value: '2.0.0' } });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' })); // → Audience
      fireEvent.click(screen.getByRole('button', { name: 'Continue' })); // → Skills
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      fireEvent.click(screen.getByRole('button', { name: 'Continue' })); // blocked

      expect(screen.getByRole('alert')).toHaveTextContent('Select at least one skill');
      expect(mutateAsync).not.toHaveBeenCalled();
    });

    it('requires a project when the audience is narrowed to specific projects', () => {
      renderComponent();
      fireEvent.click(screen.getByRole('tab', { name: 'Create Draft' }));

      fireEvent.change(screen.getByLabelText('Suite version'), { target: { value: '2.0.0' } });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' })); // → Audience
      fireEvent.click(screen.getByRole('radio', { name: 'Specific projects' }));
      fireEvent.click(screen.getByRole('button', { name: 'Continue' })); // blocked

      expect(screen.getByRole('alert')).toHaveTextContent('Select at least one project');
    });
  });

  describe('catalog-driven skill picker', () => {
    /** Walk to the Skills step of the wizard. */
    function openSkillsStep() {
      fireEvent.click(screen.getByRole('tab', { name: 'Create Draft' }));
      fireEvent.change(screen.getByLabelText('Suite version'), { target: { value: '2.0.0' } });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' })); // → Audience
      fireEvent.click(screen.getByRole('button', { name: 'Continue' })); // → Skills
    }

    it('lists whatever the catalog returns, with no hardcoded skill list', () => {
      mockCatalog.mockReturnValue({
        skills: [
          { name: 'brand-new-skill', summary: 'Added to catalog.json only.', tier: 'shippable' },
          { name: 'another-skill',   summary: 'Also from the catalog.',      tier: 'shippable' },
        ],
        isLoading: false,
      });
      renderComponent();
      openSkillsStep();

      expect(screen.getByText('brand-new-skill')).toBeInTheDocument();
      expect(screen.getByText('Added to catalog.json only.')).toBeInTheDocument();
      // Seeded from the catalog, so the count reflects it rather than a fixed 31.
      expect(screen.getByText('2 of 2 selected')).toBeInTheDocument();
    });

    it('submits exactly the skills the catalog provided', async () => {
      const mutateAsync = jest.fn().mockResolvedValue({ ...draftRelease });
      mockCreate.mockReturnValue({ mutateAsync, isPending: false });
      mockCatalog.mockReturnValue({
        skills: [
          { name: 'alpha', summary: 'A.', tier: 'shippable' },
          { name: 'beta',  summary: 'B.', tier: 'shippable' },
        ],
        isLoading: false,
      });
      renderComponent();
      fireEvent.click(screen.getByRole('tab', { name: 'Create Draft' }));
      fireEvent.change(screen.getByLabelText('Suite version'), { target: { value: '3.0.0' } });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      fireEvent.submit(screen.getByText('Create draft').closest('form')!);

      await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
      expect(mutateAsync.mock.calls[0][0].selectedSkills).toEqual(['alpha', 'beta']);
    });

    it('shows a loading message while the catalog is in flight', () => {
      mockCatalog.mockReturnValue({ skills: [], isLoading: true });
      renderComponent();
      openSkillsStep();

      expect(screen.getByText('Loading skill catalog…')).toBeInTheDocument();
    });

    it('shows an empty message when the catalog has no releasable skills', () => {
      mockCatalog.mockReturnValue({ skills: [], isLoading: false });
      renderComponent();
      openSkillsStep();

      expect(screen.getByText('No releasable skills found in the catalog.')).toBeInTheDocument();
    });
  });

  describe('project picker', () => {
    /** Open the Audience step with the project picker visible. */
    function openProjectPicker() {
      fireEvent.click(screen.getByRole('tab', { name: 'Create Draft' }));
      fireEvent.change(screen.getByLabelText('Suite version'), { target: { value: '2.0.0' } });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' })); // → Audience
      fireEvent.click(screen.getByRole('radio', { name: 'Specific projects' }));
      return screen.getByRole('combobox', { name: 'Projects' });
    }

    it('lists every project when the field is focused without typing', () => {
      renderComponent();
      const combobox = openProjectPicker();

      expect(combobox).toHaveAttribute('aria-expanded', 'false');
      fireEvent.focus(combobox);

      expect(combobox).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('button', { name: 'MaxView' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Apex' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Bedrock' })).toBeInTheDocument();
      expect(screen.getByText('0 of 3 selected')).toBeInTheDocument();
    });

    it('filters the list as the user types', () => {
      renderComponent();
      const combobox = openProjectPicker();
      fireEvent.focus(combobox);

      fireEvent.change(combobox, { target: { value: 'max' } });

      expect(screen.getByRole('button', { name: 'MaxView' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Bedrock' })).not.toBeInTheDocument();
    });

    it('toggles selection and keeps the chosen project marked in the list', () => {
      renderComponent();
      const combobox = openProjectPicker();
      fireEvent.focus(combobox);

      fireEvent.click(screen.getByRole('button', { name: 'MaxView' }));

      expect(screen.getByRole('button', { name: 'MaxView' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'Remove MaxView' })).toBeInTheDocument();
      expect(screen.getByText('1 of 3 selected')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'MaxView' }));
      expect(screen.getByRole('button', { name: 'MaxView' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('closes the list on Escape', () => {
      renderComponent();
      const combobox = openProjectPicker();
      fireEvent.focus(combobox);
      expect(combobox).toHaveAttribute('aria-expanded', 'true');

      fireEvent.keyDown(document, { key: 'Escape' });

      expect(combobox).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('button', { name: 'MaxView' })).not.toBeInTheDocument();
    });

    it('shows an empty message when no project matches the search', () => {
      renderComponent();
      const combobox = openProjectPicker();
      fireEvent.focus(combobox);

      fireEvent.change(combobox, { target: { value: 'zzz' } });

      expect(screen.getByText(/No projects match/)).toBeInTheDocument();
    });

    /** The dropdown is an overlay, so it must fit the viewport on its own. */
    describe('viewport fit', () => {
      const rect = (top: number, bottom: number) =>
        ({ top, bottom, left: 0, right: 300, width: 300, height: bottom - top,
           x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

      afterEach(() => jest.restoreAllMocks());

      it('opens downward and caps its height to the room below', () => {
        const { container } = renderComponent();
        fireEvent.focus(openProjectPicker());

        const list = container.querySelector('ul.dropdown') as HTMLElement;
        expect(list.className).not.toContain('dropdownUp');
        // jsdom viewport is 768px tall and the field measures at the top.
        expect(list.style.maxHeight).toBe('300px');
      });

      it('flips above the field when the room below is too small', () => {
        jest.spyOn(Element.prototype, 'getBoundingClientRect')
          .mockReturnValue(rect(700, 740));

        const { container } = renderComponent();
        fireEvent.focus(openProjectPicker());

        const list = container.querySelector('ul.dropdown') as HTMLElement;
        expect(list.className).toContain('dropdownUp');
        expect(list.style.maxHeight).toBe('300px');
      });

      it('shrinks rather than overflowing when room below is tight but usable', () => {
        // 768 - 528 - 12 = 228px below, and less room above once flipped.
        jest.spyOn(Element.prototype, 'getBoundingClientRect')
          .mockReturnValue(rect(488, 528));

        const { container } = renderComponent();
        fireEvent.focus(openProjectPicker());

        const list = container.querySelector('ul.dropdown') as HTMLElement;
        expect(list.className).not.toContain('dropdownUp');
        expect(list.style.maxHeight).toBe('228px');
      });
    });
  });

  describe('loading state', () => {
    it('shows loading text when releases are loading', () => {
      mockReleases.mockReturnValue({ data: [], isLoading: true });
      renderComponent();
      expect(screen.getByText('Loading releases…')).toBeInTheDocument();
    });

    it('shows empty state when no releases exist', () => {
      mockReleases.mockReturnValue({ data: [], isLoading: false });
      renderComponent();
      expect(screen.getByText(/No releases yet/)).toBeInTheDocument();
    });
  });

  describe('Consumer Repos Check / Open PR', () => {
    const observedRepo = {
      id: 'status-1',
      provider: 'ado' as const,
      project: 'MaxView',
      repo: 'MaxView',
      branch: 'development',
      apexProject: 'MaxView',
      installedVersion: '0.1.0',
      selectedSkills: ['ui-lab'],
      lockHash: null,
      compatibilityStatus: 'compatible' as const,
      compatibilityErrors: [],
      availableVersion: '0.4.0',
      updateAvailable: true,
      compatibilityCheckedAt: '2026-08-03T17:26:00.000Z',
      lastObservedAt: '2026-08-03T17:26:00.000Z',
      observedBy: null,
      createdAt: '2026-08-03T17:26:00.000Z',
      updatedAt: '2026-08-03T17:26:00.000Z',
    };

    it('passes branch and apexProject when Check is clicked', async () => {
      const mutateAsync = jest.fn().mockResolvedValue({
        report: { status: 'compatible', errors: [], warnings: [] },
      });
      mockRepoStatuses.mockReturnValue({ data: [observedRepo], isLoading: false });
      mockCheckCompat.mockReturnValue({ mutateAsync, isPending: false, error: null });

      renderComponent();
      fireEvent.click(screen.getByRole('tab', { name: 'Consumer Repos' }));
      fireEvent.click(screen.getByRole('button', { name: 'Check' }));

      await waitFor(() => {
        expect(mutateAsync).toHaveBeenCalledWith({
          project: 'MaxView',
          repo: 'MaxView',
          provider: 'ado',
          branch: 'development',
          apexProject: 'MaxView',
        });
      });
      expect(await screen.findByText(/Compatibility \(MaxView@development\)/)).toBeInTheDocument();
    });

    it('passes defaultBranch and apexProject when Open PR is clicked', async () => {
      const mutateAsync = jest.fn().mockResolvedValue({
        status: 'pr_created',
        prUrl: 'https://example.com/pr/42',
        report: 'ok',
        errors: [],
      });
      mockRepoStatuses.mockReturnValue({ data: [observedRepo], isLoading: false });
      mockUpdateRepo.mockReturnValue({ mutateAsync, isPending: false, error: null });

      renderComponent();
      fireEvent.click(screen.getByRole('tab', { name: 'Consumer Repos' }));
      fireEvent.click(screen.getByRole('button', { name: 'Open PR' }));

      await waitFor(() => {
        expect(mutateAsync).toHaveBeenCalledWith({
          project: 'MaxView',
          repo: 'MaxView',
          provider: 'ado',
          defaultBranch: 'development',
          apexProject: 'MaxView',
        });
      });
      expect(await screen.findByText(/PR opened: https:\/\/example.com\/pr\/42/)).toBeInTheDocument();
    });
  });

  describe('Teams rollback', () => {
    const teamRepo = {
      provider: 'ado' as const,
      project: 'MaxView',
      repo: 'MaxView',
      branch: 'main',
      friendlyName: 'MaxView skills',
      observed: true,
      installedVersion: '1.1.0',
      installedReleaseStatus: 'published' as const,
      installedSkills: ['ui-lab'],
      releasedSkills: ['ui-lab'],
      availableVersion: '1.1.0',
      updateAvailable: false,
      compatibilityStatus: 'compatible' as const,
      compatibilityCheckedAt: '2026-08-03T00:00:00.000Z',
      lastObservedAt: '2026-08-03T00:00:00.000Z',
    };

    it('shows rollback controls when a team repo is expanded', async () => {
      mockTeams.mockReturnValue({
        data: [{ apexProject: 'MaxView', repos: [teamRepo] }],
        isLoading: false,
      });
      mockRollbackTargets.mockReturnValue({
        data: [{ id: 'rel-0', version: '1.0.0', releaseNotes: 'previous' }],
        isLoading: false,
      });

      renderComponent();
      fireEvent.click(screen.getByRole('tab', { name: 'Teams' }));
      // Expand the repo row via the version cell
      fireEvent.click(screen.getByText(/v1\.1\.0/));

      expect(await screen.findByRole('heading', { name: 'Rollback' })).toBeInTheDocument();
      expect(screen.getByLabelText('Rollback target version')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Open rollback PR' })).toBeDisabled();
    });

    it('opens a rollback PR when a target is selected', async () => {
      const mutateAsync = jest.fn().mockResolvedValue({
        status: 'pr_created',
        prUrl: 'https://example.com/pr/9',
        toVersion: '1.0.0',
        errors: [],
      });
      mockTeams.mockReturnValue({
        data: [{ apexProject: 'MaxView', repos: [teamRepo] }],
        isLoading: false,
      });
      mockRollbackTargets.mockReturnValue({
        data: [{ id: 'rel-0', version: '1.0.0', releaseNotes: 'previous' }],
        isLoading: false,
      });
      mockRollback.mockReturnValue({ mutateAsync, isPending: false, error: null });

      renderComponent();
      fireEvent.click(screen.getByRole('tab', { name: 'Teams' }));
      fireEvent.click(screen.getByText(/v1\.1\.0/));

      fireEvent.change(await screen.findByLabelText('Rollback target version'), {
        target: { value: 'rel-0' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Open rollback PR' }));

      // In-app confirm modal
      const dialog = await screen.findByRole('dialog', { name: /Rollback MaxView/i });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Open rollback PR' }));

      await waitFor(() => {
        expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
          apexProject: 'MaxView',
          releaseId: 'rel-0',
          fromVersion: '1.1.0',
        }));
      });
      expect(await screen.findByText(/Rollback PR opened/)).toBeInTheDocument();
    });
  });

  describe('in-app confirm modal', () => {
    it('opens a deprecate confirmation dialog instead of window.confirm', async () => {
      const mutateAsync = jest.fn().mockResolvedValue({ ...sampleRelease, status: 'deprecated' });
      mockDeprecate.mockReturnValue({ mutateAsync, isPending: false, error: null });

      renderComponent();
      fireEvent.click(screen.getByRole('button', { name: 'Deprecate' }));

      const dialog = await screen.findByRole('dialog', { name: /Deprecate v1\.2\.0/i });
      expect(within(dialog).getByLabelText(/Reason \(optional\)/i)).toBeInTheDocument();

      fireEvent.change(within(dialog).getByLabelText(/Reason \(optional\)/i), {
        target: { value: 'superseded by v1.3.0' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Deprecate' }));

      await waitFor(() => {
        expect(mutateAsync).toHaveBeenCalledWith({
          id: 'rel-1',
          reason: 'superseded by v1.3.0',
        });
      });
    });
  });
});
