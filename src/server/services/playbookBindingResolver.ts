/**
 * Substitutes documented Playbook binding placeholders.
 *
 * Placeholders are data, not expressions. Only `input.<field>` and
 * `steps.<stepId>.<field>` are accepted. A string that is exactly one placeholder
 * is replaced with the bound value's original type; mixed strings stringify.
 */

export class PlaybookBindingError extends Error {
  constructor(placeholder: string) {
    super(
      `Playbook binding "${placeholder}" is not one of input.<field> or steps.<stepId>.<field>.`
    );
    this.name = 'PlaybookBindingError';
  }
}

export interface PlaybookBindingContext {
  input: Record<string, unknown>;
  steps: Record<string, Record<string, unknown>>;
}

const FULL_PLACEHOLDER = /^\$\{(input|steps)\.([^}]+)\}$/;
const EMBEDDED_PLACEHOLDER = /\$\{([^}]+)\}/g;
const INPUT_PATH = /^[A-Za-z][A-Za-z0-9_]*$/;
const STEP_PATH = /^[A-Za-z][A-Za-z0-9_-]*\.[A-Za-z][A-Za-z0-9_]*$/;

export function configHasBindings(config: unknown): boolean {
  return JSON.stringify(config).includes('${');
}

export function resolvePlaybookBindings<T>(value: T, context: PlaybookBindingContext): T {
  return resolveUnknown(value, context) as T;
}

function resolveUnknown(value: unknown, context: PlaybookBindingContext): unknown {
  if (typeof value === 'string') return resolveString(value, context);
  if (Array.isArray(value)) return value.map((entry) => resolveUnknown(entry, context));
  if (value && typeof value === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      resolved[key] = resolveUnknown(entry, context);
    }
    return resolved;
  }
  return value;
}

function resolveString(value: string, context: PlaybookBindingContext): unknown {
  const trimmed = value.trim();
  const full = trimmed.match(FULL_PLACEHOLDER);
  if (full && full[0] === trimmed) {
    return lookup(full[1], full[2], full[0], context);
  }

  return value.replace(EMBEDDED_PLACEHOLDER, (match, body: string) => {
    const [namespace, ...rest] = body.split('.');
    const bound = lookup(namespace, rest.join('.'), match, context);
    return bound == null ? '' : String(bound);
  });
}

function lookup(
  namespace: string,
  path: string,
  placeholder: string,
  context: PlaybookBindingContext,
): unknown {
  if (namespace === 'input') {
    if (!INPUT_PATH.test(path)) throw new PlaybookBindingError(placeholder);
    return context.input[path];
  }

  if (namespace !== 'steps') throw new PlaybookBindingError(placeholder);
  if (!STEP_PATH.test(path)) throw new PlaybookBindingError(placeholder);
  const [stepId, field] = path.split('.');
  return context.steps[stepId]?.[field];
}
