import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const requiredText = (field) =>
  z
    .string({ error: `${field} is missing` })
    .min(1, { error: `${field} is missing` });

export const exceptionSchema = z
  .object({
    advisory: requiredText('advisory'),
    package: requiredText('package'),
    reason: requiredText('reason'),
    owner: requiredText('owner'),
    reviewed: z
      .string({ error: 'reviewed is missing' })
      .regex(datePattern, { error: 'reviewed is invalid' }),
    expires: z
      .string({ error: 'expires is missing' })
      .regex(datePattern, { error: 'expires is invalid' }),
  })
  .strict();

export const exceptionsFileSchema = z.array(exceptionSchema);

export const allowedLicensesSchema = z.array(z.string().min(1)).min(1);

function fieldName(issue) {
  const names = issue.path.filter((part) => typeof part === 'string');
  if (names.length > 0) {
    return names[names.length - 1];
  }
  return issue.path.join('.') || 'file';
}

export function loadJsonSchema(file, schema) {
  const display = path.basename(file);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { ok: false, message: `${display} is missing` };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, message: `${display} is not valid JSON` };
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = fieldName(issue);
    return {
      ok: false,
      message: `${display}: ${field} is missing or invalid`,
    };
  }
  return { ok: true, data: parsed.data };
}
