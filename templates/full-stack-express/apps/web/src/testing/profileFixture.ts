import {
  problemTypes,
  type ProblemDetails,
  type ProblemError,
  type Profile,
} from '@project-scope/contracts';

export const sampleProfile: Profile = {
  displayName: 'Sam Example',
  email: 'sam@example.test',
  status: 'active',
};

export const SECRET_PROBLEM_TITLE = 'SECRET_PROBLEM_TITLE';
export const SECRET_PROBLEM_DETAIL = 'SECRET_PROBLEM_DETAIL';
export const SECRET_REQUEST_ID = 'req-secret-42';

export function problemBody(
  status: number,
  errors?: ProblemError[]
): ProblemDetails {
  const type =
    status === 401
      ? problemTypes.authenticationRequired
      : status === 400
        ? problemTypes.validationError
        : problemTypes.internalError;
  return {
    type,
    title: SECRET_PROBLEM_TITLE,
    status,
    detail: SECRET_PROBLEM_DETAIL,
    requestId: SECRET_REQUEST_ID,
    ...(errors ? { errors } : {}),
  };
}

export function problemResponse(
  status: number,
  errors?: ProblemError[]
): Response {
  return new Response(JSON.stringify(problemBody(status, errors)), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}
