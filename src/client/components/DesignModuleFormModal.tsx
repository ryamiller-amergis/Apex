import React, { useEffect } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';
import { DESIGN_MODULE_ICON_OPTIONS } from '../config/designModuleIcons';
import {
  useCreateDesignModule,
  useUpdateDesignModule,
} from '../hooks/useDesignModules';
import type { DesignModule } from '../../shared/types/designModule';
import styles from './DesignModuleFormModal.module.css';

const formSchema = z.object({
  label: z.string().trim().min(1, 'Label is required'),
  slug: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'Use lowercase letters, numbers, and hyphens'
    ),
  description: z.string(),
  iconKey: z.enum([
    'chat',
    'interview',
    'pdf',
    'analysis',
    'infra',
    'cicd',
    'rbac',
    'default',
  ]),
  sourceGlobs: z
    .array(
      z.object({ value: z.string().trim().min(1, 'Source path is required') })
    )
    .min(1),
});

type FormValues = z.infer<typeof formSchema>;

interface DesignModuleFormModalProps {
  module?: DesignModule | null;
  onClose: () => void;
  onSaved: (slug: string) => void;
}

export const DesignModuleFormModal: React.FC<DesignModuleFormModalProps> = ({
  module,
  onClose,
  onSaved,
}) => {
  const createModule = useCreateDesignModule();
  const updateModule = useUpdateDesignModule();
  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      label: module?.label ?? '',
      slug: module?.slug ?? '',
      description: module?.description ?? '',
      iconKey: module?.iconKey ?? 'default',
      sourceGlobs: (module?.sourceGlobs ?? ['']).map((value) => ({ value })),
    },
  });
  const { fields, append, remove } = useFieldArray({
    control,
    name: 'sourceGlobs',
  });

  useEffect(() => {
    reset({
      label: module?.label ?? '',
      slug: module?.slug ?? '',
      description: module?.description ?? '',
      iconKey: module?.iconKey ?? 'default',
      sourceGlobs: (module?.sourceGlobs ?? ['']).map((value) => ({ value })),
    });
  }, [module, reset]);

  const pending = createModule.isPending || updateModule.isPending;
  const mutationError = createModule.error ?? updateModule.error;

  const onSubmit = handleSubmit(async (values) => {
    const input = {
      label: values.label,
      slug: values.slug,
      description: values.description || null,
      iconKey: values.iconKey,
      sourceGlobs: values.sourceGlobs.map((item) => item.value),
    };
    const saved = module
      ? await updateModule.mutateAsync({ slug: module.slug, input })
      : await createModule.mutateAsync(input);
    onSaved(saved.slug);
  });

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={onClose}>
      <section
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="design-module-form-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <div>
            <h2 id="design-module-form-title">
              {module ? 'Edit Module' : 'Add Module'}
            </h2>
            <p>
              Define the curated source scope used for architecture
              documentation.
            </p>
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <form className={styles.form} onSubmit={onSubmit}>
          <label>
            Label
            <input {...register('label')} autoFocus />
            {errors.label && (
              <span className={styles.error}>{errors.label.message}</span>
            )}
          </label>
          <label>
            Slug
            <input {...register('slug')} placeholder="module-name" />
            {errors.slug && (
              <span className={styles.error}>{errors.slug.message}</span>
            )}
          </label>
          <label>
            Description
            <textarea {...register('description')} rows={3} />
          </label>
          <label>
            Icon
            <select {...register('iconKey')}>
              {DESIGN_MODULE_ICON_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <fieldset>
            <legend>Source globs</legend>
            <p>Paths are repository-relative. Use one file or glob per row.</p>
            <div className={styles.globs}>
              {fields.map((field, index) => (
                <div key={field.id} className={styles.globRow}>
                  <input
                    {...register(`sourceGlobs.${index}.value`)}
                    placeholder="src/server/services/exampleService.ts"
                  />
                  <button
                    type="button"
                    className={styles.remove}
                    onClick={() => remove(index)}
                    disabled={fields.length === 1}
                    aria-label={`Remove source glob ${index + 1}`}
                  >
                    Remove
                  </button>
                  {errors.sourceGlobs?.[index]?.value && (
                    <span className={styles.error}>
                      {errors.sourceGlobs[index]?.value?.message}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              className={styles.addGlob}
              onClick={() => append({ value: '' })}
            >
              Add source glob
            </button>
          </fieldset>

          {mutationError && (
            <div className={styles.submitError}>{mutationError.message}</div>
          )}
          <footer className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              onClick={onClose}
            >
              Cancel
            </button>
            <button type="submit" className={styles.primary} disabled={pending}>
              {pending ? 'Saving…' : 'Save Module'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
};
