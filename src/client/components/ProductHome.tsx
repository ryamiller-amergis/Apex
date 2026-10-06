import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { BuildHistory } from './BuildHistory';
import {
  useStartNextProductBuild,
  type ProductBuildSetupStatus,
} from '../hooks/useProductSetup';
import styles from './ProductBuildSetup.module.css';

const promptSchema = z.object({
  prompt: z.string().trim().min(1, 'Describe what you want to add or change.').max(4000, 'That request is too long.'),
});

type PromptValues = z.infer<typeof promptSchema>;

export interface ProductHomeProps {
  project: string;
  status: ProductBuildSetupStatus;
}

export const ProductHome: React.FC<ProductHomeProps> = ({ project, status }) => {
  const startNext = useStartNextProductBuild(project);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<PromptValues>({
    resolver: zodResolver(promptSchema),
    defaultValues: { prompt: '' },
  });
  const html = status.design?.status === 'ready' ? status.design.html?.trim() ?? '' : '';

  const submit = (values: PromptValues) => {
    startNext.mutate(values.prompt);
  };

  return (
    <section className={styles.panel} {...{ 'data-testid': 'product-home' }}>
      <div className={styles.homeLayout}>
        <div {...{ 'data-testid': 'product-home-preview' }}>
          {html ? (
            <iframe
              className={styles.previewFrame}
              srcDoc={html}
              sandbox="allow-scripts"
              title="Your app"
            />
          ) : (
            <p className={styles.previewEmpty}>Your app preview will show here.</p>
          )}
        </div>
        <form
          className={styles.form}
          onSubmit={(event) => { void handleSubmit(submit)(event); }}
          {...{ 'data-testid': 'product-home-form' }}
        >
          <label className={styles.promptLabel} htmlFor="product-home-prompt">
            What would you like to add or change?
          </label>
          <textarea
            id="product-home-prompt"
            className={styles.answer}
            rows={4}
            disabled={startNext.isPending}
            {...register('prompt')}
            {...{ 'data-testid': 'product-home-prompt' }}
          />
          {errors.prompt && (
            <p className={styles.fieldError} role="alert">{errors.prompt.message}</p>
          )}
          {startNext.error && (
            <p className={styles.fieldError} role="alert" {...{ 'data-testid': 'product-home-error' }}>
              {startNext.error.message}
            </p>
          )}
          <button
            type="submit"
            className={styles.primaryButton}
            disabled={startNext.isPending}
            {...{ 'data-testid': 'product-home-send' }}
          >
            Send
          </button>
        </form>
      </div>
      <BuildHistory history={status.history ?? []} />
    </section>
  );
};
