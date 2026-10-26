/**
 * The trigger for one Playbook. Run now stays in the page header.
 * This card is the daily clock, saved on the Playbook rather than in Project Settings.
 */
import React, { useEffect } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { PlaybookDefinition } from '../../shared/types/playbook';
import {
  formatPlaybookSchedule,
  playbookScheduleDraftFromForm,
  playbookScheduleFormFromDefinition,
  playbookScheduleFormSchema,
  type PlaybookScheduleFormValues,
} from '../../shared/utils/playbookSchedule';
import { useSavePlaybookSchedule } from '../hooks/usePlaybookDefinitions';
import { NumberStepper } from './NumberStepper';
import styles from './PlaybookScheduleCard.module.css';

interface PlaybookScheduleCardProps {
  project: string;
  definitionId: string;
  definition: PlaybookDefinition;
  canAuthor: boolean;
  published: boolean;
  'data-testid'?: string;
}

export const PlaybookScheduleCard: React.FC<PlaybookScheduleCardProps> = ({
  project,
  definitionId,
  definition,
  canAuthor,
  published,
  'data-testid': dataTestId = 'playbook-schedule',
}) => {
  const save = useSavePlaybookSchedule(project, definitionId);
  const {
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<PlaybookScheduleFormValues>({
    resolver: zodResolver(playbookScheduleFormSchema),
    defaultValues: playbookScheduleFormFromDefinition(definition),
  });
  const scheduleKind = useWatch({ control, name: 'scheduleKind' });
  const savedSchedule = `${definition.scheduleKind}:${definition.scheduleHour ?? ''}:${definition.scheduleMinute}:${definition.updatedAt}`;

  useEffect(() => {
    reset(playbookScheduleFormFromDefinition(definition));
  }, [definition, savedSchedule, reset]);

  const onSubmit = handleSubmit(async (values) => {
    try {
      await save.mutateAsync(playbookScheduleDraftFromForm(values));
    } catch {
      // The mutation error is shown under the form.
    }
  });

  const summary = formatPlaybookSchedule(definition);

  return (
    <section className={styles.card} aria-labelledby="playbook-trigger-heading" {...{ 'data-testid': dataTestId }}>
      <header className={styles.header}>
        <h2 id="playbook-trigger-heading" className={styles.title}>Trigger</h2>
        <span className={styles.summary}>{summary}</span>
      </header>
      <p className={styles.note}>
        Run now starts the published version immediately.
        {definition.scheduleKind === 'daily'
          ? ' The daily trigger does the same thing at this UTC time, as the person who saved it.'
          : ' Turn on a daily time to start that same version automatically.'}
      </p>
      {!published ? (
        <p className={styles.note}>Publish a version before a daily trigger can start a run.</p>
      ) : null}
      {canAuthor ? (
        <form className={styles.form} onSubmit={onSubmit} {...{ 'data-testid': 'playbook-schedule-form' }}>
          <fieldset className={styles.kinds}>
            <legend className={styles.legend}>When it starts</legend>
            <Controller
              name="scheduleKind"
              control={control}
              render={({ field }) => (
                <>
                  <label className={styles.choice}>
                    <input
                      type="radio"
                      name={field.name}
                      value="manual"
                      checked={field.value === 'manual'}
                      onChange={() => field.onChange('manual')}
                      {...{ 'data-testid': 'playbook-schedule-manual' }}
                    />
                    Run now only
                  </label>
                  <label className={styles.choice}>
                    <input
                      type="radio"
                      name={field.name}
                      value="daily"
                      checked={field.value === 'daily'}
                      onChange={() => field.onChange('daily')}
                      {...{ 'data-testid': 'playbook-schedule-daily' }}
                    />
                    Daily
                  </label>
                </>
              )}
            />
          </fieldset>
          {scheduleKind === 'daily' ? (
            <div className={styles.clock}>
              <label className={styles.clockField}>
                <span>Hour (UTC)</span>
                <Controller
                  name="scheduleHour"
                  control={control}
                  render={({ field }) => (
                    <NumberStepper
                      value={field.value}
                      onChange={field.onChange}
                      min={0}
                      max={23}
                      aria-label="Hour UTC"
                      data-testid="playbook-schedule-hour"
                    />
                  )}
                />
              </label>
              <label className={styles.clockField}>
                <span>Minute</span>
                <Controller
                  name="scheduleMinute"
                  control={control}
                  render={({ field }) => (
                    <NumberStepper
                      value={field.value}
                      onChange={field.onChange}
                      min={0}
                      max={59}
                      aria-label="Minute UTC"
                      data-testid="playbook-schedule-minute"
                    />
                  )}
                />
              </label>
            </div>
          ) : null}
          {errors.scheduleHour ? <p className={styles.error} role="alert">{errors.scheduleHour.message}</p> : null}
          {save.isError ? <p className={styles.error} role="alert">{save.error.message}</p> : null}
          <button type="submit" className={styles.save} disabled={save.isPending} {...{ 'data-testid': 'playbook-schedule-save' }}>
            {save.isPending ? 'Saving…' : 'Save trigger'}
          </button>
        </form>
      ) : null}
    </section>
  );
};
