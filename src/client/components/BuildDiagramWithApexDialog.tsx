import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { GenerateDiagramResponse } from '../../shared/types/diagram';
import { useGenerateDiagram } from '../hooks/useGenerateDiagram';
import { AiSparkleIcon } from './AiSparkleIcon';
import styles from './BuildDiagramWithApexDialog.module.css';

const formSchema = z.object({
  prompt: z.string()
    .trim()
    .min(1, 'Describe the Diagram you want Apex to build.')
    .max(4_000, 'Keep the concept to 4,000 characters or fewer.'),
});

type FormValues = z.infer<typeof formSchema>;

interface BuildDiagramWithApexDialogProps {
  projectId: string;
  onApply: (result: GenerateDiagramResponse) => void | Promise<void>;
  onClose: () => void;
}

export const BuildDiagramWithApexDialog: React.FC<BuildDiagramWithApexDialogProps> = ({
  projectId,
  onApply,
  onClose,
}) => {
  const [applyError, setApplyError] = useState<string | null>(null);
  const generation = useGenerateDiagram(projectId);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { prompt: '' },
  });

  const submit = handleSubmit(async (values) => {
    setApplyError(null);
    try {
      const result = await generation.mutateAsync(values);
      await onApply(result);
    } catch (error) {
      // Keep the dialog open and the current draft untouched. Mutation errors
      // land on generation.error; apply/materialize errors need local state.
      setApplyError(
        error instanceof Error && error.message
          ? error.message
          : 'Apex could not build that Diagram',
      );
    }
  });

  return (
    <div className={styles.backdrop}>
      <dialog
        open
        className={styles.dialog}
        aria-labelledby="diagram-ai-title"
        {...{ 'data-testid': 'diagram-ai-dialog' }}
      >
        <div className={styles.heading}>
          <span className={styles.sparkleWrap} aria-hidden="true">
            <AiSparkleIcon size={18} />
          </span>
          <div>
            <h2 id="diagram-ai-title">Build with Apex</h2>
            <p>Describe the system, process, or idea you want to map.</p>
          </div>
        </div>

        <form
          className={styles.form}
          onSubmit={(event) => { void submit(event); }}
          {...{ 'data-testid': 'diagram-ai-form' }}
        >
          <label htmlFor="diagram-ai-prompt">Diagram concept</label>
          <textarea
            id="diagram-ai-prompt"
            rows={6}
            placeholder="Example: Show the release flow from pull request through production deployment"
            disabled={generation.isPending}
            {...register('prompt')}
            {...{ 'data-testid': 'diagram-ai-prompt' }}
          />
          {errors.prompt && (
            <p className={styles.error} role="alert">
              {errors.prompt.message}
            </p>
          )}
          {(generation.error || applyError) && (
            <p
              className={styles.error}
              role="alert"
              {...{ 'data-testid': 'diagram-ai-error' }}
            >
              {applyError ?? generation.error?.message}
            </p>
          )}

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              onClick={onClose}
              disabled={generation.isPending}
              {...{ 'data-testid': 'diagram-ai-cancel' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={styles.primary}
              disabled={generation.isPending}
              {...{ 'data-testid': 'diagram-ai-generate' }}
            >
              {generation.isPending ? 'Building…' : 'Build Diagram'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
};

export default BuildDiagramWithApexDialog;
