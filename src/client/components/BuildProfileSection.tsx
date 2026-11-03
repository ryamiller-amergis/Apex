import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Controller, get, useForm, useWatch, type Control, type FieldErrors, type Resolver } from 'react-hook-form';
import { BUILD_PROFILE_ROLES, type BuildProfile, type BuildProfileRole } from '../../shared/types/build';
import {
  BUILD_CAP_DEFAULTS,
  BUILD_CAP_LIMITS,
  type BuildModelSource,
  type BuildProfileResponse,
  type BuildProfileRoleResolution,
} from '../../shared/types/buildPreflight';
import { parseBuildProfile } from '../../shared/buildProfileSchema';
import type { UserWithRoles } from '../../shared/types/rbac';
import { useBuildProfile, useSaveBuildProfile, BuildProfileSaveError } from '../hooks/useBuildProfile';
import { NumberStepper } from './NumberStepper';
import styles from './BuildProfileSection.module.css';

const ELAPSED_HOURS_LIMITS = {
  min: BUILD_CAP_LIMITS.elapsedMinutesPerRevision.min / 60,
  max: BUILD_CAP_LIMITS.elapsedMinutesPerRevision.max / 60,
};

const ROLE_LABELS: Record<BuildProfileRole, string> = {
  intake: 'Intake',
  planner: 'Planner',
  implementer: 'Implementer',
  qa: 'QA',
  check: 'Check',
};

interface BuildProfileFormValues {
  roles: Record<BuildProfileRole, { skillPath: string; model: string }>;
  caps: { costUsd: string; elapsedHours: number; maxRevisions: number; maxParallelism: number };
  qualityManifestPath: string;
  deployPipelineId: string;
  supportContactUserIds: string[];
}

interface FieldTarget {
  /** Dotted profile path, as the schema and the save route key errors. */
  schemaKey: string;
  formPath: string;
  elementId: string;
}

/** Profile fields in on-screen order, so focus lands on the first invalid one. */
const FIELD_TARGETS: FieldTarget[] = [
  ...BUILD_PROFILE_ROLES.flatMap((role) => [
    { schemaKey: `roles.${role}.skillPath`, formPath: `roles.${role}.skillPath`, elementId: `ps-build-${role}-skill` },
    { schemaKey: `roles.${role}.model`, formPath: `roles.${role}.model`, elementId: `ps-build-${role}-model` },
  ]),
  { schemaKey: 'caps.costUsd', formPath: 'caps.costUsd', elementId: 'ps-build-cap-cost' },
  { schemaKey: 'caps.elapsedMinutesPerRevision', formPath: 'caps.elapsedHours', elementId: 'ps-build-cap-elapsed' },
  { schemaKey: 'caps.maxRevisions', formPath: 'caps.maxRevisions', elementId: 'ps-build-cap-revisions' },
  { schemaKey: 'caps.maxParallelism', formPath: 'caps.maxParallelism', elementId: 'ps-build-cap-parallelism' },
  { schemaKey: 'qualityManifestPath', formPath: 'qualityManifestPath', elementId: 'ps-build-quality-manifest' },
  { schemaKey: 'deployPipelineId', formPath: 'deployPipelineId', elementId: 'ps-build-pipeline-id' },
  { schemaKey: 'supportContactUserIds', formPath: 'supportContactUserIds', elementId: 'ps-build-contact-picker' },
];

const TARGET_BY_SCHEMA_KEY = new Map(FIELD_TARGETS.map((target) => [target.schemaKey, target]));

function errorTestId(schemaKey: string): string {
  return `ps-build-profile-error-${schemaKey.replace(/\./g, '-')}`;
}

function errorElementId(schemaKey: string): string {
  return `ps-build-error-${schemaKey.replace(/\./g, '-')}`;
}

function toFormValues(profile: BuildProfile): BuildProfileFormValues {
  const roles = {} as BuildProfileFormValues['roles'];
  for (const role of BUILD_PROFILE_ROLES) {
    roles[role] = { skillPath: profile.roles[role]?.skillPath ?? '', model: profile.roles[role]?.model ?? '' };
  }
  const minutes = profile.caps.elapsedMinutesPerRevision ?? BUILD_CAP_DEFAULTS.elapsedMinutesPerRevision;
  return {
    roles,
    caps: {
      costUsd: profile.caps.costUsd == null ? '' : String(profile.caps.costUsd),
      elapsedHours: Math.round(minutes / 60),
      maxRevisions: profile.caps.maxRevisions ?? BUILD_CAP_DEFAULTS.maxRevisions,
      maxParallelism: profile.caps.maxParallelism ?? BUILD_CAP_DEFAULTS.maxParallelism,
    },
    qualityManifestPath: profile.qualityManifestPath ?? '',
    deployPipelineId: profile.deployPipelineId == null ? '' : String(profile.deployPipelineId),
    supportContactUserIds: [...profile.supportContactUserIds],
  };
}

function optionalNumber(text: string): number | null {
  const trimmed = text.trim();
  return trimmed ? Number(trimmed) : null;
}

function toProfileInput(values: BuildProfileFormValues): unknown {
  const roles: Record<string, { skillPath: string | null; model: string | null }> = {};
  for (const role of BUILD_PROFILE_ROLES) {
    roles[role] = { skillPath: values.roles[role].skillPath || null, model: values.roles[role].model || null };
  }
  return {
    roles,
    caps: {
      costUsd: optionalNumber(values.caps.costUsd),
      elapsedMinutesPerRevision: values.caps.elapsedHours * 60,
      maxRevisions: values.caps.maxRevisions,
      maxParallelism: values.caps.maxParallelism,
    },
    qualityManifestPath: values.qualityManifestPath || null,
    deployPipelineId: optionalNumber(values.deployPipelineId),
    supportContactUserIds: values.supportContactUserIds,
  };
}

/** Errors keyed by schema path. Elapsed time is checked in hours because the form shows hours. */
function validateForm(values: BuildProfileFormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  const hours = values.caps.elapsedHours;
  if (!Number.isInteger(hours) || hours < ELAPSED_HOURS_LIMITS.min) {
    errors['caps.elapsedMinutesPerRevision'] = `The minimum is ${ELAPSED_HOURS_LIMITS.min} hour.`;
  } else if (hours > ELAPSED_HOURS_LIMITS.max) {
    errors['caps.elapsedMinutesPerRevision'] = `The maximum is ${ELAPSED_HOURS_LIMITS.max} hours.`;
  }
  const parsed = parseBuildProfile(toProfileInput(values));
  if (!parsed.ok) {
    for (const [key, message] of Object.entries(parsed.fieldErrors)) errors[key] ??= message;
  }
  return errors;
}

function toFieldErrors(errors: Record<string, string>): FieldErrors<BuildProfileFormValues> {
  const result: Record<string, unknown> = {};
  for (const [schemaKey, message] of Object.entries(errors)) {
    const path = (TARGET_BY_SCHEMA_KEY.get(schemaKey)?.formPath ?? schemaKey).split('.');
    let node = result;
    path.slice(0, -1).forEach((segment) => {
      node[segment] = (node[segment] as Record<string, unknown> | undefined) ?? {};
      node = node[segment] as Record<string, unknown>;
    });
    node[path[path.length - 1]] = { type: 'validate', message };
  }
  return result as FieldErrors<BuildProfileFormValues>;
}

const buildProfileResolver: Resolver<BuildProfileFormValues> = async (values) => {
  const errors = validateForm(values);
  if (Object.keys(errors).length === 0) return { values, errors: {} };
  return { values: {}, errors: toFieldErrors(errors) };
};

function focusField(elementId: string): void {
  const element = document.getElementById(elementId);
  if (!element) return;
  if (element.matches('input, select, textarea, button')) {
    element.focus();
    return;
  }
  element.querySelector<HTMLElement>('input, select, button:not([disabled])')?.focus();
}

function sourceLabel(source: Exclude<BuildModelSource, 'profile'>): string {
  switch (source) {
    case 'interviewModel':
      return 'interview model';
    case 'developmentModel':
      return 'development model';
    case 'testCaseModel':
      return 'test case model';
    case 'defaultModel':
      return 'default model';
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

function effectiveModelText(
  localModel: string,
  resolution: BuildProfileRoleResolution | undefined,
  modelName: (id: string) => string,
): string {
  if (localModel) return `Uses ${modelName(localModel)} (set here)`;
  if (!resolution?.model || !resolution.modelSource) return 'No model resolved';
  if (resolution.modelSource === 'profile') return 'Uses the fallback model after you save';
  return `Uses the ${sourceLabel(resolution.modelSource)} (${modelName(resolution.model)})`;
}

// ── FieldError ───────────────────────────────────────────────────────────────

interface FieldErrorProps {
  schemaKey: string;
  message: string | undefined;
}

const FieldError: React.FC<FieldErrorProps> = ({ schemaKey, message }) => {
  if (!message) return null;
  return (
    <p
      id={errorElementId(schemaKey)}
      className={styles.fieldError}
      role="alert"
      {...{ 'data-testid': errorTestId(schemaKey) }}
    >
      {message}
    </p>
  );
};

// ── BuildRoleRow ─────────────────────────────────────────────────────────────

interface BuildRoleRowProps {
  role: BuildProfileRole;
  control: Control<BuildProfileFormValues>;
  errors: FieldErrors<BuildProfileFormValues>;
  resolution: BuildProfileRoleResolution | undefined;
  skillList: { id: string; path: string; name: string }[];
  availableModels: { id: string; displayName: string }[];
  skillsDisabled: boolean;
  modelsDisabled: boolean;
}

const BuildRoleRow: React.FC<BuildRoleRowProps> = ({
  role,
  control,
  errors,
  resolution,
  skillList,
  availableModels,
  skillsDisabled,
  modelsDisabled,
}) => {
  const localModel = useWatch({ control, name: `roles.${role}.model` });
  const modelName = useCallback(
    (id: string) => availableModels.find((m) => m.id === id)?.displayName ?? id,
    [availableModels],
  );
  const skillKey = `roles.${role}.skillPath`;
  const modelKey = `roles.${role}.model`;
  const skillError = get(errors, skillKey)?.message as string | undefined;
  const modelError = get(errors, modelKey)?.message as string | undefined;

  return (
    <div className={styles.roleRow} {...{ 'data-testid': `ps-build-role-${role}` }}>
      <span className={styles.roleName}>{ROLE_LABELS[role]}</span>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`ps-build-${role}-skill`}>Skill</label>
        <Controller
          control={control}
          name={`roles.${role}.skillPath`}
          render={({ field }) => (
            <select
              id={`ps-build-${role}-skill`}
              className={styles.select}
              value={field.value}
              onChange={(e) => field.onChange(e.target.value)}
              onBlur={field.onBlur}
              disabled={skillsDisabled}
              aria-invalid={skillError ? true : undefined}
              aria-describedby={skillError ? errorElementId(skillKey) : undefined}
              {...{ 'data-testid': `ps-build-role-${role}-skill` }}
            >
              <option value="">Not set</option>
              {field.value && !skillList.some((s) => s.path === field.value) && (
                <option value={field.value}>{field.value}</option>
              )}
              {skillList.map((s) => (
                <option key={s.id} value={s.path}>{s.name}</option>
              ))}
            </select>
          )}
        />
        <FieldError schemaKey={skillKey} message={skillError} />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`ps-build-${role}-model`}>Model</label>
        <Controller
          control={control}
          name={`roles.${role}.model`}
          render={({ field }) => (
            <select
              id={`ps-build-${role}-model`}
              className={styles.select}
              value={field.value}
              onChange={(e) => field.onChange(e.target.value)}
              onBlur={field.onBlur}
              disabled={modelsDisabled}
              aria-invalid={modelError ? true : undefined}
              aria-describedby={modelError ? errorElementId(modelKey) : `ps-build-${role}-effective`}
              {...{ 'data-testid': `ps-build-role-${role}-model` }}
            >
              <option value="">Use the project fallback</option>
              {field.value && !availableModels.some((m) => m.id === field.value) && (
                <option value={field.value}>{field.value}</option>
              )}
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>{m.displayName}</option>
              ))}
            </select>
          )}
        />
        <p
          id={`ps-build-${role}-effective`}
          className={styles.effectiveModel}
          aria-live="polite"
          {...{ 'data-testid': `ps-build-role-${role}-effective-model` }}
        >
          {effectiveModelText(localModel, resolution, modelName)}
        </p>
        <FieldError schemaKey={modelKey} message={modelError} />
      </div>
    </div>
  );
};

// ── SupportContactsField ─────────────────────────────────────────────────────

interface SupportContactsFieldProps {
  value: string[];
  onChange: (ids: string[]) => void;
  users: UserWithRoles[];
  savedContacts: { userId: string; displayName: string }[];
  disabled: boolean;
  error: string | undefined;
  'data-testid'?: string;
}

const SupportContactsField: React.FC<SupportContactsFieldProps> = ({
  value,
  onChange,
  users,
  savedContacts,
  disabled,
  error,
  'data-testid': testId = 'ps-build-contacts',
}) => {
  const [pickedUserId, setPickedUserId] = useState('');
  const available = useMemo(() => users.filter((u) => !value.includes(u.oid)), [users, value]);
  const nameFor = (userId: string) => {
    const user = users.find((u) => u.oid === userId);
    return user?.displayName || user?.email || savedContacts.find((c) => c.userId === userId)?.displayName || userId;
  };
  const addPicked = () => {
    if (!pickedUserId) return;
    onChange([...value, pickedUserId]);
    setPickedUserId('');
  };
  const errorKey = 'supportContactUserIds';

  return (
    <div className={styles.contacts} {...{ 'data-testid': testId }}>
      <label className={styles.label} htmlFor="ps-build-contact-picker">Build support contacts</label>
      {value.length === 0 ? (
        <p className={styles.muted}>No support contacts yet</p>
      ) : (
        <ul className={styles.contactList}>
          {value.map((userId) => (
            <li key={userId} className={styles.contactChip}>
              <span>{nameFor(userId)}</span>
              <button
                type="button"
                className={styles.chipRemove}
                onClick={() => onChange(value.filter((id) => id !== userId))}
                aria-label={`Remove ${nameFor(userId)}`}
                {...{ 'data-testid': `ps-build-contact-remove-${userId}` }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.contactPickerRow}>
        <select
          id="ps-build-contact-picker"
          className={styles.select}
          value={pickedUserId}
          onChange={(e) => setPickedUserId(e.target.value)}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorElementId(errorKey) : undefined}
          {...{ 'data-testid': 'ps-build-contact-picker' }}
        >
          <option value="">Choose a project member</option>
          {available.map((u) => (
            <option key={u.oid} value={u.oid}>{u.displayName || u.email || u.oid}</option>
          ))}
        </select>
        <button
          type="button"
          className={styles.btnSecondary}
          onClick={addPicked}
          disabled={disabled || !pickedUserId}
          {...{ 'data-testid': 'ps-build-contact-add' }}
        >
          Add
        </button>
      </div>
      <FieldError schemaKey={errorKey} message={error} />
    </div>
  );
};

// ── BuildProfileSection ──────────────────────────────────────────────────────

interface BuildProfileSectionProps {
  /** Saved repository configuration id; null while the configuration is new. */
  settingsId: string | null;
  project: string;
  skillList: { id: string; path: string; name: string }[];
  availableModels: { id: string; displayName: string }[];
  /** Users assigned to the project. */
  users: UserWithRoles[];
  skillsLoading?: boolean;
  modelsLoading?: boolean;
  usersLoading?: boolean;
}

export const BuildProfileSection: React.FC<BuildProfileSectionProps> = ({ settingsId, ...formProps }) => {
  const { data, isLoading, isError, refetch } = useBuildProfile(settingsId);

  if (!settingsId) {
    return (
      <div className={styles.section} {...{ 'data-testid': 'ps-build-profile-section' }}>
        <p className={styles.muted}>Save this repository configuration first, then set its Build profile</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={styles.section} aria-busy="true" {...{ 'data-testid': 'ps-build-profile-section' }}>
        {BUILD_PROFILE_ROLES.map((role) => (
          <div key={role} className={styles.skeletonRow} />
        ))}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className={styles.section} {...{ 'data-testid': 'ps-build-profile-section' }}>
        <p className={styles.formError} role="alert">Could not load the Build profile.</p>
        <button
          type="button"
          className={styles.btnSecondary}
          onClick={() => void refetch()}
          {...{ 'data-testid': 'ps-build-profile-retry' }}
        >
          Retry
        </button>
      </div>
    );
  }

  return <BuildProfileForm settingsId={settingsId} data={data} {...formProps} {...{ 'data-testid': 'ps-build-profile-form' }} />;
};

// ── BuildProfileForm ─────────────────────────────────────────────────────────

interface BuildProfileFormProps extends Omit<BuildProfileSectionProps, 'settingsId'> {
  settingsId: string;
  data: BuildProfileResponse;
  'data-testid'?: string;
}

const BuildProfileForm: React.FC<BuildProfileFormProps> = ({
  settingsId,
  data,
  project,
  skillList,
  availableModels,
  users,
  skillsLoading = false,
  modelsLoading = false,
  usersLoading = false,
  'data-testid': testId = 'ps-build-profile-form',
}) => {
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = useSaveBuildProfile();

  const {
    control,
    handleSubmit,
    reset,
    setError,
    getValues,
    register,
    formState: { errors },
  } = useForm<BuildProfileFormValues>({
    resolver: buildProfileResolver,
    shouldFocusError: false,
    defaultValues: toFormValues(data.profile),
  });

  const focusFirstError = useCallback((schemaKeys: string[]) => {
    const first = FIELD_TARGETS.find((target) => schemaKeys.includes(target.schemaKey));
    if (first) focusField(first.elementId);
  }, []);

  const onInvalid = useCallback(() => {
    setSaveError(null);
    focusFirstError(Object.keys(validateForm(getValues())));
  }, [getValues, focusFirstError]);

  const onValid = useCallback(
    async (values: BuildProfileFormValues) => {
      setSaveError(null);
      const parsed = parseBuildProfile(toProfileInput(values));
      if (!parsed.ok) return;
      try {
        await save.mutateAsync({ settingsId, profile: parsed.profile });
      } catch (error) {
        const fieldErrors = error instanceof BuildProfileSaveError ? error.fieldErrors : {};
        const keys = Object.keys(fieldErrors);
        for (const key of keys) {
          const target = TARGET_BY_SCHEMA_KEY.get(key);
          if (target) setError(target.formPath as never, { type: 'server', message: fieldErrors[key] });
        }
        const unmapped = keys.filter((key) => !TARGET_BY_SCHEMA_KEY.has(key));
        if (keys.length === 0 || unmapped.length > 0) {
          setSaveError(
            unmapped.length > 0
              ? unmapped.map((key) => fieldErrors[key]).join(' ')
              : (error as Error).message || 'Could not save the Build profile. Try again.',
          );
        }
        focusFirstError(keys);
      }
    },
    [settingsId, save, setError, focusFirstError],
  );

  useEffect(() => {
    reset(toFormValues(data.profile));
  }, [data, reset]);

  const updatedByName = data.updatedBy
    ? users.find((u) => u.oid === data.updatedBy)?.displayName
      ?? data.supportContacts.find((c) => c.userId === data.updatedBy)?.displayName
      ?? data.updatedBy
    : null;
  const statusText = data.updatedAt
    ? `Saved ${new Date(data.updatedAt).toLocaleString()}${updatedByName ? ` by ${updatedByName}` : ''}`
    : 'Not saved yet';
  const hasErrors = Object.keys(errors).length > 0;
  const capError = (schemaKey: string) =>
    get(errors, TARGET_BY_SCHEMA_KEY.get(schemaKey)?.formPath ?? schemaKey)?.message as string | undefined;
  const describedBy = (schemaKey: string, hintId?: string) =>
    [capError(schemaKey) ? errorElementId(schemaKey) : null, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={styles.section} {...{ 'data-testid': 'ps-build-profile-section' }}>
      <form
        className={styles.form}
        noValidate
        onSubmit={handleSubmit(onValid, onInvalid)}
        aria-label={`Build profile for ${project}`}
        {...{ 'data-testid': testId }}
      >
        {data.resolution.unresolvedRoles.length > 0 && (
          <p className={styles.notice} role="status" {...{ 'data-testid': 'ps-build-profile-unresolved' }}>
            These roles have no skill or no model yet: {data.resolution.unresolvedRoles.join(', ')}. You can save now;
            builds cannot start until each role has both.
          </p>
        )}

        <fieldset className={styles.group}>
          <legend className={styles.legend}>Roles</legend>
          {BUILD_PROFILE_ROLES.map((role) => (
            <BuildRoleRow
              key={role}
              role={role}
              control={control}
              errors={errors}
              resolution={data.resolution.roles[role]}
              skillList={skillList}
              availableModels={availableModels}
              skillsDisabled={skillsLoading || save.isPending}
              modelsDisabled={modelsLoading || save.isPending}
            />
          ))}
        </fieldset>

        <fieldset className={styles.group}>
          <legend className={styles.legend}>Run caps</legend>
          <div className={styles.capGrid}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="ps-build-cap-cost">Cost cap (USD)</label>
              <input
                id="ps-build-cap-cost"
                type="text"
                inputMode="decimal"
                className={styles.input}
                placeholder="Not set"
                aria-invalid={capError('caps.costUsd') ? true : undefined}
                aria-describedby={describedBy('caps.costUsd', 'ps-build-cap-cost-hint')}
                {...register('caps.costUsd')}
                {...{ 'data-testid': 'ps-build-cap-cost' }}
              />
              <span id="ps-build-cap-cost-hint" className={styles.hint}>Builds cannot start until this is set.</span>
              <FieldError schemaKey="caps.costUsd" message={capError('caps.costUsd')} />
            </div>
            <div className={styles.field}>
              <span className={styles.label} id="ps-build-cap-elapsed-label">Time per revision (hours)</span>
              <Controller
                control={control}
                name="caps.elapsedHours"
                render={({ field }) => (
                  <NumberStepper
                    id="ps-build-cap-elapsed"
                    value={field.value}
                    onChange={field.onChange}
                    min={ELAPSED_HOURS_LIMITS.min}
                    unit="hours"
                    disabled={save.isPending}
                    aria-label="Time per revision (hours)"
                    aria-invalid={capError('caps.elapsedMinutesPerRevision') ? true : undefined}
                    aria-describedby={describedBy('caps.elapsedMinutesPerRevision')}
                    data-testid="ps-build-cap-elapsed"
                  />
                )}
              />
              <FieldError
                schemaKey="caps.elapsedMinutesPerRevision"
                message={capError('caps.elapsedMinutesPerRevision')}
              />
            </div>
            <div className={styles.field}>
              <span className={styles.label} id="ps-build-cap-revisions-label">Revisions</span>
              <Controller
                control={control}
                name="caps.maxRevisions"
                render={({ field }) => (
                  <NumberStepper
                    id="ps-build-cap-revisions"
                    value={field.value}
                    onChange={field.onChange}
                    min={BUILD_CAP_LIMITS.maxRevisions.min}
                    disabled={save.isPending}
                    aria-label="Revisions"
                    aria-invalid={capError('caps.maxRevisions') ? true : undefined}
                    aria-describedby={describedBy('caps.maxRevisions')}
                    data-testid="ps-build-cap-revisions"
                  />
                )}
              />
              <FieldError schemaKey="caps.maxRevisions" message={capError('caps.maxRevisions')} />
            </div>
            <div className={styles.field}>
              <span className={styles.label} id="ps-build-cap-parallelism-label">Parallelism</span>
              <Controller
                control={control}
                name="caps.maxParallelism"
                render={({ field }) => (
                  <NumberStepper
                    id="ps-build-cap-parallelism"
                    value={field.value}
                    onChange={field.onChange}
                    min={BUILD_CAP_LIMITS.maxParallelism.min}
                    disabled={save.isPending}
                    aria-label="Parallelism"
                    aria-invalid={capError('caps.maxParallelism') ? true : undefined}
                    aria-describedby={describedBy('caps.maxParallelism')}
                    data-testid="ps-build-cap-parallelism"
                  />
                )}
              />
              <FieldError schemaKey="caps.maxParallelism" message={capError('caps.maxParallelism')} />
            </div>
          </div>
        </fieldset>

        <fieldset className={styles.group}>
          <legend className={styles.legend}>Quality and deploy</legend>
          <div className={styles.capGrid}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="ps-build-quality-manifest">Quality manifest path</label>
              <input
                id="ps-build-quality-manifest"
                type="text"
                className={styles.input}
                placeholder="e.g. .cursor/quality.json"
                aria-invalid={capError('qualityManifestPath') ? true : undefined}
                aria-describedby={describedBy('qualityManifestPath')}
                {...register('qualityManifestPath')}
                {...{ 'data-testid': 'ps-build-quality-manifest' }}
              />
              <FieldError schemaKey="qualityManifestPath" message={capError('qualityManifestPath')} />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="ps-build-pipeline-id">Deploy pipeline ID</label>
              <input
                id="ps-build-pipeline-id"
                type="text"
                inputMode="numeric"
                className={styles.input}
                placeholder="Not set"
                aria-invalid={capError('deployPipelineId') ? true : undefined}
                aria-describedby={describedBy('deployPipelineId')}
                {...register('deployPipelineId')}
                {...{ 'data-testid': 'ps-build-pipeline-id' }}
              />
              <FieldError schemaKey="deployPipelineId" message={capError('deployPipelineId')} />
            </div>
          </div>
        </fieldset>

        <Controller
          control={control}
          name="supportContactUserIds"
          render={({ field }) => (
            <SupportContactsField
              value={field.value}
              onChange={field.onChange}
              users={users}
              savedContacts={data.supportContacts}
              disabled={usersLoading || save.isPending}
              error={capError('supportContactUserIds')}
              {...{ 'data-testid': 'ps-build-contacts' }}
            />
          )}
        />

        {(hasErrors || saveError) && (
          <p className={styles.formError} role="alert" {...{ 'data-testid': 'ps-build-profile-error-summary' }}>
            {saveError ?? 'Fix the fields marked above, then save again.'}
          </p>
        )}

        <div className={styles.actions}>
          <span className={styles.status} role="status" {...{ 'data-testid': 'ps-build-profile-status' }}>
            {statusText}
          </span>
          <button
            type="submit"
            className={styles.btnPrimary}
            disabled={save.isPending}
            {...{ 'data-testid': 'ps-build-profile-save' }}
          >
            {save.isPending ? 'Saving…' : 'Save Build profile'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default BuildProfileSection;
