import React, { useEffect, useId, useMemo, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { DESIGN_MODULE_ICON_OPTIONS } from '../config/designModuleIcons';
import {
  useCreateDesignModule,
  useUpdateDesignModule,
} from '../hooks/useDesignModules';
import { useDesignModuleScoping } from '../hooks/useDesignModuleScoping';
import { useGlobPreview } from '../hooks/useGlobPreview';
import { useProjectRepoConfigs } from '../hooks/useProjectRepoConfigs';
import type { DesignModule } from '../../shared/types/designModule';
import type {
  DesignModuleScopingConfidence,
  DesignModuleScopingGlobProposal,
} from '../../shared/types/designModuleScoping';
import { DesignModuleFileTree } from './DesignModuleFileTree';
import { DesignModuleScopingUnavailable } from './DesignModuleScopingUnavailable';
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
    .min(1, 'Add at least one source glob'),
});

type FormValues = z.infer<typeof formSchema>;

interface ProposedGlob {
  id: string;
  pattern: string;
  confidence: DesignModuleScopingConfidence;
  rationale: string;
  included: boolean;
}

interface ChatMsg {
  id: string;
  role: 'user' | 'ai';
  text: string;
}

interface DesignModuleFormModalProps {
  project: string;
  module?: DesignModule | null;
  onClose: () => void;
  onSaved: (slug: string) => void;
}

function confidenceClass(confidence: DesignModuleScopingConfidence): string {
  if (confidence === 'high') return styles.confidenceHigh;
  if (confidence === 'medium') return styles.confidenceMedium;
  return styles.confidenceLow;
}

/** URL/API id derived from the human label — users should not have to invent this. */
export function slugifyModuleLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function toProposedGlobs(
  globs: DesignModuleScopingGlobProposal[]
): ProposedGlob[] {
  return globs.map((glob, index) => ({
    id: `ai-${index}-${glob.pattern}`,
    pattern: glob.pattern,
    confidence: glob.confidence,
    rationale: glob.rationale,
    included: true,
  }));
}

export const DesignModuleFormModal: React.FC<DesignModuleFormModalProps> = ({
  project,
  module,
  onClose,
  onSaved,
}) => {
  const createModule = useCreateDesignModule();
  const updateModule = useUpdateDesignModule();
  const { data: repoConfigs = [] } = useProjectRepoConfigs(project);
  const hasConnectedRepo = repoConfigs.some((config) =>
    Boolean(config.skillRepo?.trim())
  );
  const scoping = useDesignModuleScoping(project);
  const globPreview = useGlobPreview();

  const [proposals, setProposals] = useState<ProposedGlob[]>([]);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [refineInput, setRefineInput] = useState('');
  const [previewFiles, setPreviewFiles] = useState<string[]>([]);
  const [scopingThreadId, setScopingThreadId] = useState<string | null>(
    module?.scopingThreadId ?? null
  );
  const appliedResultRef = React.useRef<DesignModuleScopingGlobProposal[] | null>(
    null
  );
  const refineFieldId = useId();

  const {
    control,
    register,
    handleSubmit,
    reset,
    setValue,
    getValues,
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

  const watchedLabel = useWatch({ control, name: 'label' });
  const watchedGlobs = useWatch({ control, name: 'sourceGlobs' });
  const isEditing = Boolean(module);
  const derivedSlug = slugifyModuleLabel(watchedLabel ?? '');

  // New modules: keep slug in sync with the label so the user never invents one.
  useEffect(() => {
    if (isEditing) return;
    setValue('slug', derivedSlug, { shouldValidate: Boolean(derivedSlug) });
  }, [derivedSlug, isEditing, setValue]);

  useEffect(() => {
    reset({
      label: module?.label ?? '',
      slug: module?.slug ?? '',
      description: module?.description ?? '',
      iconKey: module?.iconKey ?? 'default',
      sourceGlobs: (module?.sourceGlobs ?? ['']).map((value) => ({ value })),
    });
    setProposals([]);
    setChat([]);
    setRefineInput('');
    setPreviewFiles([]);
    setScopingThreadId(module?.scopingThreadId ?? null);
    appliedResultRef.current = null;
    scoping.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset scoping only when module identity changes
  }, [module, reset]);

  useEffect(() => {
    if (scoping.threadId) setScopingThreadId(scoping.threadId);
  }, [scoping.threadId]);

  useEffect(() => {
    if (scoping.status !== 'ready' || !scoping.result) return;
    if (appliedResultRef.current === scoping.result.globs) return;
    appliedResultRef.current = scoping.result.globs;
    const next = toProposedGlobs(scoping.result.globs);
    setProposals(next);
    setValue(
      'sourceGlobs',
      next.filter((g) => g.included).map((g) => ({ value: g.pattern })),
      { shouldValidate: true }
    );
    const summary =
      scoping.result.notes?.trim() ||
      `Proposed ${next.length} glob pattern${next.length === 1 ? '' : 's'}. Toggle or refine as needed.`;
    setChat((prev) => [
      ...prev,
      { id: `ai-${Date.now()}`, role: 'ai', text: summary },
    ]);
  }, [scoping.status, scoping.result, setValue]);

  const includedPatterns = useMemo(() => {
    if (proposals.length > 0) {
      return proposals.filter((g) => g.included).map((g) => g.pattern);
    }
    return (watchedGlobs ?? [])
      .map((g) => g.value?.trim())
      .filter((value): value is string => Boolean(value));
  }, [proposals, watchedGlobs]);

  useEffect(() => {
    if (includedPatterns.length === 0) {
      setPreviewFiles([]);
      return;
    }
    const timer = window.setTimeout(() => {
      globPreview.mutate(
        { sourceGlobs: includedPatterns },
        {
          onSuccess: (data) => {
            const files = Array.from(
              new Set(data.matches.flatMap((match) => match.files))
            ).sort((a, b) => a.localeCompare(b));
            setPreviewFiles(files);
          },
          onError: () => setPreviewFiles([]),
        }
      );
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mutate identity is stable enough; debounce on patterns
  }, [includedPatterns.join('\0')]);

  const pending = createModule.isPending || updateModule.isPending;
  const mutationError = createModule.error ?? updateModule.error;
  const canSuggest =
    hasConnectedRepo &&
    Boolean(watchedLabel?.trim()) &&
    !scoping.isScoping;

  const syncFormFromProposals = (next: ProposedGlob[]) => {
    setProposals(next);
    const included = next.filter((g) => g.included).map((g) => g.pattern);
    setValue(
      'sourceGlobs',
      included.length > 0 ? included.map((value) => ({ value })) : [{ value: '' }],
      { shouldValidate: true }
    );
  };

  const handleSuggest = () => {
    const values = getValues();
    void scoping.start({
      moduleSlug: module?.slug ?? (values.slug.trim() || undefined),
      threadId: scopingThreadId ?? undefined,
      name: values.label,
      description: values.description,
      currentGlobs: includedPatterns,
    });
  };

  const handleRefine = () => {
    const text = refineInput.trim();
    if (!text || !canSuggest) return;
    const values = getValues();
    setChat((prev) => [
      ...prev,
      { id: `user-${Date.now()}`, role: 'user', text },
    ]);
    setRefineInput('');
    void scoping.start({
      moduleSlug: module?.slug ?? (values.slug.trim() || undefined),
      threadId: scopingThreadId ?? undefined,
      name: values.label,
      description: values.description,
      currentGlobs: includedPatterns,
      instruction: text,
    });
  };

  const onSubmit = handleSubmit(async (values) => {
    const sourceGlobs =
      proposals.length > 0
        ? proposals.filter((g) => g.included).map((g) => g.pattern)
        : values.sourceGlobs.map((item) => item.value);
    if (sourceGlobs.length === 0) return;

    const slug = isEditing
      ? values.slug
      : slugifyModuleLabel(values.label) || values.slug;
    if (!slug) return;

    const input = {
      label: values.label,
      slug,
      description: values.description || null,
      iconKey: values.iconKey,
      sourceGlobs,
      scopingThreadId: scopingThreadId,
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
              Describe the module, then suggest or refine source globs with AI.
              Nothing is saved until you confirm.
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
          <label className={styles.nameField}>
            Name
            <input {...register('label')} autoFocus placeholder="e.g. Load Testing" />
            {errors.label && (
              <span className={styles.error}>{errors.label.message}</span>
            )}
            {isEditing ? (
              <span className={styles.slugCaption} data-testid="design-module-slug-preview">
                URL id <code>{module?.slug}</code>
                <input type="hidden" {...register('slug')} />
              </span>
            ) : (
              <span className={styles.slugCaption} data-testid="design-module-slug-preview">
                {derivedSlug ? (
                  <>
                    Saves as <code>{derivedSlug}</code>
                  </>
                ) : (
                  'URL id is generated from the name'
                )}
                <input type="hidden" {...register('slug')} />
              </span>
            )}
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

          <fieldset className={styles.scopeFieldset}>
            <legend>Source scope</legend>

            {!hasConnectedRepo ? (
              <DesignModuleScopingUnavailable />
            ) : (
              <div className={styles.aiBar}>
                <button
                  type="button"
                  className={styles.suggestBtn}
                  data-testid="design-module-suggest-ai"
                  disabled={!canSuggest}
                  onClick={handleSuggest}
                >
                  {scoping.isScoping && !refineInput
                    ? 'Suggesting…'
                    : 'Suggest files with AI'}
                </button>
                {scoping.isScoping && (
                  <button
                    type="button"
                    className={styles.secondary}
                    data-testid="design-module-scoping-cancel"
                    onClick={() => void scoping.cancel()}
                  >
                    Cancel
                  </button>
                )}
              </div>
            )}

            {scoping.isScoping && (
              <div
                className={styles.progress}
                data-testid="design-module-scoping-progress"
              >
                <strong>{scoping.progressLabel ?? 'Scoping source files…'}</strong>
                {scoping.streamingText && (
                  <pre className={styles.stream}>{scoping.streamingText}</pre>
                )}
              </div>
            )}

            {scoping.error && (
              <div className={styles.submitError} data-testid="design-module-scoping-error">
                {scoping.error}
              </div>
            )}

            <div className={styles.scopeLayout}>
              <div className={styles.proposalColumn}>
                {proposals.length > 0 ? (
                  <ul
                    className={styles.proposalList}
                    data-testid="design-module-proposal-list"
                  >
                    {proposals.map((glob) => (
                      <li key={glob.id} className={styles.proposalItem}>
                        <label className={styles.proposalToggle}>
                          <input
                            type="checkbox"
                            checked={glob.included}
                            onChange={(event) => {
                              syncFormFromProposals(
                                proposals.map((item) =>
                                  item.id === glob.id
                                    ? { ...item, included: event.target.checked }
                                    : item
                                )
                              );
                            }}
                            aria-label={`Include ${glob.pattern}`}
                          />
                          <code>{glob.pattern}</code>
                        </label>
                        <div className={styles.proposalMeta}>
                          <span
                            className={`${styles.confidence} ${confidenceClass(glob.confidence)}`}
                          >
                            {glob.confidence}
                          </span>
                          <button
                            type="button"
                            className={styles.remove}
                            onClick={() =>
                              syncFormFromProposals(
                                proposals.filter((item) => item.id !== glob.id)
                              )
                            }
                            aria-label={`Remove ${glob.pattern}`}
                          >
                            Remove
                          </button>
                        </div>
                        <p className={styles.rationale}>{glob.rationale}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
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
                )}

                <button
                  type="button"
                  className={styles.addGlob}
                  onClick={() => {
                    if (proposals.length > 0) {
                      const included = proposals
                        .filter((g) => g.included)
                        .map((g) => ({ value: g.pattern }));
                      setProposals([]);
                      setValue(
                        'sourceGlobs',
                        [...included, { value: '' }],
                        { shouldValidate: true }
                      );
                    } else {
                      append({ value: '' });
                    }
                  }}
                >
                  Add source glob
                </button>
                {errors.sourceGlobs &&
                  typeof errors.sourceGlobs.message === 'string' && (
                    <span className={styles.error}>
                      {errors.sourceGlobs.message}
                    </span>
                  )}
              </div>

              <aside className={styles.previewColumn}>
                <div className={styles.previewHeader}>
                  <strong>Matched files</strong>
                  <span>{previewFiles.length}</span>
                </div>
                {globPreview.isPending ? (
                  <div className={styles.previewLoading}>Updating preview…</div>
                ) : (
                  <DesignModuleFileTree files={previewFiles} />
                )}
              </aside>
            </div>

            {hasConnectedRepo && (
              <div className={styles.refine}>
                <label htmlFor={refineFieldId}>Refine with AI</label>
                {chat.length > 0 && (
                  <div
                    className={styles.chatLog}
                    data-testid="design-module-refine-chat"
                  >
                    {chat.map((msg) => (
                      <div
                        key={msg.id}
                        className={
                          msg.role === 'user'
                            ? styles.chatUser
                            : styles.chatAi
                        }
                      >
                        {msg.text}
                      </div>
                    ))}
                  </div>
                )}
                <div className={styles.refineRow}>
                  <input
                    id={refineFieldId}
                    value={refineInput}
                    onChange={(event) => setRefineInput(event.target.value)}
                    placeholder="e.g. Exclude test files"
                    disabled={scoping.isScoping}
                    data-testid="design-module-refine-input"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        handleRefine();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className={styles.secondary}
                    data-testid="design-module-refine-send"
                    disabled={
                      !refineInput.trim() ||
                      scoping.isScoping ||
                      !watchedLabel?.trim()
                    }
                    onClick={handleRefine}
                  >
                    Send
                  </button>
                </div>
              </div>
            )}
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
