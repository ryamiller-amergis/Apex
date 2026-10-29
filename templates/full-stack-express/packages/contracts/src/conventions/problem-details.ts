import { z } from 'zod';
import { contractSchemas } from '../schema-registry.ts';
import { requestIdSchema } from './request-id.ts';

export const problemContentType = 'application/problem+json';

export const problemTypes = {
  validationError: 'urn:problem-type:validation-error',
  malformedBody: 'urn:problem-type:malformed-body',
  authenticationRequired: 'urn:problem-type:authentication-required',
  notFound: 'urn:problem-type:not-found',
  rateLimited: 'urn:problem-type:rate-limited',
  notReady: 'urn:problem-type:not-ready',
  internalError: 'urn:problem-type:internal-error',
  serviceUnavailable: 'urn:problem-type:service-unavailable',
  payloadTooLarge: 'urn:problem-type:payload-too-large',
} as const;

export type ProblemType = (typeof problemTypes)[keyof typeof problemTypes];

const problemTypeValues = Object.values(problemTypes) as [
  ProblemType,
  ...ProblemType[],
];

export const problemErrorSchema = z.strictObject({
  pointer: z.string(),
  code: z.string().min(1),
  message: z.string().min(1),
});

export const problemDetailsSchema = z
  .strictObject({
    type: z.enum(problemTypeValues),
    title: z.string().min(1),
    status: z.int().min(400).max(599),
    detail: z.string().optional(),
    instance: z.string().optional(),
    requestId: requestIdSchema,
    errors: z.array(problemErrorSchema).optional(),
  })
  .register(contractSchemas, {
    id: 'ProblemDetails',
    description: 'RFC 9457 Problem Details. Never carries identity values.',
  });

export type ProblemError = z.infer<typeof problemErrorSchema>;
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

// Messages are fixed per issue code so an error body never repeats a value
// the caller submitted.
const issueMessages: Record<string, string> = {
  invalid_type: 'The value is missing or has the wrong type.',
  too_small: 'The value is too short or too small.',
  too_big: 'The value is too long or too large.',
  invalid_format: 'The value does not have the required format.',
  not_multiple_of: 'The value is not an allowed multiple.',
  unrecognized_key: 'This field is not allowed.',
  invalid_union: 'The value does not match any allowed shape.',
  invalid_key: 'The value has an invalid key.',
  invalid_element: 'The value has an invalid element.',
  invalid_value: 'The value is not one of the allowed values.',
  custom: 'The value is invalid.',
};

function toPointer(path: readonly PropertyKey[]): string {
  return path
    .map(
      (segment) =>
        `/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`
    )
    .join('');
}

function problemError(path: readonly PropertyKey[], code: string) {
  return {
    pointer: toPointer(path),
    code,
    message: issueMessages[code] ?? issueMessages.custom!,
  };
}

export function zodIssuesToProblemErrors(
  issues: readonly z.core.$ZodIssue[]
): ProblemError[] {
  return issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) =>
          problemError([...issue.path, key], 'unrecognized_key')
        )
      : [problemError(issue.path, issue.code)]
  );
}
