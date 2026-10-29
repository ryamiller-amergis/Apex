import { z } from 'zod';

export const PRINCIPAL_SUBJECT_MAX_LENGTH = 255;

/**
 * The authenticated caller. `subject` is the identity provider's stable id
 * for the person. There is no role, permission, group, or claims field: the
 * template defines no authorization (BR-003). The principal never crosses the
 * HTTP boundary, so it lives here and not in the contracts package.
 */
export interface Principal {
  readonly subject: string;
  readonly displayName?: string;
  readonly email?: string;
}

/**
 * Checks what an adapter returns before it reaches a handler. Unknown keys
 * are dropped, so a provider-specific claim never reaches route code.
 */
export const principalSchema = z.object({
  subject: z.string().min(1).max(PRINCIPAL_SUBJECT_MAX_LENGTH),
  displayName: z.string().optional(),
  email: z.string().optional(),
}) satisfies z.ZodType<Principal>;
