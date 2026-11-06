import type { BuildRequirement } from './types/build';

export const BUILD_TASK_DOMAINS = ['ui', 'non_ui', 'mixed'] as const;
export type BuildTaskDomain = (typeof BUILD_TASK_DOMAINS)[number];

const UI_HINT =
  /\b(calendar|home ?page|landing page|screens?|pages?|components?|layout|navigation|nav item|visual|design|icon|logo|page header|ui|ux|frontend|react|mui|sites?|websites?|web app|dashboard|look(?:s|ing)? (?:and|&) feel|modern[- ]looking|look(?:s)? modern|industry[- ]standard look|theme|branding|responsive|mobile|portal)\b/i;
const BACKEND_HINT =
  /\b(api route|api|migration|database|worker|service bus|postgres|endpoint|schema|persist|store|backend|full[- ]stack)\b/i;
const PRODUCT_WORKFLOW_HINT =
  /\b(managers?|workers?|employees?|staff|admins?|users?)\b[\s\S]{0,200}\b(create|pick(?:ed)? up|claim|approve|track|book|schedule|manage)\b/i;

export function classifyBuildTaskDomain(
  prompt: string,
  requirements: readonly BuildRequirement[],
): BuildTaskDomain {
  const corpus = [prompt, ...requirements.map((row) => row.text)].join('\n');
  const ui = UI_HINT.test(corpus);
  const backend = BACKEND_HINT.test(corpus) || PRODUCT_WORKFLOW_HINT.test(corpus);
  if (ui && backend) return 'mixed';
  if (ui) return 'ui';
  return 'non_ui';
}

export function isUiHeavyDomain(domain: BuildTaskDomain): boolean {
  return domain === 'ui' || domain === 'mixed';
}
