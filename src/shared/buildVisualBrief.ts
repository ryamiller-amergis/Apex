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
  };
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
    '',
    'Before emitting evidence, render the changed screen, review hierarchy and spacing, and repair anything that reads as a bare scaffold.',
  ].join('\n');
}
