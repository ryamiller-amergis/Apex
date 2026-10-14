import React, { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type {
  PlaybookDefinitionDetail,
  PlaybookGraph,
} from '../../shared/types/playbook';
import {
  PlaybookApiError,
  usePublishPlaybookDraft,
  useSavePlaybookDraft,
} from '../hooks/usePlaybookDefinitions';
import styles from './PlaybookDefinition.module.css';

const draftSchema = z.object({
  name: z.string().trim().min(1, 'Definition name is required.'),
  description: z.string(),
  graphJson: z.string().superRefine((value, context) => {
    try {
      const graph = JSON.parse(value) as Partial<PlaybookGraph>;
      if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Graph JSON must contain nodes and edges arrays.',
        });
      }
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Graph must be valid JSON.' });
    }
  }),
});

type DraftFormValues = z.infer<typeof draftSchema>;

interface PlaybookDraftEditorProps {
  project: string;
  detail: PlaybookDefinitionDetail;
  canAuthor: boolean;
  reload: () => Promise<unknown>;
}

function valuesFromDetail(detail: PlaybookDefinitionDetail): DraftFormValues {
  return {
    name: detail.definition.name,
    description: detail.definition.description ?? '',
    graphJson: JSON.stringify(detail.draft.graph, null, 2),
  };
}

export const PlaybookDraftEditor: React.FC<PlaybookDraftEditorProps> = ({
  project,
  detail,
  canAuthor,
  reload,
}) => {
  const save = useSavePlaybookDraft(project, detail.definition.id);
  const publish = usePublishPlaybookDraft(project, detail.definition.id);
  const [savedRevision, setSavedRevision] = useState(detail.draft.updatedAt);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [status, setStatus] = useState('');
  const conflictRef = useRef<HTMLDivElement | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<DraftFormValues>({
    resolver: zodResolver(draftSchema),
    mode: 'onChange',
    defaultValues: valuesFromDetail(detail),
  });

  useEffect(() => {
    setSavedRevision(detail.draft.updatedAt);
    reset(valuesFromDetail(detail));
  }, [detail, reset]);

  const showMutationError = (error: unknown) => {
    const isConflict = error instanceof PlaybookApiError && error.status === 409;
    setConflict(isConflict);
    setActionError(isConflict ? null : error instanceof Error ? error.message : 'Request failed.');
    if (isConflict) {
      window.setTimeout(() => conflictRef.current?.focus(), 0);
    }
  };

  const saveDraft = handleSubmit(async (values) => {
    setActionError(null);
    setConflict(false);
    setStatus('');
    try {
      const result = await save.mutateAsync({
        name: values.name.trim(),
        description: values.description.trim(),
        graph: JSON.parse(values.graphJson) as PlaybookGraph,
        expectedDraftUpdatedAt: savedRevision,
      });
      setSavedRevision(result.draft.updatedAt);
      reset({
        name: result.definition.name,
        description: result.definition.description ?? '',
        graphJson: JSON.stringify(result.draft.graph, null, 2),
      });
      setStatus('Draft saved.');
    } catch (error) {
      showMutationError(error);
    }
  });

  const publishDraft = async () => {
    setActionError(null);
    setConflict(false);
    setStatus('');
    try {
      const result = await publish.mutateAsync({ expectedDraftUpdatedAt: savedRevision });
      setSavedRevision(result.draft.updatedAt);
      setStatus(`Version ${result.publishedVersion.versionNumber} published. Draft retained.`);
    } catch (error) {
      showMutationError(error);
    }
  };

  const reloadDraft = async () => {
    await reload();
    setConflict(false);
    setActionError(null);
    setStatus('Draft reloaded.');
  };

  const graphErrorId = `playbook-graph-error-${detail.definition.id}`;

  return (
    <form
      className={styles.form}
      onSubmit={(event) => void saveDraft(event)}
      {...{ 'data-testid': 'playbook-draft-form' }}
    >
      <label className={styles.label}>
        Definition name
        <input
          className={styles.field}
          readOnly={!canAuthor}
          {...register('name')}
          {...{ 'data-testid': 'playbook-definition-name' }}
        />
      </label>
      {errors.name ? <p className={styles.error}>{errors.name.message}</p> : null}

      <label className={styles.label}>
        Description
        <input
          className={styles.field}
          readOnly={!canAuthor}
          {...register('description')}
          {...{ 'data-testid': 'playbook-definition-description' }}
        />
      </label>

      <label className={styles.label} htmlFor="playbook-draft-graph">
        Draft graph JSON
      </label>
      <textarea
        id="playbook-draft-graph"
        className={styles.editor}
        readOnly={!canAuthor}
        aria-describedby={graphErrorId}
        {...register('graphJson')}
        {...{ 'data-testid': 'playbook-draft-editor' }}
      />
      <p id={graphErrorId} className={styles.error}>
        {errors.graphJson?.message}
      </p>

      {conflict ? (
        <div
          ref={conflictRef}
          className={styles.conflict}
          role="alert"
          tabIndex={-1}
          {...{ 'data-testid': 'playbook-draft-conflict' }}
        >
          This draft changed on the server. Reload the draft before saving or publishing.
          <button
            type="button"
            className={styles.button}
            onClick={() => void reloadDraft()}
            {...{ 'data-testid': 'playbook-draft-conflict-reload' }}
          >
            Reload draft
          </button>
        </div>
      ) : null}
      {actionError ? <p className={styles.error} role="alert">{actionError}</p> : null}
      <div
        className={styles.status}
        aria-live="polite"
        {...{ 'data-testid': 'playbook-definition-status' }}
      >
        {status}
      </div>

      {canAuthor ? (
        <div className={styles.actions}>
          <button
            type="submit"
            className={styles.button}
            disabled={save.isPending || publish.isPending}
            {...{ 'data-testid': 'playbook-draft-save' }}
          >
            {save.isPending ? 'Saving…' : 'Save draft'}
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() => void publishDraft()}
            disabled={isDirty || save.isPending || publish.isPending}
            {...{ 'data-testid': 'playbook-draft-publish' }}
          >
            {publish.isPending ? 'Publishing…' : 'Publish'}
          </button>
        </div>
      ) : null}
    </form>
  );
};

export default PlaybookDraftEditor;
