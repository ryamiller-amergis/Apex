import React from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  RFP_AI_USAGE_LABELS,
  RFP_AI_USAGE_LEVELS,
  RFP_APP_TYPE_LABELS,
  RFP_APP_TYPES,
  RFP_CLOUD_RESOURCE_LABELS,
  RFP_CLOUD_RESOURCES,
  RFP_DEPLOYMENT_REGION_LABELS,
  RFP_DEPLOYMENT_REGIONS,
  RFP_MAX_ENVIRONMENTS,
  RFP_MAX_STORAGE_GB,
  RFP_SIZING_PROFILE_LABELS,
  RFP_SIZING_PROFILES,
  RFP_UPTIME_PATTERN_LABELS,
  RFP_UPTIME_PATTERNS,
  defaultRfpArchitectureSizing,
  type RfpAiUsage,
  type RfpAppType,
  type RfpArchitectureInput,
  type RfpCloudResource,
  type RfpDeploymentRegion,
  type RfpRequestDetail,
  type RfpSizingProfile,
  type RfpUptimePattern,
} from '../../shared/types/rfpIntake';
import { NumberStepper } from './NumberStepper';
import landing from './RfpIntakeLanding.module.css';
import styles from './RfpRequestWizard.module.css';

function enumOf<T extends string>(values: readonly T[]) {
  return z.enum(values as unknown as [T, ...T[]]);
}

const architectureFormSchema = z
  .object({
    appType: z.union([enumOf<RfpAppType>(RFP_APP_TYPES), z.literal('')]),
    resources: z.array(enumOf<RfpCloudResource>(RFP_CLOUD_RESOURCES)),
    requiresAi: z.boolean(),
    domainName: z.string(),
    region: enumOf<RfpDeploymentRegion>(RFP_DEPLOYMENT_REGIONS),
    sizingProfile: enumOf<RfpSizingProfile>(RFP_SIZING_PROFILES),
    environmentCount: z.number().int().min(1).max(RFP_MAX_ENVIRONMENTS),
    uptimePattern: enumOf<RfpUptimePattern>(RFP_UPTIME_PATTERNS),
    storageGb: z.number().min(0).max(RFP_MAX_STORAGE_GB),
    aiUsage: z.union([enumOf<RfpAiUsage>(RFP_AI_USAGE_LEVELS), z.literal('')]),
  })
  .superRefine((values, ctx) => {
    if (!values.appType) {
      ctx.addIssue({ code: 'custom', path: ['appType'], message: 'App type is required' });
    }
    if (values.appType === 'web' && !values.domainName.trim()) {
      ctx.addIssue({ code: 'custom', path: ['domainName'], message: 'Domain name is required for web apps' });
    }
    if (values.requiresAi && !values.aiUsage) {
      ctx.addIssue({ code: 'custom', path: ['aiUsage'], message: 'AI usage is required when the app uses AI' });
    }
  });

type ArchitectureFormValues = z.infer<typeof architectureFormSchema>;

interface RfpArchitectureFormProps {
  detail: RfpRequestDetail;
  /** The wizard footer submits this form through the `form` attribute. */
  formId: string;
  onSubmit: (architecture: RfpArchitectureInput) => Promise<unknown>;
}

function initialValues(detail: RfpRequestDetail): ArchitectureFormValues {
  const saved = detail.architecture;
  const requiresAi = saved?.requiresAi ?? detail.aiInApp === 'yes';
  const sizing = saved?.sizing ?? defaultRfpArchitectureSizing(detail.expectedUsers, requiresAi);
  return {
    appType: saved?.appType ?? '',
    resources: saved?.resources ?? [],
    requiresAi,
    domainName: saved?.domainName ?? '',
    region: sizing.region,
    sizingProfile: sizing.sizingProfile,
    environmentCount: sizing.environmentCount,
    uptimePattern: sizing.uptimePattern,
    storageGb: sizing.storageGb,
    aiUsage: sizing.aiUsage ?? '',
  };
}

export const RfpArchitectureForm: React.FC<RfpArchitectureFormProps> = ({ detail, formId, onSubmit }) => {
  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<ArchitectureFormValues>({
    resolver: zodResolver(architectureFormSchema),
    defaultValues: initialValues(detail),
  });
  const appType = watch('appType');
  const requiresAi = watch('requiresAi');

  const submit = async (values: ArchitectureFormValues) => {
    if (!values.appType) return;
    await onSubmit({
      appType: values.appType,
      resources: RFP_CLOUD_RESOURCES.filter((resource) => values.resources.includes(resource)),
      requiresAi: values.requiresAi,
      domainName: values.appType === 'web' ? values.domainName.trim() : null,
      sizing: {
        region: values.region,
        sizingProfile: values.sizingProfile,
        environmentCount: values.environmentCount,
        uptimePattern: values.uptimePattern,
        storageGb: values.storageGb,
        aiUsage: values.requiresAi && values.aiUsage ? values.aiUsage : null,
      },
    });
  };

  return (
    <form
      id={formId}
      className={landing.form}
      onSubmit={(event) => void handleSubmit(submit)(event).catch(() => undefined)}
      {...{ 'data-testid': 'rfp-architecture-form' }}
    >
      <h3 className={landing.blockTitle}>Architecture</h3>
      <label className={landing.field}>
        <span className={landing.label}>App type</span>
        <select className={landing.select} {...register('appType')} {...{ 'data-testid': 'rfp-arch-app-type' }}>
          <option value="">Select…</option>
          {RFP_APP_TYPES.map((value) => (
            <option key={value} value={value}>{RFP_APP_TYPE_LABELS[value]}</option>
          ))}
        </select>
        {errors.appType && <span className={landing.fieldError}>{errors.appType.message}</span>}
      </label>

      <fieldset className={styles.checkboxGroup}>
        <legend className={landing.label}>Cloud resources</legend>
        <Controller
          control={control}
          name="resources"
          render={({ field }) => (
            <>
              {RFP_CLOUD_RESOURCES.map((resource) => (
                <label key={resource} className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={field.value.includes(resource)}
                    onChange={(event) =>
                      field.onChange(
                        event.target.checked
                          ? [...field.value, resource]
                          : field.value.filter((value) => value !== resource),
                      )
                    }
                    {...{ 'data-testid': `rfp-arch-resource-${resource}` }}
                  />
                  {RFP_CLOUD_RESOURCE_LABELS[resource]}
                </label>
              ))}
            </>
          )}
        />
      </fieldset>

      <label className={styles.checkboxLabel}>
        <input
          type="checkbox"
          {...register('requiresAi', {
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
              // eslint-disable-next-line react-hooks/incompatible-library -- RHF watch() reads the latest AI usage when the checkbox changes; existing interaction stays as-is
              if (event.target.checked && !watch('aiUsage')) {
                const fallback = defaultRfpArchitectureSizing(detail.expectedUsers, true).aiUsage;
                if (fallback) setValue('aiUsage', fallback);
              }
            },
          })}
          {...{ 'data-testid': 'rfp-arch-requires-ai' }}
        />
        Requires AI
      </label>

      {appType === 'web' && (
        <label className={landing.field}>
          <span className={landing.label}>Domain name</span>
          <input
            className={landing.input}
            placeholder="app.example.com"
            {...register('domainName')}
            {...{ 'data-testid': 'rfp-arch-domain' }}
          />
          {errors.domainName && <span className={landing.fieldError}>{errors.domainName.message}</span>}
        </label>
      )}

      <fieldset className={styles.sizingGroup} {...{ 'data-testid': 'rfp-arch-sizing' }}>
        <legend className={landing.blockTitle}>Sizing for pricing</legend>
        <p className={landing.subtitle}>
          Prefilled from the expected number of users. Confirm each value; the proposal prices these assumptions.
        </p>
        <div className={styles.sizingGrid}>
          <label className={landing.field}>
            <span className={landing.label}>Region</span>
            <select className={landing.select} {...register('region')} {...{ 'data-testid': 'rfp-arch-region' }}>
              {RFP_DEPLOYMENT_REGIONS.map((value) => (
                <option key={value} value={value}>{RFP_DEPLOYMENT_REGION_LABELS[value]}</option>
              ))}
            </select>
          </label>
          <label className={landing.field}>
            <span className={landing.label}>Size</span>
            <select
              className={landing.select}
              {...register('sizingProfile')}
              {...{ 'data-testid': 'rfp-arch-sizing-profile' }}
            >
              {RFP_SIZING_PROFILES.map((value) => (
                <option key={value} value={value}>{RFP_SIZING_PROFILE_LABELS[value]}</option>
              ))}
            </select>
          </label>
          <label className={landing.field}>
            <span className={landing.label}>Uptime</span>
            <select className={landing.select} {...register('uptimePattern')} {...{ 'data-testid': 'rfp-arch-uptime' }}>
              {RFP_UPTIME_PATTERNS.map((value) => (
                <option key={value} value={value}>{RFP_UPTIME_PATTERN_LABELS[value]}</option>
              ))}
            </select>
          </label>
          {requiresAi && (
            <label className={landing.field}>
              <span className={landing.label}>AI usage</span>
              <select className={landing.select} {...register('aiUsage')} {...{ 'data-testid': 'rfp-arch-ai-usage' }}>
                <option value="">Select…</option>
                {RFP_AI_USAGE_LEVELS.map((value) => (
                  <option key={value} value={value}>{RFP_AI_USAGE_LABELS[value]}</option>
                ))}
              </select>
              {errors.aiUsage && <span className={landing.fieldError}>{errors.aiUsage.message}</span>}
            </label>
          )}
          <div className={landing.field}>
            <span className={landing.label}>Environments</span>
            <Controller
              control={control}
              name="environmentCount"
              render={({ field }) => (
                <NumberStepper
                  value={field.value}
                  onChange={field.onChange}
                  min={1}
                  max={RFP_MAX_ENVIRONMENTS}
                  aria-label="Environments, including production"
                  data-testid="rfp-arch-environments"
                />
              )}
            />
          </div>
          <div className={landing.field}>
            <span className={landing.label}>Database storage</span>
            <Controller
              control={control}
              name="storageGb"
              render={({ field }) => (
                <NumberStepper
                  value={field.value}
                  onChange={field.onChange}
                  min={0}
                  max={RFP_MAX_STORAGE_GB}
                  step={10}
                  unit="GB"
                  aria-label="Database storage in gigabytes"
                  data-testid="rfp-arch-storage"
                />
              )}
            />
          </div>
        </div>
      </fieldset>
    </form>
  );
};
