import React, { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAppShell } from '../hooks/useAppShell';
import {
  useCreatePlaybookDefinition,
  usePlaybookDefinition,
  usePlaybookDefinitions,
} from '../hooks/usePlaybookDefinitions';
import { PlaybookDraftEditor } from './PlaybookDraftEditor';
import { PlaybookVersionList } from './PlaybookVersionList';
import styles from './PlaybookDefinition.module.css';

const createSchema = z.object({
  name: z.string().trim().min(1, 'Definition name is required.'),
  description: z.string(),
});

type CreateFormValues = z.infer<typeof createSchema>;

interface PlaybookDefinitionPanelProps {
  project: string;
  'data-testid'?: string;
}

export const PlaybookDefinitionPanel: React.FC<PlaybookDefinitionPanelProps> = ({
  project,
  'data-testid': testId = 'playbook-definitions-panel',
}) => {
  const { can } = useAppShell();
  const canAuthor = can('playbooks:author');
  const definitions = usePlaybookDefinitions(project);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const detail = usePlaybookDefinition(project, selectedId);
  const create = useCreatePlaybookDefinition(project);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateFormValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: '', description: '' },
  });

  useEffect(() => {
    if (!selectedId && definitions.data?.definitions.length) {
      setSelectedId(definitions.data.definitions[0].id);
    }
  }, [definitions.data, selectedId]);

  useEffect(() => {
    setSelectedId(null);
    setCreating(false);
  }, [project]);

  const submitCreate = handleSubmit(async (values) => {
    setCreateError(null);
    try {
      const result = await create.mutateAsync({
        name: values.name.trim(),
        description: values.description.trim(),
        graph: { nodes: [], edges: [] },
      });
      setSelectedId(result.definition.id);
      setCreating(false);
      reset();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Could not create the definition.');
    }
  });

  const createButton = canAuthor ? (
    <button
      type="button"
      className={styles.button}
      onClick={() => setCreating((open) => !open)}
      {...{ 'data-testid': 'playbook-definition-create' }}
    >
      {creating ? 'Cancel create' : 'Create definition'}
    </button>
  ) : null;

  return (
    <section
      className={styles.panel}
      aria-labelledby="playbook-definitions-heading"
      {...{ 'data-testid': testId }}
    >
      <div className={styles.header}>
        <h2 id="playbook-definitions-heading" className={styles.heading}>Playbook definitions</h2>
        {definitions.data?.definitions.length ? createButton : null}
      </div>

      {creating ? (
        <form
          className={styles.form}
          onSubmit={(event) => void submitCreate(event)}
          {...{ 'data-testid': 'playbook-definition-create-form' }}
        >
          <label className={styles.label}>
            Definition name
            <input
              className={styles.field}
              {...register('name')}
              {...{ 'data-testid': 'playbook-definition-create-name' }}
            />
          </label>
          {errors.name ? <p className={styles.error}>{errors.name.message}</p> : null}
          <label className={styles.label}>
            Description
            <input
              className={styles.field}
              {...register('description')}
              {...{ 'data-testid': 'playbook-definition-create-description' }}
            />
          </label>
          {createError ? <p className={styles.error} role="alert">{createError}</p> : null}
          <button
            type="submit"
            className={styles.button}
            disabled={create.isPending}
            {...{ 'data-testid': 'playbook-definition-create-submit' }}
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </form>
      ) : null}

      {definitions.isPending ? (
        <p className={styles.loading} {...{ 'data-testid': 'playbook-definitions-loading' }}>
          Loading Playbook definitions…
        </p>
      ) : definitions.isError ? (
        <div className={styles.error} role="status" {...{ 'data-testid': 'playbook-definitions-error' }}>
          <p>Could not load Playbook definitions. {definitions.error.message}</p>
          <button
            type="button"
            className={styles.button}
            onClick={() => void definitions.refetch()}
            {...{ 'data-testid': 'playbook-definitions-retry' }}
          >
            Try again
          </button>
        </div>
      ) : definitions.data.definitions.length === 0 ? (
        <div className={styles.empty} {...{ 'data-testid': 'playbook-definition-empty-state' }}>
          <p>No Playbook definitions in this project.</p>
          {createButton}
        </div>
      ) : (
        <>
          <label className={styles.label}>
            Definition
            <select
              className={styles.selector}
              value={selectedId ?? ''}
              onChange={(event) => setSelectedId(event.target.value)}
              {...{ 'data-testid': 'playbook-definition-select' }}
            >
              {definitions.data.definitions.map((definition) => (
                <option key={definition.id} value={definition.id}>{definition.name}</option>
              ))}
            </select>
          </label>

          {!selectedId || detail.isPending ? (
            <p className={styles.loading} {...{ 'data-testid': 'playbook-definition-detail-loading' }}>
              Loading selected definition…
            </p>
          ) : detail.isError ? (
            <div className={styles.error} role="status" {...{ 'data-testid': 'playbook-definition-detail-error' }}>
              <p>Could not load this definition. {detail.error.message}</p>
              <button
                type="button"
                className={styles.button}
                onClick={() => void detail.refetch()}
                {...{ 'data-testid': 'playbook-definition-detail-retry' }}
              >
                Try again
              </button>
            </div>
          ) : detail.data ? (
            <>
              <PlaybookDraftEditor
                project={project}
                detail={detail.data}
                canAuthor={canAuthor}
                reload={detail.refetch}
              />
              <PlaybookVersionList
                project={project}
                definitionId={detail.data.definition.id}
                versions={detail.data.versions}
                currentPublishedVersionId={detail.data.currentPublishedVersionId}
                canAuthor={canAuthor}
              />
            </>
          ) : null}
        </>
      )}
    </section>
  );
};

export default PlaybookDefinitionPanel;
