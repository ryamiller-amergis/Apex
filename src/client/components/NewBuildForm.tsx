import React, { useEffect, useMemo, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { BUILD_PROMPT_MAX_LENGTH } from '../../shared/types/build';
import { BuildApiError, useBuildRepositories, useStartBuild } from '../hooks/useBuilds';
import { useAvailableModels } from '../hooks/useProjectSkillConfig';
import styles from './NewBuildForm.module.css';

const schema = z.object({
  repository: z.string().min(1, 'Choose a repository'),
  prompt: z.string().trim().min(1, 'Describe the feature').max(BUILD_PROMPT_MAX_LENGTH, 'Use 8000 characters or fewer'),
  model: z.string(),
});

type FormValues = z.infer<typeof schema>;

function newClientRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `build-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

interface NewBuildFormProps {
  project: string;
}

export const NewBuildForm: React.FC<NewBuildFormProps> = ({ project }) => {
  const navigate = useNavigate();
  const requestId = useRef(newClientRequestId());
  const errorHeadingRef = useRef<HTMLHeadingElement>(null);
  const repositories = useBuildRepositories(project);
  const models = useAvailableModels();
  const start = useStartBuild(project);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { repository: '', prompt: '', model: '' },
  });
  const { register, handleSubmit, watch, setValue, formState: { errors } } = form;
  const prompt = watch('prompt');
  const options = useMemo(
    () => repositories.data?.repositories ?? [],
    [repositories.data?.repositories],
  );

  useEffect(() => {
    if (options.length === 1 && !form.getValues('repository')) {
      setValue('repository', options[0].repository);
    }
  }, [options, form, setValue]);

  useEffect(() => {
    if (start.isError) errorHeadingRef.current?.focus();
  }, [start.isError, start.error]);

  const apiError = start.error instanceof BuildApiError ? start.error : null;
  const queued = start.data?.status === 'queued' ? start.data : null;

  const onSubmit = handleSubmit(async (values) => {
    const result = await start.mutateAsync({
      repository: values.repository,
      prompt: values.prompt.trim(),
      clientRequestId: requestId.current,
      ...(values.model ? { model: values.model } : {}),
    }).catch((error: unknown) => {
      requestId.current = newClientRequestId();
      throw error;
    });
    if (result.status === 'intake') {
      navigate('/builds', { state: { notice: 'Your build has started.' } });
    }
  });

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>New build</h1>
      {options.length === 0 && repositories.isSuccess && (
        <p {...{ 'data-testid': 'new-build-no-repository' }}>
          No repository is approved for builds in this project. Ask a Platform Admin.
        </p>
      )}
      <form className={styles.form} onSubmit={onSubmit} noValidate {...{ 'data-testid': 'new-build-form' }}>
        {start.isError && (
          <div role="alert" {...{ 'data-testid': 'new-build-error-summary' }}>
            <h2 tabIndex={-1} ref={errorHeadingRef}>The build was not started</h2>
            <p>{apiError?.message ?? 'The build was not started.'}</p>
            {apiError && apiError.refusals.length > 0 && (
              <ul {...{ 'data-testid': 'new-build-refusal-list' }}>
                {apiError.refusals.map((item) => <li key={item}>{item}</li>)}
              </ul>
            )}
          </div>
        )}
        {start.data?.status === 'intake' && (
          <p role="status" {...{ 'data-testid': 'new-build-success' }}>Your build has started.</p>
        )}
        {queued && (
          <p role="status" {...{ 'data-testid': 'new-build-queued-notice' }}>
            {`Your build is queued. Position ${queued.queuePosition ?? 1} in this project. `}
            <a href="/builds" {...{ 'data-testid': 'new-build-queued-link' }}>Back to builds</a>
          </p>
        )}
        <label htmlFor="new-build-repository">Repository</label>
        <select
          id="new-build-repository"
          aria-required="true"
          aria-invalid={errors.repository ? 'true' : 'false'}
          disabled={repositories.isLoading || options.length === 0}
          {...register('repository')}
          {...{ 'data-testid': 'new-build-repository' }}
        >
          <option value="">{repositories.isLoading ? 'Loading repositories…' : 'Choose a repository'}</option>
          {options.map((option) => (
            <option key={option.repository} value={option.repository}>{option.label}</option>
          ))}
        </select>
        {errors.repository && <p role="alert">{errors.repository.message}</p>}
        <p id="new-build-secrets" {...{ 'data-testid': 'new-build-secrets-notice' }}>
          Do not paste passwords, keys or customer data. The build agent can read this request.
        </p>
        <label htmlFor="new-build-prompt">What should we build?</label>
        <textarea
          id="new-build-prompt"
          aria-required="true"
          aria-invalid={errors.prompt ? 'true' : 'false'}
          aria-describedby="new-build-secrets"
          rows={8}
          {...register('prompt')}
          {...{ 'data-testid': 'new-build-prompt' }}
        />
        <p>{`${prompt.trim().length} / ${BUILD_PROMPT_MAX_LENGTH}`}</p>
        {errors.prompt && <p role="alert">{errors.prompt.message}</p>}
        <label htmlFor="new-build-model">Model</label>
        <select id="new-build-model" {...register('model')} {...{ 'data-testid': 'new-build-model' }}>
          <option value="">Project default</option>
          {(models.data ?? []).map((model) => (
            <option key={model.id} value={model.id}>{model.displayName}</option>
          ))}
        </select>
        <button
          type="submit"
          disabled={start.isPending || options.length === 0}
          {...{ 'data-testid': 'new-build-submit' }}
        >
          {start.isPending ? 'Starting…' : 'Start build'}
        </button>
      </form>
    </div>
  );
};

export default NewBuildForm;
