import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAppShell } from '../hooks/useAppShell';
import { useIntegrations } from '../hooks/useIntegrations';
import { DataGridFilterPills, DataGridToolbar } from './DataGridToolbar';
import gridStyles from './DataGrid.module.css';
import styles from './IntegrationsView.module.css';
import { PREBUILT_PROVIDER_IDS, type IntegrationOperation } from '../../shared/types/integrations';

const createSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  provider: z.enum(['clerk', 'pendo', 'sendgrid', 'custom']),
  credential: z.string().min(1, 'Credential is required'),
  allowedUserIds: z.string(),
  baseUrl: z.string().optional(),
  openApi: z.string().optional(),
  operationId: z.string().optional(),
  operationPath: z.string().optional(),
  operationSummary: z.string().optional(),
});

type CreateValues = z.infer<typeof createSchema>;

const accessSchema = z.object({
  allowedUserIds: z.string(),
});

type AccessValues = z.infer<typeof accessSchema>;

interface IntegrationsViewProps {
  project: string;
  enabled: boolean;
  menuEnabled: boolean;
}

function Unavailable(): React.ReactElement {
  return (
    <section className={styles.unavailable} {...{ 'data-testid': 'integrations-unavailable' }}>
      <h1>Integrations is not available</h1>
      <p>This project does not have Integrations turned on.</p>
    </section>
  );
}

export const IntegrationsView: React.FC<IntegrationsViewProps> = ({ project, enabled, menuEnabled }) => {
  const [search, setSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState<'all' | 'clerk' | 'pendo' | 'sendgrid'>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [draftReadOnly, setDraftReadOnly] = useState(false);
  const [operations, setOperations] = useState<IntegrationOperation[]>([]);
  const { can, isSuperAdmin } = useAppShell();
  const integrations = useIntegrations(project);
  const createForm = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      name: '',
      provider: 'clerk',
      credential: '',
      allowedUserIds: '',
      baseUrl: '',
      openApi: '',
      operationId: '',
      operationPath: '',
      operationSummary: '',
    },
  });
  const provider = createForm.watch('provider');
  const accessForm = useForm<AccessValues>({
    resolver: zodResolver(accessSchema),
    defaultValues: { allowedUserIds: '' },
  });
  // Records the selected connection on a thread and returns that connector's
  // read result. A live model session would call a provider outside this allow-list.
  const askForm = useForm<{ connectionId: string; question: string }>({
    defaultValues: { connectionId: '', question: '' },
  });

  const canView = Boolean(isSuperAdmin) || can('integrations:view');
  const canManage = Boolean(isSuperAdmin) || can('integrations:manage');

  // @feature-flag:integrations start winner=enabled
  if (!enabled) {
    // @feature-flag:integrations disabled-start
    return <Unavailable />;
    // @feature-flag:integrations disabled-end
  }

  // @feature-flag:integrations enabled-start
  if (!menuEnabled || !canView) {
    return <Unavailable />;
  }

  const visible = integrations.connections.filter((connection) => {
    const matchesProvider = providerFilter === 'all' || connection.provider === providerFilter;
    const matchesSearch = connection.name.toLowerCase().includes(search.trim().toLowerCase());
    return matchesProvider && matchesSearch;
  });
  const editing = integrations.connections.find((connection) => connection.id === editingId) ?? null;

  const addOperation = () => {
    const id = createForm.getValues('operationId')?.trim() ?? '';
    const path = createForm.getValues('operationPath')?.trim() ?? '';
    const summary = createForm.getValues('operationSummary')?.trim() ?? '';
    if (!draftReadOnly || !id || !path) return;
    setOperations((current) => [
      ...current,
      { id, method: 'GET', path, summary: summary || id, readOnly: true },
    ]);
  };

  const onCreate = createForm.handleSubmit(async (values) => {
    const allowedUserIds = values.allowedUserIds.split(',').map((id) => id.trim()).filter(Boolean);
    if (values.provider === 'custom') {
      const openApiText = values.openApi?.trim() ?? '';
      if (operations.length === 0 && !openApiText) return;
      let openApiDocument: unknown;
      if (openApiText) {
        try {
          openApiDocument = JSON.parse(openApiText);
        } catch {
          return;
        }
      }
      await integrations.createConnection({
        name: values.name,
        provider: 'custom',
        credential: values.credential,
        allowedUserIds,
        baseUrl: values.baseUrl?.trim(),
        operations: operations.length > 0 ? operations : undefined,
        openApiDocument,
      });
    } else {
      await integrations.createConnection({
        name: values.name,
        provider: values.provider,
        credential: values.credential,
        allowedUserIds,
      });
    }
    setOperations([]);
    setDraftReadOnly(false);
    createForm.reset();
  });

  const onAsk = askForm.handleSubmit(async (values) => {
    await integrations.ask({ connectionId: values.connectionId, question: values.question });
  });

  const onSaveAccess = accessForm.handleSubmit(async (values) => {
    if (!editing) return;
    await integrations.updateAccess(editing.id, {
      allowedUserIds: values.allowedUserIds.split(',').map((id) => id.trim()).filter(Boolean),
    });
    setEditingId(null);
  });

  return (
    <section className={`${gridStyles.section} ${styles.page}`} {...{ 'data-testid': 'integrations-screen' }}>
      <div className={gridStyles.header}>
        <div>
          <h1 className={gridStyles.title}>Integrations</h1>
          <p className={gridStyles.hint}>
            Connections belong to this project. Credentials stay encrypted and are never shown again.
          </p>
        </div>
      </div>

      {canManage && (
        <form className={styles.form} onSubmit={onCreate} {...{ 'data-testid': 'integrations-create-form' }}>
          <label className={styles.field}>
            Name
            <input type="text" {...createForm.register('name')} {...{ 'data-testid': 'integrations-name-input' }} />
          </label>
          <label className={styles.field}>
            Provider
            <select {...createForm.register('provider')} {...{ 'data-testid': 'integrations-provider-select' }}>
              {PREBUILT_PROVIDER_IDS.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
              <option value="custom">custom</option>
            </select>
          </label>
          <label className={styles.field}>
            Credential
            <input type="password" {...createForm.register('credential')} {...{ 'data-testid': 'integrations-credential-input' }} />
          </label>
          <label className={styles.field}>
            Who can use it
            <input
              type="text"
              placeholder="user ids, comma separated"
              {...createForm.register('allowedUserIds')}
              {...{ 'data-testid': 'integrations-allowed-users-input' }}
            />
          </label>
          {provider === 'custom' && (
            <>
              <label className={styles.field}>
                Base URL
                <input type="url" {...createForm.register('baseUrl')} {...{ 'data-testid': 'integrations-custom-base-url' }} />
              </label>
              <label className={styles.field}>
                OpenAPI document
                <textarea rows={4} {...createForm.register('openApi')} {...{ 'data-testid': 'integrations-openapi' }} />
              </label>
              <label className={styles.field}>
                Operation id
                <input type="text" {...createForm.register('operationId')} {...{ 'data-testid': 'integrations-operation-id' }} />
              </label>
              <label className={styles.field}>
                Operation path
                <input type="text" {...createForm.register('operationPath')} {...{ 'data-testid': 'integrations-operation-path' }} />
              </label>
              <label className={styles.field}>
                Summary
                <input type="text" {...createForm.register('operationSummary')} {...{ 'data-testid': 'integrations-operation-summary' }} />
              </label>
              <label className={styles.field}>
                Read only
                <input
                  type="checkbox"
                  checked={draftReadOnly}
                  onChange={(event) => setDraftReadOnly(event.target.checked)}
                  {...{ 'data-testid': 'integrations-readonly' }}
                />
              </label>
              <button type="button" className={gridStyles.buttonGhost} onClick={addOperation} {...{ 'data-testid': 'integrations-add-operation' }}>
                Add operation
              </button>
            </>
          )}
          <button type="submit" className={gridStyles.buttonPrimary} {...{ 'data-testid': 'integrations-save' }}>
            Save connection
          </button>
        </form>
      )}

      <DataGridToolbar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search connections"
        searchTestId="integrations-search"
      >
        <DataGridFilterPills
          aria-label="Provider"
          testIdPrefix="integrations-provider-filter"
          value={providerFilter}
          onChange={setProviderFilter}
          {...{ 'data-testid': 'integrations-provider-filters' }}
          options={[
            { label: 'All', value: 'all' },
            { label: 'Clerk', value: 'clerk' },
            { label: 'Pendo', value: 'pendo' },
            { label: 'SendGrid', value: 'sendgrid' },
          ]}
        />
      </DataGridToolbar>

      {integrations.isLoading && <p className={gridStyles.loading}>Loading connections…</p>}
      {integrations.error && <p className={gridStyles.error}>{integrations.error}</p>}

      <div className={gridStyles.tableWrap}>
        <table className={gridStyles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Provider</th>
              <th>Status</th>
              <th>Credential</th>
              {canManage && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={canManage ? 5 : 4} className={gridStyles.empty} {...{ 'data-testid': 'integrations-empty' }}>
                  No connections for this project.
                </td>
              </tr>
            )}
            {visible.map((connection) => (
              <tr key={connection.id} {...{ 'data-testid': 'integrations-connection-row' }}>
                <td>{connection.name}</td>
                <td>{connection.provider}</td>
                <td>{connection.status === 'usable' ? 'Usable' : 'Untested'}</td>
                <td {...{ 'data-testid': `integrations-hint-${connection.id}` }}>{connection.credentialHint}</td>
                {canManage && (
                  <td className={gridStyles.rowActions}>
                    <button
                      type="button"
                      className={gridStyles.buttonGhost}
                      onClick={() => { void integrations.testConnection(connection.id); }}
                      {...{ 'data-testid': `integrations-test-${connection.id}` }}
                    >
                      Test
                    </button>
                    <button
                      type="button"
                      className={gridStyles.buttonGhost}
                      onClick={() => {
                        setEditingId(connection.id);
                        accessForm.reset({ allowedUserIds: connection.allowedUserIds.join(', ') });
                      }}
                      {...{ 'data-testid': `integrations-edit-access-${connection.id}` }}
                    >
                      Edit access
                    </button>
                    <button
                      type="button"
                      className={gridStyles.buttonGhost}
                      onClick={() => setPendingDeleteId(connection.id)}
                      {...{ 'data-testid': `integrations-delete-${connection.id}` }}
                    >
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canManage && editing && (
        <form className={styles.form} onSubmit={onSaveAccess} {...{ 'data-testid': 'integrations-access-form' }}>
          <label className={styles.field}>
            Who can use {editing.name}
            <input type="text" {...accessForm.register('allowedUserIds')} {...{ 'data-testid': 'integrations-access-users' }} />
          </label>
          <button type="submit" className={gridStyles.buttonPrimary} {...{ 'data-testid': 'integrations-access-save' }}>
            Save access
          </button>
          <button type="button" className={gridStyles.buttonGhost} onClick={() => setEditingId(null)} {...{ 'data-testid': 'integrations-access-cancel' }}>
            Cancel
          </button>
        </form>
      )}

      <form className={styles.form} onSubmit={onAsk} {...{ 'data-testid': 'integrations-ask-form' }}>
        <label className={styles.field}>
          Connection
          <select {...askForm.register('connectionId')} {...{ 'data-testid': 'integrations-connection-select' }}>
            <option value="">Select a connection</option>
            {integrations.connections.map((connection) => (
              <option key={connection.id} value={connection.id}>{connection.name}</option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          Question
          <textarea
            rows={3}
            {...askForm.register('question')}
            {...{ 'data-testid': 'integrations-question' }}
          />
        </label>
        <button type="submit" className={gridStyles.buttonPrimary} {...{ 'data-testid': 'integrations-ask' }}>
          Ask
        </button>
      </form>
      {integrations.answer && (
        <p className={styles.answer} {...{ 'data-testid': 'integrations-answer' }}>{integrations.answer}</p>
      )}

      {canManage && pendingDeleteId && (
        <dialog open className={styles.dialog} {...{ 'data-testid': 'integrations-delete-dialog' }}>
          <p>Remove this connection?</p>
          <div className={styles.dialogActions}>
            <button
              type="button"
              className={gridStyles.buttonPrimary}
              onClick={() => {
                void integrations.deleteConnection(pendingDeleteId);
                setPendingDeleteId(null);
              }}
              {...{ 'data-testid': 'integrations-delete-confirm' }}
            >
              Remove
            </button>
            <button
              type="button"
              className={gridStyles.buttonGhost}
              onClick={() => setPendingDeleteId(null)}
              {...{ 'data-testid': 'integrations-delete-cancel' }}
            >
              Cancel
            </button>
          </div>
        </dialog>
      )}
    </section>
  );
  // @feature-flag:integrations enabled-end
  // @feature-flag:integrations end
};
