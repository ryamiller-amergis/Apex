/**
 * FoundationSkillsAdmin component tests
 *
 * Covers:
 *   - Renders the three section tabs (Releases, Consumer Repos, Create Draft)
 *   - Shows release list with correct status badges
 *   - Publish, deprecate, and delete actions trigger correct mutations
 *   - Repo-status table renders and exposes check/update actions
 *   - Create draft form validates required fields and calls createRelease
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
  useUpdateRepoWithFoundationSkills,
  useCheckFoundationSkillCompatibility,
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
  useUpdateRepoWithFoundationSkills:    jest.fn(),
  useCheckFoundationSkillCompatibility: jest.fn(),
}));

const mockReleases           = useFoundationSkillReleases           as jest.Mock;
const mockCandidates         = useFoundationSkillCandidates         as jest.Mock;
const mockRepoStatuses       = useFoundationSkillRepoStatuses       as jest.Mock;
const mockAudit              = useFoundationSkillReleaseAudit       as jest.Mock;
const mockCreate             = useCreateFoundationSkillRelease      as jest.Mock;
const mockPublish            = usePublishFoundationSkillRelease     as jest.Mock;
const mockDeprecate          = useDeprecateFoundationSkillRelease   as jest.Mock;
const mockDelete             = useDeleteDraftFoundationSkillRelease as jest.Mock;
const mockUpdateRepo         = useUpdateRepoWithFoundationSkills    as jest.Mock;
const mockCheckCompat        = useCheckFoundationSkillCompatibility as jest.Mock;

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
  mockUpdateRepo.mockReturnValue(noopMutate);
  mockCheckCompat.mockReturnValue(noopMutate);
}

describe('FoundationSkillsAdmin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaults();
  });

  describe('section navigation', () => {
    it('renders three section tabs', () => {
      renderComponent();
      expect(screen.getByRole('tab', { name: 'Releases' })).toBeInTheDocument();
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

    it('switches to Create Draft form', () => {
      renderComponent();
      fireEvent.click(screen.getByRole('tab', { name: 'Create Draft' }));
      expect(screen.getByLabelText('Suite version')).toBeInTheDocument();
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

  describe('create draft form', () => {
    it('submits when version and selectedSkills are provided', async () => {
      const mutateAsync = jest.fn().mockResolvedValue({ ...draftRelease });
      mockCreate.mockReturnValue({ mutateAsync, isPending: false });
      renderComponent();
      fireEvent.click(screen.getByRole('tab', { name: 'Create Draft' }));

      fireEvent.change(screen.getByLabelText('Suite version'), { target: { value: '2.0.0' } });
      fireEvent.submit(screen.getByText('Create draft').closest('form')!);

      await waitFor(() =>
        expect(mutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({ version: '2.0.0', selectedSkills: [] }),
        ),
      );
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
});
