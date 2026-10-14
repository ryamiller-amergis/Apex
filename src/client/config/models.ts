export const DEFAULT_MODEL_ID = 'composer-2.5';

/** Return the model ID declared in a skill's frontmatter, or the default. */
export function getDefaultModelForSkill(frontmatter?: Record<string, unknown>): string {
  const declared = frontmatter?.['model'];
  if (typeof declared === 'string' && declared.trim()) {
    return declared.trim();
  }
  return DEFAULT_MODEL_ID;
}

/** Short badge text for a model ID, e.g. `claude-opus-5-5` -> `Opus`. */
export function modelBadge(id: string): string {
  const family = id.split('-').find((part) => part && part !== 'claude') ?? id;
  if (family.toLowerCase() === 'gpt') return 'GPT';
  return family.charAt(0).toUpperCase() + family.slice(1);
}
