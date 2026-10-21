import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IntegrationsView } from '../IntegrationsView';

const createConnection = jest.fn();
const ask = jest.fn();

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    can: (key: string) => mockPermissions.has(key),
  }),
}));

jest.mock('../../hooks/useIntegrations', () => ({
  useIntegrations: () => ({
    connections: mockConnections,
    isLoading: false,
    error: null,
    createConnection,
    testConnection: jest.fn(),
    updateAccess: jest.fn(),
    deleteConnection: jest.fn(),
    ask,
    answer: 'Jane Ticket is a Clerk user.',
  }),
}));

let mockPermissions = new Set<string>();
let mockConnections: Array<Record<string, unknown>> = [];

describe('IntegrationsView', () => {
  beforeEach(() => {
    createConnection.mockReset();
    ask.mockReset();
    mockPermissions = new Set(['integrations:view', 'integrations:manage']);
    mockConnections = [
      {
        id: 'conn-1',
        project: 'MaxView',
        name: 'MaxView Clerk',
        provider: 'clerk',
        status: 'untested',
        credentialHint: '••••cret',
        allowedUserIds: ['user-1'],
      },
    ];
  });

  it('SC-1 shows the module as unavailable when the flag or menu is off', () => {
    const { rerender } = render(
      <IntegrationsView project="MaxView" enabled={false} menuEnabled />,
    );
    expect(screen.getByTestId('integrations-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('integrations-create-form')).not.toBeInTheDocument();

    rerender(<IntegrationsView project="MaxView" enabled menuEnabled={false} />);
    expect(screen.getByTestId('integrations-unavailable')).toBeInTheDocument();
  });

  it('SC-2 hides create and edit when the user cannot manage connections', () => {
    mockPermissions = new Set(['integrations:view']);
    render(<IntegrationsView project="MaxView" enabled menuEnabled />);

    expect(screen.getByTestId('integrations-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('integrations-create-form')).not.toBeInTheDocument();
    expect(screen.queryByTestId('integrations-edit-access-conn-1')).not.toBeInTheDocument();
    expect(screen.getByText('••••cret')).toBeInTheDocument();
    expect(screen.queryByText('sk_live_supersecret')).not.toBeInTheDocument();
  });

  it('SC-3 lets a manager submit a prebuilt credential', async () => {
    createConnection.mockResolvedValue(undefined);
    render(<IntegrationsView project="MaxView" enabled menuEnabled />);

    fireEvent.change(screen.getByTestId('integrations-name-input'), {
      target: { value: 'MaxView Clerk' },
    });
    fireEvent.change(screen.getByTestId('integrations-provider-select'), {
      target: { value: 'clerk' },
    });
    fireEvent.change(screen.getByTestId('integrations-credential-input'), {
      target: { value: 'sk_live_supersecret' },
    });
    fireEvent.change(screen.getByTestId('integrations-allowed-users-input'), {
      target: { value: 'user-1' },
    });
    fireEvent.click(screen.getByTestId('integrations-save'));

    await waitFor(() => {
      expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({
        name: 'MaxView Clerk',
        provider: 'clerk',
        credential: 'sk_live_supersecret',
        allowedUserIds: ['user-1'],
      }));
    });
  });

  it('SC-6 keeps Pendo and SendGrid as separate chat choices', async () => {
    mockConnections = [
      {
        id: 'pendo-1',
        project: 'MaxView',
        name: 'MaxView Pendo',
        provider: 'pendo',
        status: 'usable',
        credentialHint: '••••key1',
        allowedUserIds: ['user-1'],
      },
      {
        id: 'sendgrid-1',
        project: 'MaxView',
        name: 'MaxView SendGrid',
        provider: 'sendgrid',
        status: 'usable',
        credentialHint: '••••key2',
        allowedUserIds: ['user-1'],
      },
    ];
    render(<IntegrationsView project="MaxView" enabled menuEnabled />);

    const select = screen.getByTestId('integrations-connection-select');
    expect(screen.getByRole('option', { name: 'MaxView Pendo' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'MaxView SendGrid' })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'pendo-1' } });
    fireEvent.change(screen.getByTestId('integrations-question'), {
      target: { value: 'What do we know about user jane@example.com from ticket 4421?' },
    });
    fireEvent.click(screen.getByTestId('integrations-ask'));

    await waitFor(() => {
      expect(ask).toHaveBeenCalledWith({
        connectionId: 'pendo-1',
        question: 'What do we know about user jane@example.com from ticket 4421?',
      });
    });

    fireEvent.change(select, { target: { value: 'sendgrid-1' } });
    fireEvent.click(screen.getByTestId('integrations-ask'));

    await waitFor(() => {
      expect(ask).toHaveBeenCalledWith({
        connectionId: 'sendgrid-1',
        question: 'What do we know about user jane@example.com from ticket 4421?',
      });
    });
  });

  it('SC-7 does not save a custom connector from only a URL and key', async () => {
    render(<IntegrationsView project="MaxView" enabled menuEnabled />);

    fireEvent.change(screen.getByTestId('integrations-provider-select'), {
      target: { value: 'custom' },
    });
    fireEvent.change(screen.getByTestId('integrations-name-input'), {
      target: { value: 'Tickets' },
    });
    fireEvent.change(screen.getByTestId('integrations-credential-input'), {
      target: { value: 'custom-key' },
    });
    fireEvent.change(screen.getByTestId('integrations-custom-base-url'), {
      target: { value: 'https://api.example.com' },
    });
    fireEvent.click(screen.getByTestId('integrations-save'));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('SC-7 submits a manual read-only operation', async () => {
    createConnection.mockResolvedValue(undefined);
    render(<IntegrationsView project="MaxView" enabled menuEnabled />);

    fireEvent.change(screen.getByTestId('integrations-provider-select'), {
      target: { value: 'custom' },
    });
    fireEvent.change(screen.getByTestId('integrations-name-input'), {
      target: { value: 'Tickets' },
    });
    fireEvent.change(screen.getByTestId('integrations-credential-input'), {
      target: { value: 'custom-key' },
    });
    fireEvent.change(screen.getByTestId('integrations-custom-base-url'), {
      target: { value: 'https://api.example.com' },
    });
    fireEvent.change(screen.getByTestId('integrations-operation-id'), {
      target: { value: 'getTicket' },
    });
    fireEvent.change(screen.getByTestId('integrations-operation-path'), {
      target: { value: '/tickets/{id}' },
    });
    fireEvent.change(screen.getByTestId('integrations-operation-summary'), {
      target: { value: 'Get a ticket' },
    });
    fireEvent.click(screen.getByTestId('integrations-readonly'));
    fireEvent.click(screen.getByTestId('integrations-add-operation'));
    fireEvent.click(screen.getByTestId('integrations-save'));

    await waitFor(() => {
      expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Tickets',
        provider: 'custom',
        credential: 'custom-key',
        baseUrl: 'https://api.example.com',
        operations: [{
          id: 'getTicket',
          method: 'GET',
          path: '/tickets/{id}',
          summary: 'Get a ticket',
          readOnly: true,
        }],
      }));
    });
  });
});
