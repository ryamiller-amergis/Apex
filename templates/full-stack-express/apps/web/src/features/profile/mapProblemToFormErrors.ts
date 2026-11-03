import type { ProblemDetails } from '@project-scope/contracts';

export const profileFields = ['displayName', 'email'] as const;
export type ProfileField = (typeof profileFields)[number];

export interface FieldErrorMapping {
  field: ProfileField;
  message: string;
}

function fieldFromPointer(pointer: string): ProfileField | null {
  const name = pointer.startsWith('/') ? pointer.slice(1) : pointer;
  if (name === 'displayName' || name === 'email') {
    return name;
  }
  return null;
}

/** Maps Problem Details pointers onto the two editable fields. Unknown pointers are ignored. */
export function mapProblemToFormErrors(
  problem: ProblemDetails | null
): FieldErrorMapping[] {
  if (!problem?.errors) {
    return [];
  }
  const mapped: FieldErrorMapping[] = [];
  for (const error of problem.errors) {
    const field = fieldFromPointer(error.pointer);
    if (!field) {
      continue;
    }
    mapped.push({ field, message: error.message });
  }
  return mapped;
}

/** Display name before email, matching the form's reading order. */
export function firstProfileField(
  errors: readonly FieldErrorMapping[]
): ProfileField | null {
  for (const name of profileFields) {
    if (errors.some((error) => error.field === name)) {
      return name;
    }
  }
  return null;
}
