/**
 * Checks an LLM judge result against the JSON Schema on its evaluation
 * definition. The document worker runs it before uploading, and the harvest
 * runs it again before storing, because the uploaded file is not trusted.
 */
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';

const MAX_REPORTED_ERRORS = 5;

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validators = new Map<string, ValidateFunction>();

export type JudgeOutputCheck =
  | Readonly<{ ok: true; output: Record<string, unknown> }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

function validatorFor(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  let validate = validators.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    validators.set(key, validate);
  }
  return validate;
}

export function checkJudgeOutput(text: string, schema: Record<string, unknown>): JudgeOutputCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  let validate: ValidateFunction;
  try {
    validate = validatorFor(schema);
  } catch (error) {
    return { ok: false, errors: [`Output schema does not compile: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!validate(parsed)) {
    const errors = (validate.errors ?? [])
      .slice(0, MAX_REPORTED_ERRORS)
      .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`);
    return { ok: false, errors: errors.length > 0 ? errors : ['Output does not match the schema'] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['/ must be an object'] };
  }
  return { ok: true, output: parsed as Record<string, unknown> };
}
