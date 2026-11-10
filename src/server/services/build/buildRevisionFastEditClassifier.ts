import type { BuildRevisionFastEditRoute } from '../../../shared/types/buildRevision';

export interface BuildRevisionFastEditClassification {
  route: BuildRevisionFastEditRoute;
  certain: boolean;
  reason: 'contained_ui_change' | 'structural_change' | 'uncertain_scope';
  matchedSignals: string[];
  agentMayEscalate: true;
}

// Words a person uses for look and feel (`schema` in "token schema", `request`,
// `table`) are not structural. Only a clear backend, data, or infrastructure
// change takes the slow path.
const STRUCTURAL_SIGNALS: ReadonlyArray<readonly [string, RegExp]> = [
  ['api_contract', /\b(api|endpoint|graphql|webhook)\b/i],
  ['data_model', /\b(database|migration|postgres)\b/i],
  ['access', /\b(auth|authentication|authorization|permission|rbac|role)\b/i],
  ['dependency', /\b(dependency|package|install|upgrade|npm|pnpm|yarn)\b/i],
  [
    'infrastructure',
    /\b(infrastructure|terraform|azure|cloud|environment variable|container|docker)\b/i,
  ],
  [
    'integration',
    /\b(integrat(?:e|ion)|workday|salesforce|service bus|external system)\b/i,
  ],
  ['server', /\b(backend|background worker|message queue|cron)\b/i],
];

const UI_SIGNALS: ReadonlyArray<readonly [string, RegExp]> = [
  ['copy', /\b(copy|text|label|title|heading|wording|placeholder)\b/i],
  [
    'layout',
    /\b(align|alignment|layout|position|move|spacing|padding|margin|gap|sidebar)\b/i,
  ],
  [
    'visual_style',
    /\b(color|font|size|border|shadow|radius|softer|background|theme|token|palette|dark mode|light mode|dark theme|light theme|branding|contrast|typography|style|look|feel)\b/i,
  ],
  [
    'component_visual',
    /\b(button|card|icon|logo|menu|nav|navigation|header|footer|badge|chip|dialog|modal|panel|tooltip|dropdown|tab)\b/i,
  ],
  [
    'interaction',
    /\b(hover|animation|empty state|loading state|redesign|screen|page|ui|ux)\b/i,
  ],
];

function matchedSignals(
  feedback: string,
  rules: ReadonlyArray<readonly [string, RegExp]>
): string[] {
  return rules
    .filter(([, expression]) => expression.test(feedback))
    .map(([name]) => name);
}

export function classifyBuildRevisionFastEdit(
  feedback: string
): BuildRevisionFastEditClassification {
  const trimmed = feedback.trim();
  const structural = matchedSignals(trimmed, STRUCTURAL_SIGNALS);
  if (structural.length > 0) {
    return {
      route: 'full_build',
      certain: true,
      reason: 'structural_change',
      matchedSignals: structural,
      agentMayEscalate: true,
    };
  }

  const visual = matchedSignals(trimmed, UI_SIGNALS);
  if (visual.length > 0) {
    return {
      route: 'fast_edit',
      certain: true,
      reason: 'contained_ui_change',
      matchedSignals: visual,
      agentMayEscalate: true,
    };
  }

  // Unclear product wording tries the fast preview first. The edit agent escalates
  // if the change turns out to need the backend, so the slow path stays available.
  return {
    route: 'fast_edit',
    certain: false,
    reason: 'uncertain_scope',
    matchedSignals: [],
    agentMayEscalate: true,
  };
}
