import React, { useState } from 'react';
import { Lock, MessageSquare, Plus, RefreshCw, Server } from 'lucide-react';
import {
  type McpServerAuthMode,
  type McpServerConnectionPublic,
} from '../../shared/types/mcpServers';
import { useAppShell } from '../hooks/useAppShell';
import { useMcpServers } from '../hooks/useMcpServers';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import gridStyles from './DataGrid.module.css';
import styles from './McpServersView.module.css';

const DEFAULT_CONFIG = `{
  "url": "https://example.com/mcp",
  "headers": {}
}`;

interface ParsedConfig {
  url: string;
  headers: Record<string, string>;
}

function parseMcpConfig(text: string): ParsedConfig | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'Configuration must be JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'Configuration must be a JSON object.' };
  }
  const record = parsed as Record<string, unknown>;
  if ('command' in record) {
    return { error: 'Apex connects to a remote URL. It does not run a local command.' };
  }
  if (typeof record.url !== 'string' || !record.url.trim()) {
    return { error: 'Configuration needs a url.' };
  }
  const rawHeaders = record.headers ?? {};
  if (typeof rawHeaders !== 'object' || rawHeaders === null || Array.isArray(rawHeaders)) {
    return { error: 'headers must be an object of strings.' };
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (typeof value !== 'string') return { error: 'Header values must be strings.' };
    headers[key] = value;
  }
  return { url: record.url.trim(), headers };
}

interface McpServersViewProps {
  project: string;
  enabled: boolean;
  menuEnabled: boolean;
  canStartChat?: boolean;
  startChatError?: string | null;
  onStartChat?: (connection: { id: string; name: string }) => void;
}

function readOAuthNotice(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get('oauth') === 'connected') return 'Signed in. Test the server to load its tools.';
  if (params.get('oauth') === 'error') {
    const message = params.get('message') ?? '';
    return /^[\w .,'-]{1,200}$/.test(message) ? message : 'OAuth sign-in did not finish.';
  }
  return null;
}

function configTextFor(connection: McpServerConnectionPublic): string {
  return JSON.stringify({
    url: connection.baseUrl ?? '',
    headers: connection.headers ?? {},
  }, null, 2);
}

function Unavailable(): React.ReactElement {
  return (
    <section className={styles.unavailable} {...{ 'data-testid': 'mcp-servers-unavailable' }}>
      <h1>MCP Servers is not available</h1>
      <p>This project does not have MCP Servers turned on.</p>
    </section>
  );
}

export const McpServersView: React.FC<McpServersViewProps> = ({
  project,
  enabled,
  menuEnabled,
  canStartChat = false,
  startChatError,
  onStartChat,
}) => {
  const [search, setSearch] = useState('');
  const [composing, setComposing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('New MCP Server');
  const [endpointUrl, setEndpointUrl] = useState('https://example.com/mcp');
  const [configText, setConfigText] = useState(DEFAULT_CONFIG);
  const [showAdvancedJson, setShowAdvancedJson] = useState(true);
  const [toolSearch, setToolSearch] = useState('');
  const [toolDraft, setToolDraft] = useState('');
  const [toolNames, setToolNames] = useState<string[]>([]);
  const [allowAllTools, setAllowAllTools] = useState(true);
  const [secretName, setSecretName] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [secrets, setSecrets] = useState<Array<{ name: string; value: string }>>([]);
  const [savedSecretNames, setSavedSecretNames] = useState<string[]>([]);
  const [authMode, setAuthMode] = useState<McpServerAuthMode>('none');
  const [oauthConnected, setOauthConnected] = useState(false);
  const [oauthNotice] = useState(readOAuthNotice);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [secretError, setSecretError] = useState<string | null>(null);
  const { can, isSuperAdmin } = useAppShell();
  const mcpServers = useMcpServers(project);

  const canView = Boolean(isSuperAdmin) || can('mcp-servers:view');
  const canManage = Boolean(isSuperAdmin) || can('mcp-servers:manage');

  // @feature-flag:mcp-servers start winner=enabled
  if (!enabled) {
    // @feature-flag:mcp-servers disabled-start
    return <Unavailable />;
    // @feature-flag:mcp-servers disabled-end
  }

  // @feature-flag:mcp-servers enabled-start
  if (!menuEnabled || !canView) {
    return <Unavailable />;
  }

  const visible = mcpServers.connections.filter((connection) =>
    connection.name.toLowerCase().includes(search.trim().toLowerCase())
  );

  const syncEndpointIntoConfig = (nextUrl: string) => {
    setEndpointUrl(nextUrl);
    const parsed = parseMcpConfig(configText);
    const currentHeaders = 'error' in parsed ? {} : parsed.headers;
    setConfigText(
      JSON.stringify(
        {
          url: nextUrl,
          headers: currentHeaders,
        },
        null,
        2,
      ),
    );
  };

  const handleConfigTextChange = (nextText: string) => {
    setConfigText(nextText);
    const parsed = parseMcpConfig(nextText);
    if (!('error' in parsed)) {
      setEndpointUrl(parsed.url);
    }
  };

  const resetDraft = () => {
    setName('New MCP Server');
    setEndpointUrl('https://example.com/mcp');
    setConfigText(DEFAULT_CONFIG);
    setToolSearch('');
    setToolDraft('');
    setToolNames([]);
    setAllowAllTools(true);
    setSecretName('');
    setSecretValue('');
    setSecrets([]);
    setSavedSecretNames([]);
    setAuthMode('none');
    setOauthConnected(false);
    setSelectedId(null);
    setFormError(null);
  };

  const openConnection = (connection: McpServerConnectionPublic) => {
    setComposing(false);
    setSelectedId(connection.id);
    setName(connection.name);
    setEndpointUrl(connection.baseUrl ?? '');
    setConfigText(configTextFor(connection));
    setToolSearch('');
    setToolDraft('');
    setToolNames(connection.toolNames ?? []);
    setAllowAllTools((connection.toolNames ?? []).length === 0);
    setSecretName('');
    setSecretValue('');
    setSecrets([]);
    setSavedSecretNames(connection.secretNames ?? []);
    setAuthMode(connection.authMode ?? 'none');
    setOauthConnected(Boolean(connection.oauthConnected));
    setFormError(null);
  };

  const selectedConnection = mcpServers.connections.find((connection) => connection.id === selectedId);
  const discoveredTools = (selectedConnection?.operations ?? []).filter((operation) => operation.source === 'mcp');
  const filteredDiscoveredTools = discoveredTools.filter((tool) => {
    const query = toolSearch.trim().toLowerCase();
    if (!query) return true;
    return (
      tool.id.toLowerCase().includes(query) ||
      (tool.summary ?? '').toLowerCase().includes(query)
    );
  });
  const enabledToolNames = allowAllTools ? [] : toolNames;
  const enabledDiscoveredCount = allowAllTools
    ? discoveredTools.length
    : discoveredTools.filter((tool) => toolNames.includes(tool.id)).length;

  const addTool = () => {
    const next = toolDraft.trim();
    if (!next || toolNames.includes(next)) return;
    setAllowAllTools(false);
    setToolNames((current) => [...current, next]);
    setToolDraft('');
  };

  const toolIsChecked = (toolId: string) => allowAllTools || toolNames.includes(toolId);

  const toggleAllowAll = () => {
    if (allowAllTools) {
      setAllowAllTools(false);
      setToolNames(discoveredTools.map((tool) => tool.id));
      return;
    }
    setAllowAllTools(true);
    setToolNames([]);
  };

  const toggleTool = (toolId: string) => {
    const current = allowAllTools ? discoveredTools.map((tool) => tool.id) : toolNames;
    const next = current.includes(toolId)
      ? current.filter((item) => item !== toolId)
      : [...current, toolId];
    setAllowAllTools(false);
    setToolNames(next);
  };

  const addSecret = () => {
    const nextName = secretName.trim();
    if (!nextName || !secretValue || secrets.some((secret) => secret.name === nextName)) return;
    setSecrets((current) => [...current, { name: nextName, value: secretValue }]);
    setSecretName('');
    setSecretValue('');
  };

  const handleTestServer = async (id: string) => {
    setTestingId(id);
    setFormError(null);
    try {
      await mcpServers.testConnection(id);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Connection test failed');
    } finally {
      setTestingId(null);
    }
  };

  const onCreate = async () => {
    const parsed = parseMcpConfig(configText);
    if ('error' in parsed) {
      setFormError(parsed.error);
      return;
    }
    if (!name.trim()) {
      setFormError('Server name is required.');
      return;
    }
    if (!allowAllTools && enabledToolNames.length === 0) {
      setFormError('Choose at least one tool, or allow every read-only tool.');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const savedSecrets = secrets;
      const savedNames = [...savedSecretNames, ...secrets.map((secret) => secret.name)];
      if (selectedId && !composing) {
        await mcpServers.updateAccess(selectedId, {
          name: name.trim(),
          mcpUrl: parsed.url,
          headers: parsed.headers,
          secrets: savedSecrets,
          secretNames: savedNames,
          toolNames: enabledToolNames,
          authMode,
        });
        setSecrets([]);
        setSavedSecretNames(savedNames);
      } else {
        await mcpServers.createConnection({
          name: name.trim(),
          provider: 'custom',
          credential: '',
          allowedUserIds: [],
          mcpUrl: parsed.url,
          headers: parsed.headers,
          secrets: savedSecrets,
          toolNames: enabledToolNames,
          authMode,
        });
        resetDraft();
        setComposing(false);
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save this server');
    } finally {
      setSaving(false);
    }
  };

  const startSignIn = async () => {
    if (!selectedId || composing) {
      setFormError('Save this server, then sign in.');
      return;
    }
    setAuthMode('oauth');
    const parsed = parseMcpConfig(configText);
    if ('error' in parsed) {
      setFormError(parsed.error);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await mcpServers.updateAccess(selectedId, {
        name: name.trim(),
        mcpUrl: parsed.url,
        headers: parsed.headers,
        secrets,
        secretNames: [...savedSecretNames, ...secrets.map((secret) => secret.name)],
        toolNames: enabledToolNames,
        authMode: 'oauth',
      });
      const authorizationUrl = await mcpServers.startOAuth(selectedId);
      window.location.assign(authorizationUrl);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not start OAuth sign-in');
    } finally {
      setSaving(false);
    }
  };

  const isSelectedUsable = Boolean(
    selectedConnection && !composing && selectedConnection.status === 'usable',
  );

  return (
    <section className={`${gridStyles.section} ${styles.page}`} {...{ 'data-testid': 'mcp-servers-screen' }}>
      <div className={styles.sectionHeading}>
        <div>
          <h1 className={styles.catalogTitle}>MCP Servers</h1>
          <p>Add a remote MCP server for this project. One sign-in is shared by everyone who can use the project.</p>
        </div>
      </div>
      {startChatError && (
        <p className={gridStyles.error} {...{ 'data-testid': 'mcp-servers-chat-error' }}>{startChatError}</p>
      )}
      <div className={styles.workspace}>
        <aside className={styles.serverPane}>
          <div className={styles.serverPaneHeader}>
            <span>{visible.length} {visible.length === 1 ? 'server' : 'servers'}</span>
            {canManage && (
              <button
                type="button"
                className={styles.connectButton}
                onClick={() => {
                  resetDraft();
                  setComposing(true);
                }}
                {...{ 'data-testid': 'mcp-servers-add' }}
              >
                <Plus size={16} /> Add MCP Server
              </button>
            )}
          </div>
          <input
            className={styles.serverSearch}
            type="search"
            value={search}
            placeholder="Search servers…"
            onChange={(event) => setSearch(event.target.value)}
            {...{ 'data-testid': 'mcp-servers-search' }}
          />
          {mcpServers.isLoading && <p className={gridStyles.loading}>Loading servers…</p>}
          {mcpServers.error && <p className={gridStyles.error}>{mcpServers.error}</p>}
          {visible.length === 0 && (
            <p className={styles.emptyPane} {...{ 'data-testid': 'mcp-servers-empty' }}>No MCP servers for this project.</p>
          )}
          <ul className={styles.serverList}>
            {visible.map((connection) => {
              const connectionTools = (connection.operations ?? []).filter((operation) => operation.source === 'mcp');
              return (
                <li
                  key={connection.id}
                  className={`${styles.serverItem} ${selectedId === connection.id ? styles.serverItemSelected : ''}`}
                  {...{ 'data-testid': 'mcp-servers-connection-row' }}
                >
                  <div className={styles.serverItemTopRow}>
                    <button
                      type="button"
                      className={styles.serverItemName}
                      onClick={() => openConnection(connection)}
                      {...{ 'data-testid': `mcp-servers-open-${connection.id}` }}
                    >
                      <Server size={14} />
                      {connection.name}
                    </button>
                    <span className={connection.status === 'usable' ? styles.connectedBadge : styles.availableBadge}>
                      {connection.status === 'usable' ? 'Usable' : 'Inactive'}
                    </span>
                  </div>
                  {connectionTools.length > 0 && (
                    <span className={styles.serverItemSubmeta}>
                      {connectionTools.length} read-only {connectionTools.length === 1 ? 'tool' : 'tools'}
                    </span>
                  )}
                  {canManage && (connection.missingSecretNames ?? []).map((secret) => (
                    <form
                      key={secret}
                      className={styles.inlineAdd}
                      onSubmit={(event) => {
                        event.preventDefault();
                        setSecretError(null);
                        void mcpServers.updateAccess(connection.id, {
                          secrets: [{ name: secret, value: secretDrafts[`${connection.id}:${secret}`] ?? '' }],
                        }).then(() => {
                          setSecretDrafts((current) => {
                            const next = { ...current };
                            delete next[`${connection.id}:${secret}`];
                            return next;
                          });
                        }).catch((err: unknown) => {
                          setSecretError(err instanceof Error ? err.message : 'Could not save the secret');
                        });
                      }}
                      {...{ 'data-testid': `mcp-servers-secret-form-${connection.id}-${secret}` }}
                    >
                      <input
                        type="password"
                        autoComplete="off"
                        placeholder={secret}
                        aria-label={secret}
                        value={secretDrafts[`${connection.id}:${secret}`] ?? ''}
                        onChange={(event) => setSecretDrafts((current) => ({
                          ...current,
                          [`${connection.id}:${secret}`]: event.target.value,
                        }))}
                        {...{ 'data-testid': `mcp-servers-secret-${connection.id}` }}
                      />
                      <button
                        type="submit"
                        className={gridStyles.button}
                        {...{ 'data-testid': `mcp-servers-secret-save-${connection.id}-${secret}` }}
                      >
                        Save
                      </button>
                    </form>
                  ))}
                  <div className={styles.serverItemFooter}>
                    {onStartChat && (
                      <button
                        type="button"
                        className={gridStyles.buttonGhost}
                        disabled={!canStartChat || connectionTools.length === 0}
                        onClick={() => onStartChat({ id: connection.id, name: connection.name })}
                        {...{ 'data-testid': `mcp-servers-chat-${connection.id}` }}
                      >
                        <MessageSquare size={14} /> Chat
                      </button>
                    )}
                    {canManage && (
                      <span className={styles.serverItemActions}>
                        <button
                          type="button"
                          className={gridStyles.buttonGhost}
                          disabled={testingId === connection.id}
                          onClick={() => { void handleTestServer(connection.id); }}
                          {...{ 'data-testid': `mcp-servers-test-${connection.id}` }}
                        >
                          {testingId === connection.id ? 'Testing…' : 'Test'}
                        </button>
                        <button
                          type="button"
                          className={gridStyles.buttonGhost}
                          onClick={() => setPendingDeleteId(connection.id)}
                          {...{ 'data-testid': `mcp-servers-delete-${connection.id}` }}
                        >
                          Remove
                        </button>
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {secretError && <p className={gridStyles.error}>{secretError}</p>}
        </aside>

        <div className={styles.editor}>
          {canManage && (composing || selectedId) ? (
            <form
              className={styles.detail}
              onSubmit={(event) => {
                event.preventDefault();
                void onCreate();
              }}
              {...{ 'data-testid': 'mcp-servers-create-form' }}
            >
              <div className={styles.detailHeader}>
                <div>
                  <h2>
                    {name.trim() || 'New MCP Server'}
                    <span
                      className={isSelectedUsable ? styles.connectedBadge : styles.availableBadge}
                      {...{ 'data-testid': 'mcp-servers-detail-status' }}
                    >
                      {isSelectedUsable ? 'Usable' : 'Inactive'}
                    </span>
                    {discoveredTools.length > 0 && (
                      <span className={styles.toolCountBadge} {...{ 'data-testid': 'mcp-servers-tool-count' }}>
                        {enabledDiscoveredCount}/{discoveredTools.length} tools enabled
                      </span>
                    )}
                  </h2>
                  <p>
                    {isSelectedUsable
                      ? 'Connected for this project. Refresh tools anytime after upstream changes.'
                      : 'Saved for this project. Configure authentication and test the connection to load its tools.'}
                  </p>
                </div>
                <span className={styles.serverItemActions}>
                  {selectedConnection && !composing && (
                    <button
                      type="button"
                      className={gridStyles.buttonGhost}
                      disabled={testingId === selectedConnection.id}
                      onClick={() => { void handleTestServer(selectedConnection.id); }}
                      {...{ 'data-testid': 'mcp-servers-test-selected' }}
                    >
                      <RefreshCw size={14} /> {testingId === selectedConnection.id ? 'Testing…' : 'Test & Refresh Tools'}
                    </button>
                  )}
                  {onStartChat && selectedConnection && (
                    <button
                      type="button"
                      className={gridStyles.buttonGhost}
                      disabled={!canStartChat || discoveredTools.length === 0}
                      onClick={() => onStartChat({ id: selectedConnection.id, name: selectedConnection.name })}
                      {...{ 'data-testid': 'mcp-servers-chat-selected' }}
                    >
                      <MessageSquare size={14} /> Chat
                    </button>
                  )}
                  <button type="submit" className={styles.connectButton} disabled={saving} {...{ 'data-testid': 'mcp-servers-save' }}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </span>
              </div>

              {formError && <p className={gridStyles.error} {...{ 'data-testid': 'mcp-servers-config-error' }}>{formError}</p>}

              <section className={styles.detailSection}>
                <div className={styles.stepHeader}>
                  <span className={styles.stepBadge}>1</span>
                  <div>
                    <h2>Connection & Endpoint</h2>
                    <p>Name this server and provide its public HTTPS Streamable HTTP MCP endpoint.</p>
                  </div>
                </div>
                <div className={styles.fieldGrid}>
                  <label className={styles.field} htmlFor="mcp-servers-name-input">
                    Server name
                    <input
                      id="mcp-servers-name-input"
                      type="text"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      {...{ 'data-testid': 'mcp-servers-name-input' }}
                    />
                  </label>
                  <label className={styles.field} htmlFor="mcp-servers-url-input">
                    Remote MCP URL (HTTPS)
                    <input
                      id="mcp-servers-url-input"
                      type="url"
                      value={endpointUrl}
                      placeholder="https://example.com/mcp"
                      onChange={(event) => syncEndpointIntoConfig(event.target.value)}
                      {...{ 'data-testid': 'mcp-servers-url-input' }}
                    />
                  </label>
                </div>

                <div className={styles.advancedToggleRow}>
                  <button
                    type="button"
                    className={styles.advancedToggleBtn}
                    onClick={() => setShowAdvancedJson((v) => !v)}
                    aria-expanded={showAdvancedJson}
                    {...{ 'data-testid': 'mcp-servers-toggle-json' }}
                  >
                    {showAdvancedJson ? '▾ Hide JSON configuration (url & custom headers)' : '▸ Edit raw JSON configuration (url & custom headers)'}
                  </button>
                </div>

                {showAdvancedJson && (
                  <>
                    <label className={styles.field} htmlFor="mcp-servers-config">
                      Config
                      <textarea
                        id="mcp-servers-config"
                        className={styles.configInput}
                        rows={6}
                        value={configText}
                        onChange={(event) => handleConfigTextChange(event.target.value)}
                        spellCheck={false}
                        {...{ 'data-testid': 'mcp-servers-config' }}
                      />
                    </label>
                    <p className={styles.configNote}>JSON object with a url and headers. Apex calls this address, so it must be a public https MCP endpoint. Reference a secret as ${'{TOKEN}'}.</p>
                  </>
                )}
              </section>

              <section className={styles.detailSection}>
                <div className={styles.stepHeader}>
                  <span className={styles.stepBadge}>2</span>
                  <div>
                    <h2>Authentication</h2>
                    <p>How Apex authenticates to this MCP server on behalf of the project.</p>
                  </div>
                </div>
                <div className={styles.authChoices}>
                  <label className={authMode === 'none' ? styles.authChoiceActive : undefined}>
                    <input
                      type="radio"
                      name="mcp-auth"
                      checked={authMode === 'none'}
                      onChange={() => setAuthMode('none')}
                      {...{ 'data-testid': 'mcp-servers-auth-none' }}
                    />
                    None
                  </label>
                  <label className={authMode === 'secret' ? styles.authChoiceActive : undefined}>
                    <input
                      type="radio"
                      name="mcp-auth"
                      checked={authMode === 'secret'}
                      onChange={() => setAuthMode('secret')}
                      {...{ 'data-testid': 'mcp-servers-auth-secret' }}
                    />
                    Secret or header
                  </label>
                  <label className={authMode === 'oauth' ? styles.authChoiceActive : undefined}>
                    <input
                      type="radio"
                      name="mcp-auth"
                      checked={authMode === 'oauth'}
                      onChange={() => setAuthMode('oauth')}
                      {...{ 'data-testid': 'mcp-servers-auth-oauth' }}
                    />
                    OAuth sign-in
                  </label>
                </div>

                {authMode === 'secret' && (
                  <div className={styles.secretSubsection}>
                    <h3>Encrypted Secrets</h3>
                    <p className={styles.configNote}>
                      Add secrets here and reference them in headers as <code>${'{SECRET_NAME}'}</code>. Secrets are stored encrypted with AES-256-GCM and never exposed to the model.
                    </p>
                    <div className={styles.inlineAdd}>
                      <input
                        type="text"
                        value={secretName}
                        placeholder="Secret name (e.g. TOKEN)"
                        onChange={(event) => setSecretName(event.target.value)}
                        {...{ 'data-testid': 'mcp-servers-secret-name' }}
                      />
                      <input
                        type="password"
                        value={secretValue}
                        placeholder="Secret value"
                        onChange={(event) => setSecretValue(event.target.value)}
                        {...{ 'data-testid': 'mcp-servers-secret-value' }}
                      />
                      <button type="button" className={gridStyles.buttonGhost} onClick={addSecret} {...{ 'data-testid': 'mcp-servers-add-secret' }}>
                        Add secret
                      </button>
                    </div>
                    {savedSecretNames.length === 0 && secrets.length === 0 ? (
                      <p>No secrets attached to this MCP server.</p>
                    ) : (
                      <ul className={styles.chipList}>
                        {savedSecretNames.map((secret) => (
                          <li key={secret}>
                            <span>{secret}</span>
                            <button
                              type="button"
                              onClick={() => setSavedSecretNames((current) => current.filter((item) => item !== secret))}
                              {...{ 'data-testid': `mcp-servers-remove-saved-secret-${secret}` }}
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                        {secrets.map((secret) => (
                          <li key={secret.name}>
                            <span>{secret.name}</span>
                            <button
                              type="button"
                              onClick={() => setSecrets((current) => current.filter((item) => item.name !== secret.name))}
                              {...{ 'data-testid': `mcp-servers-remove-secret-${secret.name}` }}
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {authMode === 'oauth' && (
                  <div className={styles.oauthBox}>
                    <p {...{ 'data-testid': 'mcp-servers-oauth-note' }}>
                      {oauthConnected
                        ? 'Signed in. Test the server to load its tools.'
                        : 'Apex sends you to the provider to approve access, then stores the token encrypted.'}
                    </p>
                    <button
                      type="button"
                      className={styles.connectButton}
                      onClick={() => { void startSignIn(); }}
                      disabled={saving}
                      {...{ 'data-testid': 'mcp-servers-oauth-signin' }}
                    >
                      <Lock size={14} /> Sign in
                    </button>
                  </div>
                )}
                {oauthNotice && <p {...{ 'data-testid': 'mcp-servers-oauth-notice' }}>{oauthNotice}</p>}
              </section>

              <section className={styles.detailSection}>
                <div className={styles.stepHeader}>
                  <span className={styles.stepBadge}>3</span>
                  <div>
                    <h2>Allowed Tools</h2>
                    <p>Choose which read-only tools this project can use in chat. Write tools are never exposed.</p>
                  </div>
                </div>
                {discoveredTools.length > 0 ? (
                  <>
                    <div className={styles.toolGovernanceToolbar}>
                      <label className={styles.allowAllTools}>
                        <input
                          type="checkbox"
                          checked={allowAllTools}
                          onChange={toggleAllowAll}
                          {...{ 'data-testid': 'mcp-servers-allow-all-tools' }}
                        />
                        Allow all read-only tools ({discoveredTools.length})
                      </label>
                      <input
                        type="search"
                        className={styles.toolFilterInput}
                        value={toolSearch}
                        placeholder="Filter discovered tools…"
                        onChange={(event) => setToolSearch(event.target.value)}
                        {...{ 'data-testid': 'mcp-servers-tool-filter' }}
                      />
                    </div>
                    <ul className={styles.toolChoices}>
                      {filteredDiscoveredTools.map((tool) => (
                        <li key={tool.id} className={styles.toolChoiceItem}>
                          <label>
                            <input
                              type="checkbox"
                              checked={toolIsChecked(tool.id)}
                              onChange={() => toggleTool(tool.id)}
                              {...{ 'data-testid': `mcp-servers-tool-${tool.id}` }}
                            />
                            <span>{tool.summary ? `${tool.id} — ${tool.summary}` : tool.id}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <>
                    <p>Test this server to load its tools. Until then, leave this empty to allow every read-only tool it publishes.</p>
                    <div className={styles.inlineAdd}>
                      <input
                        type="text"
                        value={toolDraft}
                        placeholder="Enter tool name"
                        onChange={(event) => setToolDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            addTool();
                          }
                        }}
                        {...{ 'data-testid': 'mcp-servers-tool-name' }}
                      />
                      <button type="button" className={gridStyles.buttonGhost} onClick={addTool} {...{ 'data-testid': 'mcp-servers-add-tool' }}>
                        Add
                      </button>
                    </div>
                    {toolNames.length === 0 ? (
                      <p>No tools restricted. Read-only tools from this server will be available.</p>
                    ) : (
                      <ul className={styles.chipList}>
                        {toolNames.map((toolName) => (
                          <li key={toolName}>
                            <span>{toolName}</span>
                            <button
                              type="button"
                              onClick={() => {
                                const next = toolNames.filter((item) => item !== toolName);
                                setToolNames(next);
                                if (next.length === 0) setAllowAllTools(true);
                              }}
                              {...{ 'data-testid': `mcp-servers-remove-tool-${toolName}` }}
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </section>
            </form>
          ) : (
            <div className={styles.editorEmpty}>
              <Server size={28} />
              <h2>No server selected</h2>
              <p>Select an MCP server on the left or click Add MCP Server, configure its endpoint and authentication, and test it to discover its read-only tools.</p>
            </div>
          )}
        </div>
      </div>

      {canManage && pendingDeleteId && (
        <ConfirmDeleteModal
          title="Remove this MCP server"
          itemName={mcpServers.connections.find((connection) => connection.id === pendingDeleteId)?.name ?? 'this server'}
          onConfirm={() => {
            void mcpServers.deleteConnection(pendingDeleteId);
            setPendingDeleteId(null);
          }}
          onCancel={() => setPendingDeleteId(null)}
          {...{ 'data-testid': 'mcp-servers-delete-dialog' }}
        />
      )}
    </section>
  );
  // @feature-flag:mcp-servers enabled-end
  // @feature-flag:mcp-servers end
};
