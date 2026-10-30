import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { BrainstormSourceOptionsDto } from '../../shared/types/brainstormSources';
import { BrainstormApiError } from '../hooks/useBrainstormSessions';
import styles from './BrainstormSourcesPanel.module.css';

const temporarySchema = z.object({
  cloneUrl: z.string().trim().min(1, 'Enter a repository URL.'),
  revision: z.string().trim().min(1, 'Enter a revision.'),
});

type AddSourcePane = 'project-repository' | 'temporary-repository' | 'mcp-servers';

interface BrainstormAddSourceModalProps {
  open: boolean;
  options: BrainstormSourceOptionsDto | undefined;
  optionsError: string | null;
  pending: boolean;
  serverError: string | null;
  onClose: () => void;
  onAttach: (body: Record<string, string>) => void;
}

export const BrainstormAddSourceModal: React.FC<BrainstormAddSourceModalProps> = ({
  open,
  options,
  optionsError,
  pending,
  serverError,
  onClose,
  onAttach,
}) => {
  const [tab, setTab] = useState<AddSourcePane>('project-repository');
  const [skillSettingsId, setSkillSettingsId] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const form = useForm<{ cloneUrl: string; revision: string }>({ defaultValues: { cloneUrl: '', revision: '' } });
  if (!open) return null;
  const urlError = form.formState.errors.cloneUrl?.message;
  const revisionError = form.formState.errors.revision?.message;

  const submitTemporary = form.handleSubmit((values) => {
    const parsed = temporarySchema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'cloneUrl' || field === 'revision') {
          form.setError(field, { message: issue.message });
        }
      }
      const first = parsed.error.issues[0]?.path[0];
      if (first === 'revision') form.setFocus('revision');
      else form.setFocus('cloneUrl');
      return;
    }
    onAttach({ kind: 'temporary-repository', cloneUrl: parsed.data.cloneUrl, revision: parsed.data.revision });
  });

  return (
    <div className={styles.backdrop}>
      <button type="button" className={styles.backdropButton} aria-label="Close add source" onClick={onClose} {...{ 'data-testid': 'brainstorm-add-source-backdrop' }} />
      <form
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="brainstorm-add-source-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (tab === 'temporary-repository') void submitTemporary();
          else if (tab === 'project-repository' && skillSettingsId) onAttach({ kind: 'project-repository', skillSettingsId });
          else if (tab === 'mcp-servers' && connectionId) onAttach({ kind: 'mcp-server', connectionId });
        }}
        {...{ 'data-testid': 'brainstorm-add-source-modal' }}
      >
        <h2 id="brainstorm-add-source-title">Add a source</h2>
        <div className={styles.tabs} role="tablist">
          <button type="button" className={styles.tab} role="tab" aria-selected={tab === 'project-repository'} onClick={() => setTab('project-repository')} {...{ 'data-testid': 'brainstorm-add-source-tab-project-repository' }}>Project repository</button>
          <button type="button" className={styles.tab} role="tab" aria-selected={tab === 'temporary-repository'} onClick={() => setTab('temporary-repository')} {...{ 'data-testid': 'brainstorm-add-source-tab-temporary-repository' }}>Temporary repository</button>
          <button type="button" className={styles.tab} role="tab" aria-selected={tab === 'mcp-servers'} onClick={() => setTab('mcp-servers')} {...{ 'data-testid': 'brainstorm-add-source-tab-mcp-servers' }}>MCP servers</button>
        </div>
        {optionsError && <p className={styles.error} role="alert">{optionsError}</p>}
        {tab === 'project-repository' && (
          <label className={styles.field}>
            Repository
            {(options?.catalog ?? []).length === 0 ? (
              <p className={styles.empty} {...{ 'data-testid': 'brainstorm-catalog-empty' }}>
                No repositories yet. An administrator adds them on the Brainstorm page.
              </p>
            ) : (
              <select
                value={skillSettingsId}
                onChange={(event) => setSkillSettingsId(event.target.value)}
                {...{ 'data-testid': 'brainstorm-project-repo-select' }}
              >
                <option value="">Select a repository</option>
                {(options?.catalog ?? []).map((repo) => (
                  <option key={repo.skillSettingsId} value={repo.skillSettingsId} disabled={!repo.ready || repo.alreadyAttached}>
                    {repo.displayName} — {repo.readinessText}
                  </option>
                ))}
              </select>
            )}
          </label>
        )}
        {tab === 'temporary-repository' && (
          <>
            <p className={styles.notice} {...{ 'data-testid': 'brainstorm-temp-public-note' }}>
              Public repositories only. Do not include a password. A private repository is added by an administrator on the Brainstorm page.
            </p>
            <label className={styles.field} htmlFor="brainstorm-temp-url">
              Repository URL
              <input
                id="brainstorm-temp-url"
                aria-describedby={urlError ? 'brainstorm-temp-url-error' : undefined}
                {...form.register('cloneUrl')}
                {...{ 'data-testid': 'brainstorm-temp-repo-url-input' }}
              />
            </label>
            {urlError && <p id="brainstorm-temp-url-error" className={styles.error} role="alert">{urlError}</p>}
            <label className={styles.field} htmlFor="brainstorm-temp-revision">
              Revision
              <input
                id="brainstorm-temp-revision"
                aria-describedby="brainstorm-temp-revision-hint"
                {...form.register('revision')}
                {...{ 'data-testid': 'brainstorm-temp-repo-revision-input' }}
              />
            </label>
            <p id="brainstorm-temp-revision-hint" className={styles.empty}>
              {revisionError || 'Use the full 40-character commit ID, or a branch or tag name.'}
            </p>
          </>
        )}
        {tab === 'mcp-servers' && (
          options?.mcpEnabled === false ? (
            <p>MCP servers are off for this project.</p>
          ) : (
            <div className={styles.list}>
              {(options?.mcpServers ?? []).map((server) => (
                <button
                  key={server.connectionId}
                  type="button"
                  className={styles.button}
                  aria-pressed={connectionId === server.connectionId}
                  disabled={server.alreadyAttached || server.readOnlyToolCount === 0}
                  onClick={() => setConnectionId(server.connectionId)}
                  {...{ 'data-testid': `brainstorm-mcp-toggle-${server.connectionId}` }}
                >
                  {server.displayName} — Read-only tools: {server.readOnlyToolCount}
                </button>
              ))}
            </div>
          )
        )}
        {serverError && <p className={styles.error} role="alert">{serverError}</p>}
        <div className={styles.actions}>
          <button type="button" className={styles.button} onClick={onClose} {...{ 'data-testid': 'brainstorm-add-source-cancel' }}>Cancel</button>
          <button type="submit" className={`${styles.button} ${styles.primary}`} disabled={pending} {...{ 'data-testid': 'brainstorm-attach-source-button' }}>
            Attach
          </button>
        </div>
      </form>
    </div>
  );
};

export function attachErrorMessage(error: unknown): string {
  if (error instanceof BrainstormApiError) return error.message;
  return 'The source could not be attached.';
}
