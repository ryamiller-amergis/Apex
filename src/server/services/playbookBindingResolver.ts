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

const DOCUMENTED_PLACEHOLDER = /\$\{(?:input\.[A-Za-z][A-Za-z0-9_]*|steps\.[A-Za-z][A-Za-z0-9_-]*\.[A-Za-z][A-Za-z0-9_]*)\}/;
const EMBEDDED_PLACEHOLDER = /\$\{([^}]+)\}/g;
const INPUT_PATH = /^[A-Za-z][A-Za-z0-9_]*$/;
const STEP_PATH = /^[A-Za-z][A-Za-z0-9_-]*\.[A-Za-z][A-Za-z0-9_]*$/;

export function configHasBindings(config: unknown): boolean {
  return DOCUMENTED_PLACEHOLDER.test(JSON.stringify(config));
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
  const full = trimmed.match(/^\$\{([^}]+)\}$/);
  if (full && full[0] === trimmed) {
    const [namespace, ...rest] = full[1].split('.');
    return lookup(namespace, rest.join('.'), full[0], context);
  }

  return value.replace(EMBEDDED_PLACEHOLDER, (match, body: string) => {
    const [namespace, ...rest] = body.split('.');
    const path = rest.join('.');
    if (namespace === 'input' && INPUT_PATH.test(path)) {
      const bound = context.input[path];
      return bound == null ? '' : String(bound);
    }
    if (namespace === 'steps' && STEP_PATH.test(path)) {
      const [stepId, field] = path.split('.');
      const bound = context.steps[stepId]?.[field];
      return bound == null ? '' : String(bound);
    }
    // Leftover `${` in agent text is not a Playbook binding.
    return match;
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
