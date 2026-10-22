import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlaybookEditPage } from '../PlaybookEditPage';

const mockCan = jest.fn();
const mockUseDefinition = jest.fn();

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({ can: mockCan }),
}));

jest.mock('../../hooks/usePlaybookDefinitions', () => ({
  usePlaybookDefinition: (...args: unknown[]) => mockUseDefinition(...args),
}));

jest.mock('../PlaybookDraftEditor', () => ({
  PlaybookDraftEditor: () => <div data-testid="draft-editor">Draft editor</div>,
}));

jest.mock('../PlaybookVersionList', () => ({
  PlaybookVersionList: () => <div data-testid="version-list">Versions</div>,
}));

const detail = {
  definition: {
    id: 'def-1',
    name: 'Release checks',
    description: 'Checks a release',
  },
  draft: {
    id: 'draft-1',
    definitionId: 'def-1',
    nextVersionNumber: 1,
    graph: { nodes: [], edges: [] },
    updatedAt: '2026-10-19T00:00:00.000Z',
  },
  versions: [],
  currentPublishedVersionId: null,
};

function renderPage(canAuthor: boolean) {
  mockCan.mockImplementation((permission: string) =>
    canAuthor && permission === 'playbooks:author'
  );
  mockUseDefinition.mockReturnValue({
    data: detail,
    isPending: false,
    isError: false,
    refetch: jest.fn(),
  });
  return render(
    <MemoryRouter initialEntries={['/playbooks/def-1/edit']}>
      <Routes>
        <Route
          path="/playbooks/:definitionId/edit"
          element={<PlaybookEditPage project="Apex" definitionId="def-1" />}
        />
        <Route path="/playbooks/:definitionId" element={<p>Dashboard</p>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

it('shows details, versions, advanced draft editing, and the graph-builder link to authors', () => {
  renderPage(true);

  expect(screen.getByTestId('playbook-edit-page')).toBeInTheDocument();
  expect(screen.getByTestId('draft-editor')).toBeInTheDocument();
  expect(screen.getByTestId('version-list')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open graph builder' })).toHaveAttribute(
    'href',
    '/playbooks/definitions/def-1'
  );
});

it('redirects viewers to the non-mutating dashboard', () => {
  renderPage(false);

  expect(screen.getByText('Dashboard')).toBeInTheDocument();
  expect(screen.queryByTestId('draft-editor')).not.toBeInTheDocument();
});
