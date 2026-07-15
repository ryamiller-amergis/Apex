import { fireEvent, render, screen } from '@testing-library/react';
import { AdminGroups } from '../AdminGroups';
import {
  useCreateGroup,
  useDeleteGroup,
  useGroupWithMembers,
  useGroupsWithMembers,
  useSeedDefaultGroups,
  useSetGroupMembers,
  useUpdateGroup,
} from '../../hooks/useGroups';
import { useUsers } from '../../hooks/useRbac';

jest.mock('../../hooks/useGroups', () => ({
  useGroupsWithMembers: jest.fn(),
  useGroupWithMembers: jest.fn(),
  useCreateGroup: jest.fn(),
  useUpdateGroup: jest.fn(),
  useDeleteGroup: jest.fn(),
  useSetGroupMembers: jest.fn(),
  useSeedDefaultGroups: jest.fn(),
}));

jest.mock('../../hooks/useRbac', () => ({
  useUsers: jest.fn(),
}));

const group = {
  id: 'group-1',
  name: 'Developers',
  description: 'Project developers',
  project: 'Apex',
  isDefault: true,
  createdBy: null,
  createdAt: '2026-07-15T00:00:00Z',
  members: [],
};

const mutation = {
  mutate: jest.fn(),
  mutateAsync: jest.fn(),
  isPending: false,
  error: null,
};

describe('AdminGroups project-scoped member picker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useGroupsWithMembers as jest.Mock).mockReturnValue({ data: [group], isLoading: false });
    (useGroupWithMembers as jest.Mock).mockReturnValue({ data: group, isLoading: false });
    (useUsers as jest.Mock).mockReturnValue({ data: [], isLoading: false });
    (useCreateGroup as jest.Mock).mockReturnValue(mutation);
    (useUpdateGroup as jest.Mock).mockReturnValue(mutation);
    (useDeleteGroup as jest.Mock).mockReturnValue(mutation);
    (useSetGroupMembers as jest.Mock).mockReturnValue(mutation);
    (useSeedDefaultGroups as jest.Mock).mockReturnValue(mutation);
  });

  it('loads only users assigned to the active project when managing members', () => {
    render(<AdminGroups selectedProject="Apex" availableProjects={['Apex', 'MaxView']} />);

    fireEvent.click(screen.getByRole('button', { name: 'Members' }));

    expect(useUsers).toHaveBeenCalledWith('Apex');
  });

  it('uses the newly selected project for the member picker', () => {
    render(<AdminGroups selectedProject="Apex" availableProjects={['Apex', 'MaxView']} />);

    fireEvent.change(screen.getByLabelText('Select project'), { target: { value: 'MaxView' } });
    fireEvent.click(screen.getByRole('button', { name: 'Members' }));

    expect(useUsers).toHaveBeenCalledWith('MaxView');
  });
});
