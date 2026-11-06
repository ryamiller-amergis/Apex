import type { BuildRequirement } from './types/build';
import type { DesignPreferenceProfile } from './types/designPreferenceProfile';
import type { BuildTaskDomain } from './buildUiClassifier';

export interface BuildVisualBrief {
  version: 1;
  buildRunId: string;
  taskDomain: BuildTaskDomain;
  appName: string;
  visualTone: string;
  density: string;
  componentStrategy: string;
  responsiveTargets: string[];
  screenshotExpectations: string[];
  preferredPatterns: string[];
  avoidedPatterns: string[];
  reuseSearches: string[];
  experienceConcept?: BuildExperienceConcept;
}

export interface BuildExperienceConcept {
  domain: string;
  roles: string[];
  informationArchitecture: string[];
  domainPatterns: string[];
  signatureInteraction: string;
  contentGuidance: string;
  antiGeneric: string[];
}

const ANTI_GENERIC = [
  'No bare stacked forms or a single unstyled table as the main screen.',
  'No lorem ipsum, "Item 1", or empty first-run screens; seed realistic sample data for the domain.',
  'No default MUI blue-on-white with zero hierarchy; establish a clear primary action, a summary band, and supporting detail.',
  'No placeholder product names such as project-name or My App.',
];

const SCHEDULING_HINT =
  /\b(shifts?|schedul\w*|rota|roster|staffing|coverage|time ?off|availability|pick(?:ed)? up)\b/i;

function detectRoles(prompt: string): string[] {
  const roles: string[] = [];
  if (/\bmanagers?\b/i.test(prompt)) roles.push('manager');
  if (/\b(workers?|employees?|staff|crew)\b/i.test(prompt)) roles.push('worker');
  if (/\badmins?\b/i.test(prompt)) roles.push('admin');
  return roles.length > 0 ? roles : ['primary user'];
}

export function synthesizeExperienceConcept(prompt: string): BuildExperienceConcept {
  const roles = detectRoles(prompt);
  if (SCHEDULING_HINT.test(prompt)) {
    const venue = /\b(restaurant|resturaunt|restaraunt|kitchen|bar|cafe|diner)s?\b/i.test(prompt)
      ? 'restaurant'
      : 'workplace';
    return {
      domain: `${venue} shift scheduling`,
      roles,
      informationArchitecture: [
        'Role-aware home: managers land on a weekly coverage board; workers land on "My shifts" with the next shift as a hero card.',
        'Open-shift marketplace: browsable cards grouped by day with role/station, time, duration, and pay or hours.',
        'Manager shift composer in a side drawer or dialog (not a separate bare page), with quick templates for common shifts.',
        'Persistent app shell with branded header, role switcher or role badge, and primary navigation (Schedule, Open shifts, My shifts).',
      ],
      domainPatterns: [
        'Week timeline or day-column board with shift blocks colored by station or role.',
        'Coverage summary chips (open, claimed, understaffed) above the board.',
        'Status chips for shift state: open, claimed, pending approval, completed.',
        'Filters for day, station, and time of day; empty states that explain the next action.',
        'Hours-this-week and upcoming-shift counters for workers.',
      ],
      signatureInteraction:
        'One-tap "Pick up" on an open shift with an optimistic update, a confirmation snackbar, and the shift moving into "My shifts" without a page reload.',
      contentGuidance: `Seed believable ${venue} data: stations such as Line cook, Server, Host, Bartender, Dishwasher; named people; lunch and dinner services across the current week.`,
      antiGeneric: ANTI_GENERIC,
    };
  }
  return {
    domain: 'general product workflow',
    roles,
    informationArchitecture: [
      'Role-aware landing view that shows the most important status first, then the primary action.',
      'Persistent app shell with branded header and clear primary navigation.',
      'Create and edit flows in drawers or dialogs layered over the list, not as bare standalone forms.',
    ],
    domainPatterns: [
      'Summary band of key counts above the main collection.',
      'Card or table collection with status chips, filters, and search.',
      'Helpful empty, loading, and error states.',
    ],
    signatureInteraction:
      'The primary action completes inline with an optimistic update and clear confirmation feedback.',
    contentGuidance: 'Seed realistic sample data so the first screen looks like a product in use.',
    antiGeneric: ANTI_GENERIC,
  };
}

export function visualBriefPath(buildRunId: string): string {
  return `.apex/build/${buildRunId}/visual-brief.json`;
}

function nextId(requirements: BuildRequirement[], kind: BuildRequirement['kind']): string {
  const prefix = kind === 'nfr' ? 'NFR' : kind === 'dod' ? 'DOD' : kind === 'br' ? 'BR' : 'AC';
  let max = 0;
  for (const row of requirements) {
    if (!row.id.startsWith(`${prefix}-`)) continue;
    const n = Number(row.id.slice(prefix.length + 1));
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return `${prefix}-${max + 1}`;
}

export function injectVisualRequirements(
  requirements: BuildRequirement[],
): BuildRequirement[] {
  const hasVisualNfr = requirements.some((row) =>
    /design-system tokens|visual polish|enterprise presentation/i.test(row.text),
  );
  const hasScreenshotDod = requirements.some((row) =>
    /screenshot|playwright|visual snapshot/i.test(row.text),
  );
  const hasIdentityBr = requirements.some((row) =>
    /project-name|placeholder|app name|logo/i.test(row.text),
  );

  const out = [...requirements];
  if (!hasVisualNfr) {
    out.push({
      id: nextId(out, 'nfr'),
      kind: 'nfr',
      text: 'Screens must use catalog surfaces, theme tokens, and responsive spacing that reads as enterprise-ready on phone and desktop widths.',
      retired: false,
    });
  }
  if (!hasScreenshotDod) {
    out.push({
      id: nextId(out, 'dod'),
      kind: 'dod',
      text: 'Implementation includes Playwright visual snapshots at mobile and desktop widths in light and dark modes, stored with the feature tests.',
      retired: false,
    });
  }
  if (!hasIdentityBr) {
    out.push({
      id: nextId(out, 'br'),
      kind: 'br',
      text: 'The application must not ship with template placeholders such as project-name; resolve app identity from the approved project profile.',
      retired: false,
    });
  }
  return out;
}

export function buildVisualBrief(input: {
  buildRunId: string;
  taskDomain: BuildTaskDomain;
  prompt: string;
  profile: DesignPreferenceProfile;
}): BuildVisualBrief {
  const appName = input.profile.appName ?? input.profile.productName ?? 'Application';
  return {
    version: 1,
    buildRunId: input.buildRunId,
    taskDomain: input.taskDomain,
    appName,
    visualTone: input.profile.visualTone ?? 'professional',
    density: input.profile.density ?? 'comfortable',
    componentStrategy:
      'Prefer documented @project-scope/ui catalog components and theme-styled MUI primitives. Use @mui/x-date-pickers for calendar or date surfaces when the dependency is present. Record reuse rationale before custom UI.',
    responsiveTargets: ['375px phone', '1280px desktop'],
    screenshotExpectations: [
      'Capture the primary changed route at 375px and 1280px in light mode.',
      'Capture the primary changed route at 375px in dark mode when color mode is supported.',
    ],
    preferredPatterns: input.profile.preferredPatterns,
    avoidedPatterns: input.profile.avoidedPatterns,
    reuseSearches: [
      'docs/component-catalog.md',
      'packages/ui/src/index.ts',
      'apps/web/src/features/profile',
      input.prompt.toLowerCase().includes('calendar') ? '@mui/x-date-pickers' : 'AppShell',
    ],
    experienceConcept: synthesizeExperienceConcept(input.prompt),
  };
}

function formatExperienceConcept(concept: BuildExperienceConcept): string[] {
  return [
    '',
    '## Experience Concept (design before you code)',
    `The requester wants a modern, product-grade experience, not a scaffold. Domain: ${concept.domain}. Roles: ${concept.roles.join(', ')}.`,
    'Before writing UI code, sketch 2–3 distinct layout concepts internally for the primary screen, pick the one that best serves the roles below, and build that one fully. Name the chosen concept in one sentence in your final message.',
    '- Information architecture:',
    ...concept.informationArchitecture.map((line) => `  - ${line}`),
    '- Domain patterns to include:',
    ...concept.domainPatterns.map((line) => `  - ${line}`),
    `- Signature interaction: ${concept.signatureInteraction}`,
    `- Realistic content: ${concept.contentGuidance}`,
    '- Do not ship:',
    ...concept.antiGeneric.map((line) => `  - ${line}`),
  ];
}

export function formatVisualBriefForPrompt(brief: BuildVisualBrief): string {
  return [
    '## Visual Brief (mandatory for UI work)',
    `- App identity: ${brief.appName}`,
    `- Visual tone: ${brief.visualTone}`,
    `- Density: ${brief.density}`,
    `- Component strategy: ${brief.componentStrategy}`,
    `- Responsive targets: ${brief.responsiveTargets.join(', ')}`,
    `- Screenshot expectations:`,
    ...brief.screenshotExpectations.map((line) => `  - ${line}`),
    brief.preferredPatterns.length > 0
      ? `- Preferred patterns: ${brief.preferredPatterns.join('; ')}`
      : '- Preferred patterns: Use catalog layout primitives before custom grids.',
    brief.avoidedPatterns.length > 0
      ? `- Avoid: ${brief.avoidedPatterns.join('; ')}`
      : '- Avoid: Template placeholders and one-off styled components.',
    `- Reuse searches: ${brief.reuseSearches.join(', ')}`,
    `- If the request describes a product for a specific audience, give it a short, credible product name and use it in the header and page title instead of "${brief.appName}" or a template placeholder.`,
    ...(brief.experienceConcept ? formatExperienceConcept(brief.experienceConcept) : []),
    '',
    '## Visual Self-Review (one repair pass, required)',
    'After the feature works and before emitting evidence, re-read every changed screen component as a reviewer and score it against the Experience Concept:',
    '1. Does the first screen for each role show a summary, a primary action, and populated content within the first viewport at 375px and 1280px?',
    '2. Is there clear visual hierarchy (page title, section headers, cards or surfaces, consistent spacing from theme tokens)?',
    '3. Are the domain patterns and signature interaction present, with loading, empty, and error states?',
    '4. Would a product designer call it a scaffold? If yes, fix the weakest two items, commit, and push before finishing.',
    'List the self-review result in one or two lines in your final message.',
  ].join('\n');
}
