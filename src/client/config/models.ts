export interface AgentModel {
  id: string;
  label: string;
  badge: string;
}

export const AGENT_MODELS: AgentModel[] = [
  { id: 'composer-2',        label: 'Composer 2',     badge: 'Composer' },
  { id: 'claude-opus-4-6',   label: 'Opus 4.6',       badge: 'Opus'     },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6',     badge: 'Sonnet'   },
  { id: 'gpt-5.5',           label: 'GPT-5.5',        badge: 'GPT'      },
  { id: 'gemini-3.1-pro',    label: 'Gemini 3.1 Pro', badge: 'Gemini'   },
];

export const DEFAULT_MODEL_ID = 'composer-2';

/** Return the model ID declared in a skill's frontmatter, or the default. */
export function getDefaultModelForSkill(frontmatter?: Record<string, unknown>): string {
  const declared = frontmatter?.['model'];
  if (typeof declared === 'string' && AGENT_MODELS.some((m) => m.id === declared)) {
    return declared;
  }
  return DEFAULT_MODEL_ID;
}

export function modelLabel(id: string): string {
  return AGENT_MODELS.find((m) => m.id === id)?.label ?? id;
}

export function modelBadge(id: string): string {
  return AGENT_MODELS.find((m) => m.id === id)?.badge ?? id;
}
