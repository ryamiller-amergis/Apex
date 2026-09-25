import { ZodError } from 'zod';
import { getStepTypeDescriptor } from './registry';

export class PlaybookStepSchemaError extends Error {
  constructor(
    stepType: string,
    boundary: 'input' | 'output',
    error: ZodError
  ) {
    const fields = [
      ...new Set(
        error.issues.map((issue) => (issue.path.length > 0 ? issue.path.join('.') : '<root>'))
      ),
    ];
    super(
      `Step type "${stepType}" has invalid ${boundary} at ${fields.join(', ')}: ` +
        error.issues.map((issue) => issue.message).join('; ')
    );
    this.name = 'PlaybookStepSchemaError';
  }
}

function parseDescriptorBoundary(
  stepType: string,
  boundary: 'input' | 'output',
  value: Record<string, unknown>
): Record<string, unknown> {
  const descriptor = getStepTypeDescriptor(stepType);
  const result =
    boundary === 'input'
      ? descriptor.inputSchema.safeParse(value)
      : descriptor.outputSchema.safeParse(value);

  if (!result.success) {
    throw new PlaybookStepSchemaError(stepType, boundary, result.error);
  }

  return result.data;
}

export function parseStepInput<T = Record<string, unknown>>(
  stepType: string,
  input: Record<string, unknown>
): T {
  return parseDescriptorBoundary(stepType, 'input', input) as T;
}

export function parseStepOutput(
  stepType: string,
  output: Record<string, unknown>
): Record<string, unknown> {
  return parseDescriptorBoundary(stepType, 'output', output);
}
