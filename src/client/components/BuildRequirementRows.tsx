import React from 'react';
import { useFieldArray, useFormContext } from 'react-hook-form';
import {
  BUILD_REQUIREMENT_KINDS,
  BUILD_REQUIREMENT_TEXT_MAX,
  type BuildRequirementKind,
} from '../../shared/types/build';
import { requirementGroupLabel, requirementRowLabel } from './BuildRequirementList';
import styles from './BuildRequirementRows.module.css';

/** `requirementId` is null for a row added since the last save; the server issues its ID. */
export interface RequirementRowValue {
  requirementId: string | null;
  kind: BuildRequirementKind;
  text: string;
}

export interface RequirementRowsFormValues {
  requirements: RequirementRowValue[];
}

interface BuildRequirementRowsProps {
  disabled: boolean;
}

export const BuildRequirementRows: React.FC<BuildRequirementRowsProps> = ({ disabled }) => {
  const { control, register, formState: { errors } } = useFormContext<RequirementRowsFormValues>();
  const { fields, append, remove } = useFieldArray({ control, name: 'requirements' });

  return (
    <div className={styles.groups}>
      {BUILD_REQUIREMENT_KINDS.map((kind) => {
        const rows = fields
          .map((field, index) => ({ field, index }))
          .filter(({ field }) => field.kind === kind);
        let newCount = 0;
        return (
          <fieldset key={kind} className={styles.group}>
            <legend className={styles.legend}>{requirementGroupLabel(kind)}</legend>
            {rows.length === 0 && (
              <p className={styles.empty}>No {requirementGroupLabel(kind).toLowerCase()} yet.</p>
            )}
            {rows.map(({ field, index }) => {
              const key = field.requirementId ?? `new-${kind}-${(newCount += 1)}`;
              const label = field.requirementId
                ? `${field.requirementId} ${requirementRowLabel(kind)}`
                : `New ${requirementRowLabel(kind).toLowerCase()}`;
              const inputId = `build-requirement-${key}`;
              const message = errors.requirements?.[index]?.text?.message;
              return (
                <div key={field.id} className={styles.row} {...{ 'data-testid': `build-requirement-row-${key}` }}>
                  <label htmlFor={inputId} className={styles.label}>{label}</label>
                  <div className={styles.inputLine}>
                    <textarea
                      id={inputId}
                      rows={2}
                      disabled={disabled}
                      aria-invalid={message ? true : undefined}
                      {...register(`requirements.${index}.text`, {
                        validate: (value) => {
                          const trimmed = value.trim();
                          if (!trimmed) return 'Enter the requirement text.';
                          if (trimmed.length > BUILD_REQUIREMENT_TEXT_MAX) {
                            return `Keep it to ${BUILD_REQUIREMENT_TEXT_MAX} characters or fewer.`;
                          }
                          return true;
                        },
                      })}
                      {...{ 'data-testid': `build-requirement-input-${key}` }}
                    />
                    <button
                      type="button"
                      className={styles.remove}
                      disabled={disabled}
                      aria-label={`Remove ${label}`}
                      onClick={() => remove(index)}
                      {...{ 'data-testid': `build-requirement-remove-${key}` }}
                    >
                      Remove
                    </button>
                  </div>
                  {message && <p className={styles.rowError} role="alert">{message}</p>}
                </div>
              );
            })}
            <button
              type="button"
              className={styles.add}
              disabled={disabled}
              onClick={() => append({ requirementId: null, kind, text: '' })}
              {...{ 'data-testid': `build-requirement-add-${kind}` }}
            >
              Add {requirementRowLabel(kind).toLowerCase()}
            </button>
          </fieldset>
        );
      })}
    </div>
  );
};
