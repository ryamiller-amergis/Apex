import type { BuildRequirement } from '../types/build';

export const BUILD_TASK_DOMAINS = ['ui', 'non_ui', 'mixed'] as const;
export type BuildTaskDomain = (typeof BUILD_TASK_DOMAINS)[number];

const UI_HINT =
  /\b(calendar|home page|screen|component|layout|navigation|nav item|visual|design|icon|logo|page header|ui|frontend|react|mui)\b/i;
const BACKEND_HINT =
  /\b(api route|migration|database|worker|service bus|postgres|endpoint|schema)\b/i;

export function classifyBuildTaskDomain(
  prompt: string,
  requirements: readonly BuildRequirement[],
): BuildTaskDomain {
  const corpus = [prompt, ...requirements.map((row) => row.text)].join('\n');
  const ui = UI_HINT.test(corpus);
  const backend = BACKEND_HINT.test(corpus);
  if (ui && backend) return 'mixed';
  if (ui) return 'ui';
  return 'non_ui';
}

export function isUiHeavyDomain(domain: BuildTaskDomain): boolean {
  return domain === 'ui' || domain === 'mixed';
}
