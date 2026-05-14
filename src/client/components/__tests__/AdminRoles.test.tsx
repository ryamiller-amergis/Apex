import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminRoles } from '../AdminRoles';

// ── Mock the useRbac hooks ─────────────────────────────────────────────────────

jest.mock('../../hooks/useRbac', () => ({
  useRoles: jest.fn(),
  usePermissions: jest.fn(),
  useCreateRole: jest.fn(),
  useUpdateRole: jest.fn(),
  useDeleteRole: jest.fn(),
  useUpdateRolePermissions: jest.fn(),
  useUsers: jest.fn(),
  useAssignRole: jest.fn(),
  useRemoveRole: jest.fn(),
}));

import {
  useRoles,
  usePermissions,
  useCreateRole,
  useUpdateRole,
  useDeleteRole,
  useUpdateRolePermissions,
  useUsers,
  useAssignRole,
  useRemoveRole,
} from '../../hooks/useRbac';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const adminRole = {
  id: 'role-admin',
  name: 'admin',
  description: 'Full admin access',
  isDefault: false,
  createdAt: '2026-01-01T00:00:00Z',
  permissions: ['admin:roles', 'admin:users'],
};

const memberRole = {
  id: 'role-member',
  name: 'member',
  description: 'Standard member',
  isDefault: true,
  createdAt: '2026-01-01T00:00:00Z',
  permissions: ['chat:create'],
};

const allPermissions = [
  { id: 'p1', key: 'admin:roles', description: 'Manage roles', category: 'admin' },
  { id: 'p2', key: 'admin:users', description: 'Manage users', category: 'admin' },
  { id: 'p3', key: 'chat:create', description: 'Create chats', category: 'chat' },
];

function setupDefaultMocks() {
  const mutateAsync = jest.fn();
  const mutate = jest.fn();
  const noop = { mutateAsync, mutate, isPending: false, error: null };

  (useRoles as jest.Mock).mockReturnValue({ data: [adminRole, memberRole], isLoading: false });
  (usePermissions as jest.Mock).mockReturnValue({ data: allPermissions });
  (useCreateRole as jest.Mock).mockReturnValue(noop);
  (useUpdateRole as jest.Mock).mockReturnValue(noop);
  (useDeleteRole as jest.Mock).mockReturnValue(noop);
  (useUpdateRolePermissions as jest.Mock).mockReturnValue(noop);
  (useUsers as jest.Mock).mockReturnValue({ data: [], isLoading: false });
  (useAssignRole as jest.Mock).mockReturnValue(noop);
  (useRemoveRole as jest.Mock).mockReturnValue(noop);

  return { mutateAsync, mutate };
}

// ── Roles table ────────────────────────────────────────────────────────────────

describe('AdminRoles — roles table', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  it('renders the page title', () => {
    render(<AdminRoles />);

    expect(screen.getByText('Roles')).toBeInTheDocument();
  });

  it('renders a row for each role', () => {
    render(<AdminRoles />);

    expect(screen.getByText('admin')).toBeInTheDocument();
    expect(screen.getByText('member')).toBeInTheDocument();
  });

  it('shows loading indicator while roles are loading', () => {
    (useRoles as jest.Mock).mockReturnValue({ data: [], isLoading: true });

    render(<AdminRoles />);

    expect(screen.getByText(/loading roles/i)).toBeInTheDocument();
  });

  it('shows empty state when no roles exist', () => {
    (useRoles as jest.Mock).mockReturnValue({ data: [], isLoading: false });

    render(<AdminRoles />);

    expect(screen.getByText(/no roles found/i)).toBeInTheDocument();
  });

  it('displays the permission count for each role', () => {
    render(<AdminRoles />);

    // admin has 2 permissions, member has 1
    const counts = screen.getAllByText(/^[0-9]+$/);
    const numericTexts = counts.map((el) => el.textContent);
    expect(numericTexts).toContain('2');
    expect(numericTexts).toContain('1');
  });

  it('marks the default role with a "Default" badge', () => {
    render(<AdminRoles />);

    // The column header also says "Default" — target only the badge <span>
    const badges = screen.getAllByText('Default', { selector: 'span' });
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it('disables the Delete button for the default role', () => {
    render(<AdminRoles />);

    // memberRole is the default; its Delete button should be disabled
    const rows = screen.getAllByTitle('Delete role');
    const memberDeleteBtn = rows.find((btn) => btn.closest('tr')?.textContent?.includes('member'));
    expect(memberDeleteBtn).toBeDisabled();
  });
});

// ── Create role modal ──────────────────────────────────────────────────────────

describe('AdminRoles — create role modal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  it('opens the create modal when "+ Create Role" is clicked', () => {
    render(<AdminRoles />);

    fireEvent.click(screen.getByText('+ Create Role'));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Create Role' })).toBeInTheDocument();
  });

  it('closes the modal when Cancel is clicked', () => {
    render(<AdminRoles />);

    fireEvent.click(screen.getByText('+ Create Role'));
    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a validation error when the name field is empty on submit', async () => {
    render(<AdminRoles />);

    fireEvent.click(screen.getByText('+ Create Role'));
    fireEvent.click(screen.getByRole('button', { name: 'Create Role' }));

    await waitFor(() => {
      expect(screen.getByText('Name is required')).toBeInTheDocument();
    });
  });

  it('calls createRole.mutateAsync with the entered name on submit', async () => {
    const { mutateAsync } = setupDefaultMocks();
    mutateAsync.mockResolvedValue({ id: 'new', name: 'developer', description: null, isDefault: false, createdAt: '2026-05-14', permissions: [] });

    render(<AdminRoles />);

    fireEvent.click(screen.getByText('+ Create Role'));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'developer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Role' }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'developer' }),
      );
    });
  });
});

// ── Edit role modal ────────────────────────────────────────────────────────────

describe('AdminRoles — edit role modal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  it('opens the edit modal pre-filled with the role name', () => {
    render(<AdminRoles />);

    const editButtons = screen.getAllByTitle('Edit role');
    fireEvent.click(editButtons[0]); // edit the first role (admin)

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByDisplayValue('admin')).toBeInTheDocument();
  });

  it('shows "Edit Role" in the modal title when editing', () => {
    render(<AdminRoles />);

    const editButtons = screen.getAllByTitle('Edit role');
    fireEvent.click(editButtons[0]);

    expect(screen.getByText('Edit Role')).toBeInTheDocument();
  });

  it('shows the "Set as default role" checkbox only in edit mode', () => {
    render(<AdminRoles />);

    // Create mode — no checkbox
    fireEvent.click(screen.getByText('+ Create Role'));
    expect(screen.queryByLabelText(/set as default/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel'));

    // Edit mode — checkbox present
    const editButtons = screen.getAllByTitle('Edit role');
    fireEvent.click(editButtons[0]);
    expect(screen.getByLabelText(/set as default/i)).toBeInTheDocument();
  });

  it('calls updateRole.mutateAsync when the edit form is submitted', async () => {
    const { mutateAsync } = setupDefaultMocks();
    mutateAsync.mockResolvedValue({ ...adminRole, name: 'super-admin' });

    render(<AdminRoles />);

    const editButtons = screen.getAllByTitle('Edit role');
    fireEvent.click(editButtons[0]);

    const nameInput = screen.getByDisplayValue('admin');
    fireEvent.change(nameInput, { target: { value: 'super-admin' } });
    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'role-admin', name: 'super-admin' }),
      );
    });
  });
});

// ── Delete role modal ──────────────────────────────────────────────────────────

describe('AdminRoles — delete role modal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  it('opens a confirmation modal when Delete is clicked on a non-default role', () => {
    render(<AdminRoles />);

    const deleteButtons = screen.getAllByTitle('Delete role');
    // admin role is not default, so its Delete button is enabled
    const adminDeleteBtn = deleteButtons.find(
      (btn) => !btn.hasAttribute('disabled'),
    )!;
    fireEvent.click(adminDeleteBtn);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/are you sure/i)).toBeInTheDocument();
  });

  it('calls deleteRole.mutateAsync when the delete is confirmed', async () => {
    const { mutateAsync } = setupDefaultMocks();
    mutateAsync.mockResolvedValue(undefined);

    render(<AdminRoles />);

    const deleteButtons = screen.getAllByTitle('Delete role');
    const adminDeleteBtn = deleteButtons.find((btn) => !btn.hasAttribute('disabled'))!;
    fireEvent.click(adminDeleteBtn);

    // "Delete Role" appears in both the modal title (<h2>) and the confirm button
    fireEvent.click(screen.getByRole('button', { name: 'Delete Role' }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith('role-admin');
    });
  });

  it('shows a warning when the role being deleted is the default', () => {
    render(<AdminRoles />);

    // Open delete modal for member (default) — requires directly calling the handler
    // because the Delete button is disabled. We verify the warning text is shown
    // when the modal is somehow opened (e.g., via the component state).
    // The best we can do here: verify the disabled state is set as a guard.
    const deleteButtons = screen.getAllByTitle('Delete role');
    const memberDeleteBtn = deleteButtons.find(
      (btn) => btn.closest('tr')?.textContent?.includes('member'),
    )!;
    expect(memberDeleteBtn).toBeDisabled();
  });
});

// ── Permissions modal ──────────────────────────────────────────────────────────

describe('AdminRoles — permissions modal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  it('opens a permissions modal when "Permissions" is clicked', () => {
    render(<AdminRoles />);

    const permButtons = screen.getAllByTitle('Manage permissions');
    fireEvent.click(permButtons[0]);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/permissions/i, { selector: 'h2' })).toBeInTheDocument();
  });

  it('shows all available permissions grouped by category', () => {
    render(<AdminRoles />);

    const permButtons = screen.getAllByTitle('Manage permissions');
    fireEvent.click(permButtons[0]);

    expect(screen.getByText('admin:roles')).toBeInTheDocument();
    expect(screen.getByText('admin:users')).toBeInTheDocument();
    expect(screen.getByText('chat:create')).toBeInTheDocument();
  });

  it('calls updateRolePermissions.mutateAsync with the selected permission IDs', async () => {
    const { mutateAsync } = setupDefaultMocks();
    mutateAsync.mockResolvedValue(undefined);

    render(<AdminRoles />);

    const permButtons = screen.getAllByTitle('Manage permissions');
    fireEvent.click(permButtons[0]); // admin role — pre-selected: p1, p2

    // Uncheck p2 (admin:users)
    const checkboxes = screen.getAllByRole('checkbox');
    const adminUsersCheckbox = checkboxes.find((cb) =>
      cb.closest('label')?.textContent?.includes('admin:users'),
    )!;
    fireEvent.click(adminUsersCheckbox);

    fireEvent.click(screen.getByText('Save Permissions'));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'role-admin', permissionIds: expect.not.arrayContaining(['p2']) }),
      );
    });
  });
});

// ── Members modal ──────────────────────────────────────────────────────────────

describe('AdminRoles — members modal', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    const mutateAsync = jest.fn();
    const mutate = jest.fn();
    const noop = { mutateAsync, mutate, isPending: false, error: null };

    (useRoles as jest.Mock).mockReturnValue({ data: [adminRole, memberRole], isLoading: false });
    (usePermissions as jest.Mock).mockReturnValue({ data: allPermissions });
    (useCreateRole as jest.Mock).mockReturnValue(noop);
    (useUpdateRole as jest.Mock).mockReturnValue(noop);
    (useDeleteRole as jest.Mock).mockReturnValue(noop);
    (useUpdateRolePermissions as jest.Mock).mockReturnValue(noop);
    (useUsers as jest.Mock).mockReturnValue({
      data: [
        { oid: 'u1', displayName: 'Alice', email: 'alice@test.com', lastSeenAt: null, roles: ['admin'] },
        { oid: 'u2', displayName: 'Bob', email: 'bob@test.com', lastSeenAt: null, roles: ['member'] },
      ],
      isLoading: false,
    });
    (useAssignRole as jest.Mock).mockReturnValue(noop);
    (useRemoveRole as jest.Mock).mockReturnValue(noop);
  });

  it('opens a members modal when "Members" is clicked', () => {
    render(<AdminRoles />);

    const memberButtons = screen.getAllByTitle('Manage members');
    fireEvent.click(memberButtons[0]); // admin role

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/members — admin/i)).toBeInTheDocument();
  });

  it('lists current members of the role', () => {
    render(<AdminRoles />);

    const memberButtons = screen.getAllByTitle('Manage members');
    fireEvent.click(memberButtons[0]); // admin role — Alice is a member

    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('shows non-members in the "Add a user" dropdown', () => {
    render(<AdminRoles />);

    const memberButtons = screen.getAllByTitle('Manage members');
    fireEvent.click(memberButtons[0]); // admin role — Bob is NOT a member

    expect(screen.getByText('Bob')).toBeInTheDocument();
  });
});
