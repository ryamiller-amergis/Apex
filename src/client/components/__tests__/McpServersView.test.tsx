import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { McpServersView } from '../McpServersView';

const createConnection = jest.fn();
const testConnection = jest.fn();
const updateAccess = jest.fn();
const startOAuth = jest.fn();
const deleteConnection = jest.fn();

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    can: (key: string) => mockPermissions.has(key),
  }),
}));

jest.mock('../../hooks/useMcpServers', () => ({
  useMcpServers: () => ({
    connections: mockConnections,
    isLoading: false,
    error: null,
    createConnection,
    discoverTools: jest.fn(),
    testConnection,
    updateAccess,
    startOAuth,
    deleteConnection,
    ask: jest.fn(),
    answer: null,
  }),
}));

let mockPermissions = new Set<string>();
let mockConnections: Array<Record<string, unknown>> = [];

describe('McpServersView', () => {
  beforeEach(() => {
    createConnection.mockReset();
    testConnection.mockReset();
    updateAccess.mockReset();
    startOAuth.mockReset();
    deleteConnection.mockReset();
    mockPermissions = new Set(['mcp-servers:view', 'mcp-servers:manage']);
    mockConnections = [
      {
        id: 'conn-1',
        project: 'MaxView',
        name: 'Docs',
        provider: 'custom',
        status: 'untested',
        credentialHint: '••••alue',
        allowedUserIds: [],
        baseUrl: 'https://example.com/mcp',
        headers: { Accept: 'application/json' },
        toolNames: ['search'],
        secretNames: ['TOKEN'],
        missingSecretNames: [],
        authMode: 'secret',
        oauthConnected: false,
      },
    ];
  });

  it('hides the named provider catalog', () => {
    render(<McpServersView project="MaxView" enabled menuEnabled />);
    expect(screen.getByRole('heading', { name: 'MCP Servers' })).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-servers-catalog-pendo')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mcp-servers-catalog-clerk')).not.toBeInTheDocument();
    expect(screen.getByTestId('mcp-servers-test-conn-1')).toBeInTheDocument();
  });

  it('stays unavailable when the flag or menu is off', () => {
    const { rerender } = render(
      <McpServersView project="MaxView" enabled={false} menuEnabled />,
    );
    expect(screen.getByTestId('mcp-servers-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-servers-create-form')).not.toBeInTheDocument();
    rerender(<McpServersView project="MaxView" enabled menuEnabled={false} />);
    expect(screen.getByTestId('mcp-servers-unavailable')).toBeInTheDocument();
  });

  it('hides the editor from a viewer', () => {
    mockPermissions = new Set(['mcp-servers:view']);
    render(<McpServersView project="MaxView" enabled menuEnabled />);
    expect(screen.getByTestId('mcp-servers-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-servers-add')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mcp-servers-test-conn-1')).not.toBeInTheDocument();
  });

  it('saves a remote MCP server with headers, a secret, and a tool restriction', async () => {
    createConnection.mockResolvedValue(undefined);
    render(<McpServersView project="MaxView" enabled menuEnabled />);
    fireEvent.click(screen.getByTestId('mcp-servers-add'));
    fireEvent.change(screen.getByTestId('mcp-servers-name-input'), {
      target: { value: 'Docs MCP' },
    });
    fireEvent.change(screen.getByTestId('mcp-servers-config'), {
      target: {
        value: JSON.stringify({
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer ${TOKEN}' },
        }),
      },
    });
    fireEvent.click(screen.getByTestId('mcp-servers-auth-secret'));
    fireEvent.change(screen.getByTestId('mcp-servers-tool-name'), { target: { value: 'search' } });
    fireEvent.click(screen.getByTestId('mcp-servers-add-tool'));
    fireEvent.change(screen.getByTestId('mcp-servers-secret-name'), { target: { value: 'TOKEN' } });
    fireEvent.change(screen.getByTestId('mcp-servers-secret-value'), { target: { value: 'secret-value' } });
    fireEvent.click(screen.getByTestId('mcp-servers-add-secret'));
    fireEvent.click(screen.getByTestId('mcp-servers-save'));

    await waitFor(() => {
      expect(createConnection).toHaveBeenCalledWith({
        name: 'Docs MCP',
        provider: 'custom',
        credential: '',
        allowedUserIds: [],
        mcpUrl: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer ${TOKEN}' },
        secrets: [{ name: 'TOKEN', value: 'secret-value' }],
        toolNames: ['search'],
        authMode: 'secret',
      });
    });
  });

  it('refuses a local command and asks for a saved server before OAuth sign-in', () => {
    render(<McpServersView project="MaxView" enabled menuEnabled />);
    fireEvent.click(screen.getByTestId('mcp-servers-add'));
    fireEvent.change(screen.getByTestId('mcp-servers-config'), {
      target: { value: JSON.stringify({ command: 'npx server' }) },
    });
    fireEvent.click(screen.getByTestId('mcp-servers-save'));
    expect(screen.getByTestId('mcp-servers-config-error')).toHaveTextContent('does not run a local command');
    expect(createConnection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('mcp-servers-auth-oauth'));
    fireEvent.click(screen.getByTestId('mcp-servers-oauth-signin'));
    expect(screen.getByTestId('mcp-servers-config-error')).toHaveTextContent('Save this server, then sign in.');
    expect(startOAuth).not.toHaveBeenCalled();
  });

  it('opens an existing server for editing', () => {
    render(<McpServersView project="MaxView" enabled menuEnabled />);
    fireEvent.click(screen.getByTestId('mcp-servers-open-conn-1'));
    expect(screen.getByTestId('mcp-servers-name-input')).toHaveValue('Docs');
    expect((screen.getByTestId('mcp-servers-config') as HTMLTextAreaElement).value).toContain('https://example.com/mcp');
    expect(screen.getByText('TOKEN')).toBeInTheDocument();
    expect(screen.getByText('search')).toBeInTheDocument();
  });

  it('tests a server from the list', () => {
    render(<McpServersView project="MaxView" enabled menuEnabled />);
    fireEvent.click(screen.getByTestId('mcp-servers-test-conn-1'));
    expect(testConnection).toHaveBeenCalledWith('conn-1');
  });

  it('centers removal in the shared confirmation modal', () => {
    render(<McpServersView project="MaxView" enabled menuEnabled />);
    fireEvent.click(screen.getByTestId('mcp-servers-delete-conn-1'));

    const dialog = screen.getByTestId('mcp-servers-delete-dialog');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('“Docs”')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-delete-confirm-btn'));
    expect(deleteConnection).toHaveBeenCalledWith('conn-1');
  });

  it('shows discovered tools and saves the ones left checked', async () => {
    mockConnections[0].operations = [
      { id: 'list_users', method: 'GET', path: '/mcp-tool', summary: 'List users', readOnly: true, source: 'mcp' },
      { id: 'whoami', method: 'GET', path: '/mcp-tool', summary: 'Who am I', readOnly: true, source: 'mcp' },
    ];
    mockConnections[0].toolNames = [];
    updateAccess.mockResolvedValue(undefined);
    render(<McpServersView project="MaxView" enabled menuEnabled />);
    fireEvent.click(screen.getByTestId('mcp-servers-open-conn-1'));
    expect(screen.getByTestId('mcp-servers-allow-all-tools')).toBeChecked();
    expect(screen.getByTestId('mcp-servers-tool-list_users')).toBeChecked();
    fireEvent.click(screen.getByTestId('mcp-servers-tool-list_users'));
    fireEvent.click(screen.getByTestId('mcp-servers-save'));
    await waitFor(() => {
      expect(updateAccess).toHaveBeenCalledWith('conn-1', expect.objectContaining({
        toolNames: ['whoami'],
      }));
    });
  });

  it('starts a chat for a tested server and waits for tools before enabling it', () => {
    const onStartChat = jest.fn();
    const view = render(
      <McpServersView project="MaxView" enabled menuEnabled canStartChat onStartChat={onStartChat} />,
    );
    expect(screen.getByTestId('mcp-servers-chat-conn-1')).toBeDisabled();
    mockConnections[0].operations = [
      { id: 'whoami', method: 'GET', path: '/mcp-tool', summary: 'Who am I', readOnly: true, source: 'mcp' },
    ];
    view.rerender(
      <McpServersView project="MaxView" enabled menuEnabled canStartChat onStartChat={onStartChat} />,
    );
    fireEvent.click(screen.getByTestId('mcp-servers-chat-conn-1'));
    expect(onStartChat).toHaveBeenCalledWith({ id: 'conn-1', name: 'Docs' });
  });

  it('syncs the structured URL input with the JSON config, displays live Usable status in the detail header, and filters discovered tools', () => {
    mockConnections[0].status = 'usable';
    mockConnections[0].operations = [
      { id: 'list_users', method: 'GET', path: '/mcp-tool', summary: 'List users in an instance', readOnly: true, source: 'mcp' },
      { id: 'whoami', method: 'GET', path: '/mcp-tool', summary: 'Show authenticated user', readOnly: true, source: 'mcp' },
    ];
    mockConnections[0].toolNames = [];

    render(<McpServersView project="MaxView" enabled menuEnabled />);
    fireEvent.click(screen.getByTestId('mcp-servers-open-conn-1'));

    expect(screen.getByTestId('mcp-servers-detail-status')).toHaveTextContent('Usable');
    expect(screen.getByTestId('mcp-servers-tool-count')).toHaveTextContent('2/2 tools enabled');

    const urlInput = screen.getByTestId('mcp-servers-url-input') as HTMLInputElement;
    expect(urlInput.value).toBe('https://example.com/mcp');
    fireEvent.change(urlInput, { target: { value: 'https://mcp.clerk.com/mcp' } });
    expect((screen.getByTestId('mcp-servers-config') as HTMLTextAreaElement).value).toContain(
      'https://mcp.clerk.com/mcp',
    );

    fireEvent.click(screen.getByTestId('mcp-servers-test-selected'));
    expect(testConnection).toHaveBeenCalledWith('conn-1');

    fireEvent.change(screen.getByTestId('mcp-servers-tool-filter'), {
      target: { value: 'whoami' },
    });
    expect(screen.getByTestId('mcp-servers-tool-whoami')).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-servers-tool-list_users')).not.toBeInTheDocument();
  });
});
