import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BuildAllowlistPanel } from '../BuildAllowlistPanel';
import {
  useAddBuildAllowlistEntry,
  useBuildAllowlist,
  useBuildAllowlistRepositories,
  usePlatformAdminProjects,
  useRemoveBuildAllowlistEntry,
} from '../../hooks/usePlatformAdmin';

jest.mock('../../hooks/usePlatformAdmin', () => ({
  useBuildAllowlist: jest.fn(),
  useBuildAllowlistRepositories: jest.fn(),
  useAddBuildAllowlistEntry: jest.fn(),
  useRemoveBuildAllowlistEntry: jest.fn(),
  usePlatformAdminProjects: jest.fn(),
}));

const mockList = useBuildAllowlist as jest.Mock;
const mockRepos = useBuildAllowlistRepositories as jest.Mock;
const mockAdd = useAddBuildAllowlistEntry as jest.Mock;
const mockRemove = useRemoveBuildAllowlistEntry as jest.Mock;
const mockProjects = usePlatformAdminProjects as jest.Mock;

const entry = {
  id: 'row-1',
  project: 'Apex',
  repository: 'Apex',
  createdBy: 'Ada',
  createdAt: '2026-10-23T12:00:00.000Z',
};

function mutation(overrides: Record<string, unknown> = {}) {
  return { mutateAsync: jest.fn().mockResolvedValue(undefined), isPending: false, error: null, ...overrides };
}

function listResult(data: unknown[] | undefined, overrides: Record<string, unknown> = {}) {
  return { data, isLoading: false, isError: false, error: null, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockProjects.mockReturnValue({ data: [{ id: 'p1', name: 'Apex' }, { id: 'p2', name: 'Empty' }], isLoading: false });
  mockRepos.mockImplementation((project: string | null) => {
    if (project === 'Apex') return listResult(['Apex', 'org/web']);
    if (project === 'Empty') return listResult([]);
    return listResult(undefined);
  });
  mockAdd.mockReturnValue(mutation());
  mockRemove.mockReturnValue(mutation());
});

describe('BuildAllowlistPanel (VT-17)', () => {
  it('shows the loading text', () => {
    mockList.mockReturnValue(listResult(undefined, { isLoading: true }));
    render(<BuildAllowlistPanel />);
    expect(screen.getByText('Loading approved repositories…')).toBeInTheDocument();
  });

  it('shows the empty text when nothing is approved', () => {
    mockList.mockReturnValue(listResult([]));
    render(<BuildAllowlistPanel />);
    expect(screen.getByText('No repositories are approved for builds yet.')).toBeInTheDocument();
  });

  it('lists approved pairs with labelled remove buttons', () => {
    mockList.mockReturnValue(listResult([entry]));
    render(<BuildAllowlistPanel />);
    const list = screen.getByRole('list', { name: 'Approved repositories for builds' });
    expect(list).toBeInTheDocument();
    expect(screen.getByTestId('platform-admin-build-allowlist-row-row-1')).toHaveTextContent('Apex / Apex');
    expect(screen.getByRole('button', { name: 'Remove Apex / Apex from approved builds' })).toBeInTheDocument();
  });

  it('PBI-002 AC-0: keeps the repository select disabled until a project is chosen, then adds the pair', async () => {
    mockList.mockReturnValue(listResult([]));
    const add = mutation({ mutateAsync: jest.fn().mockResolvedValue({ ...entry, repository: 'org/web' }) });
    mockAdd.mockReturnValue(add);
    render(<BuildAllowlistPanel />);

    const repo = screen.getByLabelText('Repository');
    expect(repo).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'Apex' } });
    await waitFor(() => expect(screen.getByLabelText('Repository')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'org/web' } });

    await act(async () => {
      fireEvent.submit(screen.getByTestId('platform-admin-build-allowlist-form'));
    });

    expect(add.mutateAsync).toHaveBeenCalledWith({ project: 'Apex', repository: 'org/web' });
    expect(screen.getByRole('status')).toHaveTextContent('Added Apex / org/web');
  });

  it('tells the admin when the project has no repository configured', async () => {
    mockList.mockReturnValue(listResult([]));
    render(<BuildAllowlistPanel />);
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'Empty' } });
    expect(
      await screen.findByText('This project has no repository configured. Add one in Project Settings first.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Repository')).toBeDisabled();
  });

  it('PBI-002 AC-1: shows the server message in an alert', () => {
    mockList.mockReturnValue(listResult([]));
    mockAdd.mockReturnValue(mutation({ error: new Error('That repository is not configured for this project.') }));
    render(<BuildAllowlistPanel />);
    expect(screen.getByRole('alert')).toHaveTextContent('That repository is not configured for this project.');
  });

  it('does not submit without a project and repository', async () => {
    mockList.mockReturnValue(listResult([]));
    const add = mutation();
    mockAdd.mockReturnValue(add);
    render(<BuildAllowlistPanel />);
    await act(async () => {
      fireEvent.submit(screen.getByTestId('platform-admin-build-allowlist-form'));
    });
    expect(add.mutateAsync).not.toHaveBeenCalled();
  });

  it('PBI-002 AC-2: Remove opens the confirmation and then calls DELETE', async () => {
    mockList.mockReturnValue(listResult([entry]));
    const remove = mutation();
    mockRemove.mockReturnValue(remove);
    render(<BuildAllowlistPanel />);

    fireEvent.click(screen.getByTestId('platform-admin-build-allowlist-remove-row-1'));
    const modal = screen.getByTestId('platform-admin-build-allowlist-delete-modal');
    expect(modal).toHaveTextContent(
      'New builds in this repository will not start, and builds already running will stop at their next step.',
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-delete-confirm-btn'));
    });
    expect(remove.mutateAsync).toHaveBeenCalledWith({ id: 'row-1' });
  });
});
