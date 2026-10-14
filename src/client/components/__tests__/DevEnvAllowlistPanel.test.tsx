import { render, screen } from '@testing-library/react';
import { DevEnvAllowlistPanel } from '../DevEnvAllowlistPanel';
import {
  useAddDevEnvAllowlistEntry,
  useDevEnvAllowlist,
  useRemoveDevEnvAllowlistEntry,
} from '../../hooks/usePlatformAdmin';

jest.mock('../../hooks/usePlatformAdmin', () => ({
  useDevEnvAllowlist: jest.fn(),
  useAddDevEnvAllowlistEntry: jest.fn(),
  useRemoveDevEnvAllowlistEntry: jest.fn(),
}));

const mockUseDevEnvAllowlist = useDevEnvAllowlist as jest.Mock;
const mockUseAdd = useAddDevEnvAllowlistEntry as jest.Mock;
const mockUseRemove = useRemoveDevEnvAllowlistEntry as jest.Mock;

function idleMutation() {
  return { mutateAsync: jest.fn(), isPending: false, error: null };
}

describe('DevEnvAllowlistPanel', () => {
  beforeEach(() => {
    mockUseAdd.mockReturnValue(idleMutation());
    mockUseRemove.mockReturnValue(idleMutation());
  });

  it('lets a platform admin add an email on the dev site', () => {
    mockUseDevEnvAllowlist.mockReturnValue({
      data: {
        environment: 'dev',
        managesDevAccess: true,
        entries: [{
          id: 'row-1',
          email: 'person@example.com',
          createdBy: 'Ada',
          createdAt: '2026-09-28T12:00:00.000Z',
        }],
      },
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<DevEnvAllowlistPanel />);

    expect(screen.getByRole('heading', { name: 'Dev access' })).toBeInTheDocument();
    expect(screen.getByText('person@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to dev access' })).toBeEnabled();
    expect(screen.queryByText(/Open Platform Admin there/i)).not.toBeInTheDocument();
  });

  it('does not allow changes when this site is not the dev site', () => {
    mockUseDevEnvAllowlist.mockReturnValue({
      data: { environment: 'prod', managesDevAccess: false, entries: [] },
      isLoading: false,
      isError: false,
      error: null,
    });

    render(<DevEnvAllowlistPanel />);

    expect(screen.getByText(/Open Platform Admin there/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to dev access' })).toBeDisabled();
  });
});
