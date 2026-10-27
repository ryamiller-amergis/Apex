import { z } from 'zod';
import type { FlagEvaluator, FlagLogger } from './flag-evaluator.ts';

export interface LocalFlagEvaluatorOptions {
  /** Raw FEATURE_FLAGS value from typed configuration; undefined when unset. */
  source: string | undefined;
  logger: FlagLogger;
}

// Kebab-case keys also keep names such as __proto__ out of the map.
const FLAG_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const flagMapSchema = z.record(z.string().regex(FLAG_NAME), z.boolean());

type InvalidReason = 'invalid_json' | 'invalid_shape';

function parseFlags(
  source: string
): Map<string, boolean> | { reason: InvalidReason } {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { reason: 'invalid_json' };
  }
  // z.record silently drops an own __proto__ key, so check the raw keys first.
  const hasBadKey =
    typeof raw === 'object' &&
    raw !== null &&
    Object.keys(raw).some((key) => !FLAG_NAME.test(key));
  const result = flagMapSchema.safeParse(raw);
  if (hasBadKey || !result.success) {
    return { reason: 'invalid_shape' };
  }
  return new Map(Object.entries(result.data));
}

/**
 * Builds a flag evaluator from the FEATURE_FLAGS configuration value, for
 * example `{"checkout-v2":true}`. The value is parsed once. An invalid value is
 * ignored as a whole and logged once; every flag then returns its default.
 */
export function createLocalFlagEvaluator(
  options: LocalFlagEvaluatorOptions
): FlagEvaluator {
  let flags = new Map<string, boolean>();
  const source = options.source?.trim() ?? '';
  if (source !== '') {
    const parsed = parseFlags(source);
    if (parsed instanceof Map) {
      flags = parsed;
    } else {
      // Never log the value or Zod issue paths: a key can look like identity data.
      options.logger.warn(
        {
          event: 'feature_flags.config_invalid',
          variable: 'FEATURE_FLAGS',
          reason: parsed.reason,
        },
        'FEATURE_FLAGS is invalid and was ignored; every flag returns its default'
      );
    }
  }

  return {
    isEnabled(name, defaultValue) {
      if (typeof name !== 'string') {
        return defaultValue;
      }
      return flags.get(name) ?? defaultValue;
    },
  };
}
