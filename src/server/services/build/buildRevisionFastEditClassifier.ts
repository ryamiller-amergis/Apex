import type { BuildRevisionFastEditRoute } from '../../../shared/types/buildRevision';

export type BuildRevisionAgentKind =
  | 'fast_edit'
  | 'cloud_agent'
  | 'needs_clarification';

export interface BuildRevisionFastEditClassification {
  route: BuildRevisionFastEditRoute;
  agentKind: BuildRevisionAgentKind;
  certain: boolean;
  reason:
    | 'contained_ui_change'
    | 'structural_change'
    | 'uncertain_scope'
    | 'clarification_needed';
  matchedSignals: string[];
  agentMayEscalate: true;
  escalationReason?: string;
}

// Words a person uses for look and feel (`schema` in "token schema", `request`,
// `table`) are not structural. Only a clear backend, data, or infrastructure
// change takes the slow path.
const STRUCTURAL_SIGNALS: ReadonlyArray<readonly [string, RegExp]> = [
  ['api_contract', /\b(api|endpoint|graphql|webhook)\b/i],
  ['data_model', /\b(database|migration|postgres|sql\s+table)\b/i],
  ['access', /\b(auth|authentication|authorization|permission|rbac|role)\b/i],
  ['dependency', /\b(dependency|package|install|upgrade|npm|pnpm|yarn)\b/i],
  [
    'infrastructure',
    /\b(infrastructure|terraform|azure|cloud|environment variable|docker|docker\s+container)\b/i,
  ],
  [
    'integration',
    /\b(integrat(?:e|ion)|workday|salesforce|service bus|external system|third[- ]party\s+connector|connector\s+feed)\b/i,
  ],
  ['server', /\b(backend|background worker|message queue|cron)\b/i],
  [
    'new_feature_slice',
    /\b(new\s+(?:screen|route|page|endpoint|module|chart\s+endpoint|notification\s+backend)|ai\s+skill\s+integration|notification\s+module\s+with\s+api)\b/i,
  ],
];

const CLARIFICATION_SIGNALS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'question_or_ambiguous',
    /^(?:\?|what\s+should|not\s+sure\s+what|can\s+you\s+suggest\s+options|which\s+one\s+is\s+better)/i,
  ],
];

const UI_SIGNALS: ReadonlyArray<readonly [string, RegExp]> = [
  ['copy', /\b(copy|text|label|title|heading|wording|placeholder)\b/i],
  [
    'layout',
    /\b(align|alignment|center|centered|centering|layout|position|move|spacing|padding|margin|gap|sidebar|max-?width)\b/i,
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

export function formatEscalationTimelineMessage(reason: string): string {
  const clean = reason.trim();
  if (!clean) {
    return 'This change needs more than a quick preview edit, so a cloud agent is updating the application.';
  }
  return `This change needs more than a quick preview edit (${clean}), so a cloud agent is updating the application.`;
}

export function classifyBuildRevisionFastEdit(
  feedback: string
): BuildRevisionFastEditClassification {
  const trimmed = feedback.trim();
  const clarification = matchedSignals(trimmed, CLARIFICATION_SIGNALS);
  if (clarification.length > 0) {
    return {
      route: 'full_build',
      agentKind: 'needs_clarification',
      certain: true,
      reason: 'clarification_needed',
      matchedSignals: clarification,
      agentMayEscalate: true,
      escalationReason:
        'The request asks an open question that needs clarification in intake.',
    };
  }

  const structural = matchedSignals(trimmed, STRUCTURAL_SIGNALS);
  if (structural.length > 0) {
    return {
      route: 'full_build',
      agentKind: 'cloud_agent',
      certain: true,
      reason: 'structural_change',
      matchedSignals: structural,
      agentMayEscalate: true,
      escalationReason: `The request touches backend or structural areas (${structural.join(', ')}).`,
    };
  }

  const visual = matchedSignals(trimmed, UI_SIGNALS);
  if (visual.length > 0) {
    return {
      route: 'fast_edit',
      agentKind: 'fast_edit',
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
    agentKind: 'fast_edit',
    certain: false,
    reason: 'uncertain_scope',
    matchedSignals: [],
    agentMayEscalate: true,
  };
}
