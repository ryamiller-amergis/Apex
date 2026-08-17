/**
 * ApiKeyManageDrawer — PBI-002 manage / cancel-delete / regenerate controls
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { ApiKeyMetadata } from '../../../shared/types/apiKey';
import { ApiKeyManageDrawer } from '../ApiKeyManageDrawer';

const mockUseUpdateApiKey = jest.fn();
const mockUseRegenerateApiKey = jest.fn();
const mockUseDeleteApiKey = jest.fn();

jest.mock('../../hooks/useApiKeys', () => ({
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
  scopes: ['flags:evaluate'],
  expiresAt: '2026-11-11T00:00:00.000Z',
  status: 'active',
  createdAt: '2026-08-11T00:00:00.000Z',
  createdBy: 'alice@example.com',
};

function mutationStub(overrides: Record<string, unknown> = {}) {
  return {
    mutate: jest.fn(),
    mutateAsync: jest.fn(),
    isPending: false,
    error: null,
    ...overrides,
  };
}

describe('ApiKeyManageDrawer', () => {
  const deleteMutateAsync = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseUpdateApiKey.mockReturnValue(mutationStub());
    mockUseRegenerateApiKey.mockReturnValue(mutationStub());
    mockUseDeleteApiKey.mockReturnValue(
      mutationStub({ mutateAsync: deleteMutateAsync }),
    );
  });

  it('renders regenerate and save controls', () => {
    render(
      <ApiKeyManageDrawer
        projectId="Apex"
        apiKey={sampleKey}
        onClose={jest.fn()}
      />,
    );

    expect(screen.getByTestId('api-key-manage-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('api-key-regenerate')).toBeInTheDocument();
    expect(screen.getByTestId('api-key-manage-save')).toBeInTheDocument();
    expect(screen.getByTestId('api-key-delete')).toBeInTheDocument();
    expect(screen.getByTestId('api-key-expiry-notification-hint')).toHaveTextContent(
      /30 days, 7 days, and 1 day before a key expires/i,
    );
    expect(screen.getByTestId('api-key-manage-scopes')).toBeInTheDocument();
    expect(screen.getByTestId('api-key-manage-scope-flags-evaluate')).toBeChecked();
  });

  it('does not call delete mutation when cancel is chosen (PBI-002 AC-3)', () => {
    render(
      <ApiKeyManageDrawer
        projectId="Apex"
        apiKey={sampleKey}
        onClose={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('api-key-delete'));
    expect(screen.getByTestId('api-key-delete-confirm')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('api-key-delete-cancel'));
    expect(screen.queryByTestId('api-key-delete-confirm')).not.toBeInTheDocument();
    expect(deleteMutateAsync).not.toHaveBeenCalled();
  });
});
