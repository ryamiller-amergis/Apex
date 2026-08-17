/**
 * ApiKeysAdminView — PBI-001 grid, search/filter, RBAC gate
 */
import { render, screen } from '@testing-library/react';
import type { ApiKeyMetadata } from '../../../shared/types/apiKey';
import { ApiKeysAdminView } from '../ApiKeysAdminView';

const mockCan = jest.fn((key: string) => key === 'api-keys:manage');

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({ can: mockCan }),
}));

const mockUseApiKeys = jest.fn();
const mockUseCreateApiKey = jest.fn();
const mockUseUpdateApiKey = jest.fn();
const mockUseRegenerateApiKey = jest.fn();
const mockUseDeleteApiKey = jest.fn();

jest.mock('../../hooks/useApiKeys', () => ({
  useApiKeys: (...args: unknown[]) => mockUseApiKeys(...args),
  useCreateApiKey: (...args: unknown[]) => mockUseCreateApiKey(...args),
  useUpdateApiKey: (...args: unknown[]) => mockUseUpdateApiKey(...args),
  useRegenerateApiKey: (...args: unknown[]) => mockUseRegenerateApiKey(...args),
  useDeleteApiKey: (...args: unknown[]) => mockUseDeleteApiKey(...args),
  ApiKeyApiError: class ApiKeyApiError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
      super(message);
      this.name = 'ApiKeyApiError';
      this.status = status;
      this.code = code;
    }
  },
}));

const sampleKey: ApiKeyMetadata = {
  id: 'key-1',
  shortId: 'abc12345',
  name: 'CI Pipeline',
  maskedPrefix: 'apex_x7k…',
  cadence: '90d',
  scopes: ['feature-requests:view'],
  expiresAt: '2026-11-11T00:00:00.000Z',
  status: 'active',
  createdAt: '2026-08-11T00:00:00.000Z',
  createdBy: 'alice@example.com',
};

function mutationStub() {
  return {
    mutate: jest.fn(),
    mutateAsync: jest.fn(),
    isPending: false,
    error: null,
  };
}

function setupHooks(items: ApiKeyMetadata[] = []) {
  mockUseApiKeys.mockReturnValue({
    data: items,
    isLoading: false,
    isError: false,
    error: null,
  });
  mockUseCreateApiKey.mockReturnValue(mutationStub());
  mockUseUpdateApiKey.mockReturnValue(mutationStub());
  mockUseRegenerateApiKey.mockReturnValue(mutationStub());
  mockUseDeleteApiKey.mockReturnValue(mutationStub());
}

describe('ApiKeysAdminView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCan.mockImplementation((key: string) => key === 'api-keys:manage');
    setupHooks([]);
  });

  it('shows add button and empty state when there are no keys (PBI-001 AC-0)', () => {
    render(<ApiKeysAdminView selectedProject="Apex" />);

    expect(screen.getByTestId('api-keys-add')).toBeInTheDocument();
    expect(screen.getByTestId('api-keys-empty')).toHaveTextContent(
      'No API keys yet — create one to enable programmatic access',
    );
  });

  it('renders status filter pills and search with expected test ids', () => {
    render(<ApiKeysAdminView selectedProject="Apex" />);

    expect(screen.getByTestId('api-keys-filter-status-all')).toBeInTheDocument();
    expect(screen.getByTestId('api-keys-filter-status-active')).toBeInTheDocument();
    expect(screen.getByTestId('api-keys-filter-status-expired')).toBeInTheDocument();
    expect(screen.getByTestId('api-keys-search')).toBeInTheDocument();
  });

  it('shows maskedPrefix in the grid and never a raw key (PBI-001 AC-4)', () => {
    setupHooks([sampleKey]);
    render(<ApiKeysAdminView selectedProject="Apex" />);

    expect(screen.getByTestId('api-keys-grid')).toBeInTheDocument();
    expect(screen.getByText('apex_x7k…')).toBeInTheDocument();
    expect(screen.getByText('CI Pipeline')).toBeInTheDocument();
    expect(screen.queryByText(/apex_[a-zA-Z0-9_-]{20,}/)).not.toBeInTheDocument();
  });

  it('denies access when user lacks api-keys:manage', () => {
    mockCan.mockReturnValue(false);
    render(<ApiKeysAdminView selectedProject="Apex" />);

    expect(screen.getByTestId('api-keys-access-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('api-keys-add')).not.toBeInTheDocument();
    expect(mockUseApiKeys).toHaveBeenCalledWith(null);
  });
});
