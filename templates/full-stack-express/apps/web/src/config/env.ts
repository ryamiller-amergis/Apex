/// <reference types="vite/client" />

import { parseWebEnv, type WebEnv } from './webEnvSchema';

function readViteEnv(): Record<string, string | undefined> {
  const source: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(import.meta.env)) {
    if (key.startsWith('VITE_') && typeof value === 'string') {
      source[key] = value;
    }
  }
  return source;
}

export type { WebEnv };
export const webEnv: WebEnv = parseWebEnv(readViteEnv());
