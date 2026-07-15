import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminUsers } from '../AdminUsers';

// ── Mock the useRbac hooks ─────────────────────────────────────────────────────

jest.mock('../../hooks/useRbac', () => ({
  useUsers: jest.fn(),
  useRoles: jest.fn(),
  useAssignRole: jest.fn(),
  useRemoveRole: jest.fn(),
  useAssignProjectRole: jest.fn(),
  useRemoveProjectRole: jest.fn(),
}));

import {
  useUsers,
  useRoles,
  useAssignRole,
  useRemoveRole,
  useAssignProjectRole,
  useRemoveProjectRole,
} from '../../hooks/useRbac';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const adminRole = {
  id: 'role-admin',
  name: 'admin',
  description: null,
  isDefault: false,
  createdAt: '2026-01-01T00:00:00Z',
  permissions: [],
};

const memberRole = {
  id: 'role-member',
  name: 'member',
  description: null,
  isDefault: true,
  createdAt: '2026-01-01T00:00:00Z',
  permissions: [],
};

const alice = {
  oid: 'user-alice',
  displayName: 'Alice',
  email: 'alice@example.com',
  lastSeenAt: '2026-05-14T12:00:00Z',
  roles: ['admin'],
};

const bob = {
  oid: 'user-bob',
  displayName: 'Bob',
  email: 'bob@example.com',
  lastSeenAt: null,
  roles: [],
};

function setupDefaultMocks() {
  const mutate = jest.fn();
  const mutateAsync = jest.fn();
  const noop = { mutate, mutateAsync, isPending: false, error: null };

  (useUsers as jest.Mock).mockReturnValue({ data: [alice, bob], isLoading: false, error: null });
  (useRoles as jest.Mock).mockReturnValue({ data: [adminRole, memberRole], isLoading: false });
  (useAssignRole as jest.Mock).mockReturnValue(noop);
  (useRemoveRole as jest.Mock).mockReturnValue(noop);
  (useAssignProjectRole as jest.Mock).mockReturnValue(noop);
  (useRemoveProjectRole as jest.Mock).mockReturnValue(noop);

  return { mutate, mutateAsync };
}

// ── Rendering ──────────────────────────────────────────────────────────────────

describe('AdminUsers — rendering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  it('renders the page title', () => {
    render(<AdminUsers />);

    expect(screen.getByText('User Management')).toBeInTheDocument();
  });

  it('loads users for the selected project', () => {
    render(<AdminUsers selectedProject="Apex" />);

    expect(useUsers).toHaveBeenCalledWith('Apex');
  });

  it('renders a row for each user', () => {
    render(<AdminUsers />);

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('displays user email addresses', () => {
    render(<AdminUsers />);

    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
  });

  it('shows user count in the subtitle', () => {
    render(<AdminUsers />);

    expect(screen.getByText(/2 users/)).toBeInTheDocument();
  });

  it('shows an assigned role badge for Alice', () => {
    render(<AdminUsers />);

    // Alice has the 'admin' role
    expect(screen.getByText('admin', { selector: 'span' })).toBeInTheDocument();
  });

  it('shows "None" when a user has no assigned roles', () => {
    render(<AdminUsers />);

    // Bob has no roles
    expect(screen.getByText('None')).toBeInTheDocument();
  });

  it('shows a loading state when users are loading', () => {
    (useUsers as jest.Mock).mockReturnValue({ data: [], isLoading: true, error: null });
    (useRoles as jest.Mock).mockReturnValue({ data: [], isLoading: true });

    render(<AdminUsers />);

    expect(screen.getByText(/loading users/i)).toBeInTheDocument();
  });

  it('shows an error state when loading users fails', () => {
    (useUsers as jest.Mock).mockReturnValue({
      data: [],
      isLoading: false,
      error: new Error('Network error'),
    });

    render(<AdminUsers />);

    expect(screen.getByText(/failed to load users/i)).toBeInTheDocument();
  });
});

// ── Search / filter ────────────────────────────────────────────────────────────

describe('AdminUsers — search', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  it('filters users by display name', () => {
    render(<AdminUsers />);

    const searchInput = screen.getByPlaceholderText(/search by name or email/i);
    fireEvent.change(searchInput, { target: { value: 'alice' } });

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
  });

  it('filters users by email', () => {
    render(<AdminUsers />);

    const searchInput = screen.getByPlaceholderText(/search by name or email/i);
    fireEvent.change(searchInput, { target: { value: 'bob@example' } });

    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('shows empty state when no users match the search query', () => {
    render(<AdminUsers />);

    fireEvent.change(screen.getByPlaceholderText(/search by name or email/i), {
      target: { value: 'zzz-no-match' },
    });

    expect(screen.getByText(/no users match/i)).toBeInTheDocument();
  });

  it('clears the search when the × button is clicked', () => {
    render(<AdminUsers />);

    const searchInput = screen.getByPlaceholderText(/search by name or email/i);
    fireEvent.change(searchInput, { target: { value: 'alice' } });

    const clearBtn = screen.getByLabelText('Clear search');
    fireEvent.click(clearBtn);

    expect(searchInput).toHaveValue('');
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('does not render the clear button when the search box is empty', () => {
    render(<AdminUsers />);

    expect(screen.queryByLabelText('Clear search')).not.toBeInTheDocument();
  });

  it('is case-insensitive', () => {
    render(<AdminUsers />);

    fireEvent.change(screen.getByPlaceholderText(/search by name or email/i), {
      target: { value: 'ALICE' },
    });

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
  });
});

// ── Role assignment ────────────────────────────────────────────────────────────

describe('AdminUsers — role assignment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  it('renders a role dropdown for each user', () => {
    render(<AdminUsers />);

    // Bob has no roles so both admin and member should be available
    const bobRow = screen.getByText('Bob').closest('tr')!;
    const bobSelect = bobRow.querySelector('select')!;
    expect(bobSelect).toBeInTheDocument();
  });

  it('excludes already-assigned roles from the dropdown', () => {
    render(<AdminUsers />);

    // Alice already has 'admin' — it should not appear in her dropdown options
    const aliceRow = screen.getByText('Alice').closest('tr')!;
    const aliceSelect = aliceRow.querySelector('select')!;
    const optionTexts = Array.from(aliceSelect.querySelectorAll('option')).map((o) => o.textContent);
    expect(optionTexts).not.toContain('admin');
    expect(optionTexts).toContain('member');
  });

  it('shows "All roles assigned" when the user already has all roles', () => {
    (useUsers as jest.Mock).mockReturnValue({
      data: [{ ...alice, roles: ['admin', 'member'] }],
      isLoading: false,
      error: null,
    });

    render(<AdminUsers />);

    expect(screen.getByText('All roles assigned')).toBeInTheDocument();
  });

  it('calls assignRole.mutate when Assign is clicked with a selected role', async () => {
    const { mutate } = setupDefaultMocks();

    render(<AdminUsers />);

    // Select the 'member' role for Bob (Bob has no roles, so 'member' is available)
    const bobRow = screen.getByText('Bob').closest('tr')!;
    const bobSelect = bobRow.querySelector('select')!;
    fireEvent.change(bobSelect, { target: { value: 'role-member' } });

    const assignBtn = bobRow.querySelector('button[aria-label*="Assign"]') as HTMLButtonElement;
    fireEvent.click(assignBtn);

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({ oid: 'user-bob', roleId: 'role-member' }),
        expect.any(Object),
      );
    });
  });

  it('keeps the Assign button disabled until a role is selected', () => {
    render(<AdminUsers />);

    // Bob's row — no role selected yet
    const bobRow = screen.getByText('Bob').closest('tr')!;
    const assignBtn = bobRow.querySelector('button[aria-label*="Assign"]') as HTMLButtonElement;
    expect(assignBtn).toBeDisabled();
  });
});

// ── Role removal ───────────────────────────────────────────────────────────────

describe('AdminUsers — role removal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  it('renders a remove (×) button for each assigned role', () => {
    render(<AdminUsers />);

    // Alice has 'admin' — should have a Remove button
    const removeBtn = screen.getByLabelText(/remove role admin from alice/i);
    expect(removeBtn).toBeInTheDocument();
  });

  it('calls removeRole.mutate with the correct oid and roleId', async () => {
    const { mutate } = setupDefaultMocks();

    render(<AdminUsers />);

    const removeBtn = screen.getByLabelText(/remove role admin from alice/i);
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({ oid: 'user-alice', roleId: 'role-admin' }),
      );
    });
  });
});

// ── Avatar / display helpers ───────────────────────────────────────────────────

describe('AdminUsers — avatar initials', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  it('shows the first character of the display name as the avatar', () => {
    render(<AdminUsers />);

    // Alice → 'A', Bob → 'B'
    const avatars = screen.getAllByRole('row').slice(1).map((row) => {
      const avatarEl = row.querySelector('[aria-hidden="true"]');
      return avatarEl?.textContent;
    });
    expect(avatars).toContain('A');
    expect(avatars).toContain('B');
  });

  it('uses the email initial when display name is null', () => {
    (useUsers as jest.Mock).mockReturnValue({
      data: [{ oid: 'u-email', displayName: null, email: 'frank@test.com', lastSeenAt: null, roles: [] }],
      isLoading: false,
      error: null,
    });

    render(<AdminUsers />);

    // 'frank@test.com' → initial 'F'
    expect(screen.getByText('F', { selector: '[aria-hidden="true"]' })).toBeInTheDocument();
  });
});

// ── Project roles ───────────────────────────────────────────────────────────

describe('AdminUsers — project roles', () => {
  const aliceWithProjectRoles = {
    ...alice,
    projectRoles: ['member'],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  it('does not show a project roles section when no project is selected', () => {
    (useUsers as jest.Mock).mockReturnValue({
      data: [aliceWithProjectRoles],
      isLoading: false,
      error: null,
    });

    render(<AdminUsers selectedProject="" />);

    expect(screen.queryByText(/project roles/i)).not.toBeInTheDocument();
  });

  it('shows a project roles section when a project is selected', () => {
    (useUsers as jest.Mock).mockReturnValue({
      data: [aliceWithProjectRoles],
      isLoading: false,
      error: null,
    });

    render(<AdminUsers selectedProject="Apex" />);

    expect(screen.getByText(/project roles.*apex/i)).toBeInTheDocument();
  });

  it('renders project role badges for a user who has project roles', () => {
    (useUsers as jest.Mock).mockReturnValue({
      data: [aliceWithProjectRoles],
      isLoading: false,
      error: null,
    });

    render(<AdminUsers selectedProject="Apex" />);

    const aliceRow = screen.getByText('Alice').closest('tr')!;
    const projectSection = aliceRow.querySelector('[data-testid="project-roles-user-alice"]')!;
    expect(projectSection).toBeInTheDocument();
    expect(projectSection.textContent).toContain('member');
  });

  it('shows "None" in the project roles section when user has no project roles', () => {
    (useUsers as jest.Mock).mockReturnValue({
      data: [{ ...alice, projectRoles: [] }],
      isLoading: false,
      error: null,
    });

    render(<AdminUsers selectedProject="Apex" />);

    const aliceRow = screen.getByText('Alice').closest('tr')!;
    const projectSection = aliceRow.querySelector('[data-testid="project-roles-user-alice"]')!;
    expect(projectSection.textContent).toContain('None');
  });

  it('calls useAssignProjectRole when assigning a project role', async () => {
    const projectAssignMutate = jest.fn();
    (useAssignProjectRole as jest.Mock).mockReturnValue({
      mutate: projectAssignMutate,
      isPending: false,
      error: null,
    });
    (useUsers as jest.Mock).mockReturnValue({
      data: [{ ...alice, projectRoles: [] }],
      isLoading: false,
      error: null,
    });

    render(<AdminUsers selectedProject="Apex" />);

    const select = screen.getByLabelText(/select project role to assign to alice/i);
    fireEvent.change(select, { target: { value: 'role-member' } });

    const assignBtn = screen.getByLabelText(/assign project role to alice/i);
    fireEvent.click(assignBtn);

    await waitFor(() => {
      expect(projectAssignMutate).toHaveBeenCalledWith(
        expect.objectContaining({ oid: 'user-alice', project: 'Apex', roleId: 'role-member' }),
        expect.any(Object),
      );
    });
  });

  it('calls useRemoveProjectRole when removing a project role', async () => {
    const projectRemoveMutate = jest.fn();
    (useRemoveProjectRole as jest.Mock).mockReturnValue({
      mutate: projectRemoveMutate,
      isPending: false,
      error: null,
    });
    (useUsers as jest.Mock).mockReturnValue({
      data: [aliceWithProjectRoles],
      isLoading: false,
      error: null,
    });

    render(<AdminUsers selectedProject="Apex" />);

    const removeBtn = screen.getByLabelText(/remove project role member from alice/i);
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(projectRemoveMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          oid: 'user-alice',
          project: 'Apex',
          roleId: 'role-member',
        }),
      );
    });
  });

  it('excludes already-assigned project roles from the project role dropdown', () => {
    (useUsers as jest.Mock).mockReturnValue({
      data: [aliceWithProjectRoles],
      isLoading: false,
      error: null,
    });

    render(<AdminUsers selectedProject="Apex" />);

    const select = screen.getByLabelText(/select project role to assign to alice/i);
    const optionTexts = Array.from(select.querySelectorAll('option')).map(o => o.textContent);
    expect(optionTexts).not.toContain('member');
    expect(optionTexts).toContain('admin');
  });
});
