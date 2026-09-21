/**
 * The prototype prompt sections that are derived from backlog and design-plan
 * rows rather than from static instruction text.
 *
 * `bedrockService` built these inline, which meant only a caller holding the
 * whole `DesignPrototypeInput` could produce them. The V2 visual lane resolves
 * them on App Service and freezes them into the specification, so both callers
 * need the same wording. Moved here verbatim — a second copy would drift, and
 * the worker reproduces these strings byte-for-byte.
 */
import type { PbiRequirement } from '../../../shared/types/designPrototype';

/** Authoritative design-plan decisions for one feature, as the prompt consumes them. */
export type PrototypePlanInput = Readonly<{
  designBrief?: string;
  decision?: string;
  layoutPattern?: string;
  targetPageTitle?: string;
  primaryComponents?: string[];
  states?: string[];
  pbiContributions?: Array<{ pbiTitle: string; contribution: string }>;
  rationale?: string;
  notes?: string;
}>;

export function buildPrototypePbiSection(
  pbis: ReadonlyArray<PbiRequirement>,
): string {
  return pbis.map((pbi, i) => {
    const parts = [`### PBI ${i + 1}: ${pbi.title}`];
    if (pbi.userTypes?.length) parts.push(`**Applies to user types:** ${pbi.userTypes.join(', ')}`);
    if (pbi.description) parts.push(pbi.description);
    if (pbi.acceptanceCriteria) parts.push(`**Acceptance Criteria:**\n${pbi.acceptanceCriteria}`);
    if (pbi.personaBehaviors?.length) {
      const behaviors = pbi.personaBehaviors
        .map(pb => `- For user types ${pb.userTypes.join(', ')}: ${pb.behavior}`)
        .join('\n');
      parts.push(`**Per-persona behavior:** (same control, different behavior per persona group — render one variant per group; do not collapse)\n${behaviors}`);
    }
    return parts.join('\n');
  }).join('\n\n');
}

/**
 * EXTEND mode needs the existing page's source, its inventory hint, and its
 * screenshot; the NEW-page branch needs none of them and is constant.
 */
export function buildPrototypeScopingSection(input: {
  extendMode: boolean;
  targetRoute?: string;
  pageScreenshot?: { base64: string; mediaType: string };
  existingPageContext?: string;
  targetScreenHint?: string;
  pageScreenshotHint?: string;
}): string {
  const targetScreenHint = input.targetScreenHint ?? '';
  const pageScreenshotHint = input.pageScreenshotHint ?? '';

  return input.extendMode
    ? `### CRITICAL SCOPING RULE — EXTEND an existing page; the EXISTING layout is FIXED ground truth
${targetScreenHint}${pageScreenshotHint}
The existing page is defined by the AUTHORITATIVE source(s) below: the **ACTUAL React source code** at \`${input.targetRoute}\`${input.pageScreenshot ? ' **and the page screenshot (vision input)**' : ''}. These — NOT the feature description or design brief — are the single source of truth for the existing page's layout. You must:
1. **Reproduce the existing page faithfully from the code${input.pageScreenshot ? ' and screenshot' : ''}.** Recreate the REAL structure as accurately as you can: the actual regions, panels, tab bars, and the real entry mechanism. If the page uses per-day cards with Time In / Time Out / Break fields, reproduce per-day cards — do NOT convert them into a generic table/grid, and do NOT introduce rows, columns, or fields (e.g. "Hours", "Regular/Overtime", "Position") that are not present in the actual code/screenshot. Render the reproduced existing areas with muted styling so the new feature stands out, but keep their STRUCTURE true to the real page.
2. **The feature description, PBI requirements, and design brief describe ONLY the DELTA** — the new or changed behavior to add on top of the existing page. Use them solely to decide what to add, disable, grey out, annotate, or modify. **NEVER use the feature/brief wording to infer or redraw the base page layout.** If the brief's wording implies a different layout than the code/screenshot (e.g. it says "grid", "columns", or "rows" but the real page uses cards), the code/screenshot WIN — reproduce the real layout and apply the delta to it.
3. **Add the new feature** in the correct location within the faithfully-reproduced page (the specific control, cell, card, tab, or banner the requirements describe). The new/changed element(s) MUST be rendered in FULL DETAIL with all interactions, styling, and states. Wrap ONLY them in the purple annotation border and \`<!-- NEW_FEATURE:START/END -->\` markers.
4. **DO NOT invent, fabricate, or hallucinate** UI elements that are neither in the existing page code/screenshot nor described in the PBI Requirements.
5. **The four state sections (default / empty / error / loading) apply ONLY to the NEW feature** — the reproduced existing page remains identical across all sections.
6. **IMPORTANT — Existing code/screenshot are READ-ONLY context.** They define the existing layout for this review only. The design doc receives the actual React source code separately and will never see this prototype HTML; the existing page must not be re-implemented or modified.

## Existing Page Code (route: ${input.targetRoute})

${input.existingPageContext}`
    : `### CRITICAL SCOPING RULE — ONLY render what is described; NEVER invent content

You must follow these rules with zero exceptions:
1. **DO NOT invent, fabricate, or hallucinate any UI elements** that are not explicitly mentioned in the PBI Requirements or the feature description above. If a card, widget, table, chart, or section is not described in the requirements, it MUST NOT appear.
2. **The page shell consists of ONLY**: the MaxView left sidebar nav (with the standard role-gated nav items: Home, Companies, Worksites, Users, Shift Scheduler, RTO Management, Coder, Credentials, Document Management, Timecards, Admin Portal, Power BI — only those visible to the relevant persona) and the top header bar (with "Hello, [Name]" + avatar). These are the ONLY existing elements you render. The sidebar and header are shown ONLY for visual context — they are existing shared components that MUST NOT be modified in any downstream implementation.
3. **The content area must contain ONLY the new feature component** described in the PBI Requirements. Do not add other cards, widgets, summaries, charts, schedules, or any content that is not part of this feature.
4. **States apply ONLY to the new feature component** — the sidebar and header remain unchanged across all four sections.
5. **IMPORTANT — The sidebar, header, and page shell are READ-ONLY visual context.** They are rendered in the prototype purely for visual fidelity. When this prototype is used to generate a design doc and implementation code, ONLY the new feature component should be implemented. The sidebar navigation, header bar, and page layout MUST NOT be modified or regenerated — they already exist in the codebase.`;
}

export function buildPrototypePlanSection(input: {
  plan?: PrototypePlanInput;
  extendMode: boolean;
  targetRoute?: string;
}): string {
  const plan = input.plan;
  const hasPlan = Boolean(
    plan && (plan.designBrief || plan.decision || plan.layoutPattern || plan.primaryComponents?.length || plan.states?.length || plan.rationale || plan.notes || plan.pbiContributions?.length),
  );
  if (!hasPlan) return '';

  const parts: string[] = [];
  parts.push('## Approved Design Brief (AUTHORITATIVE — follow exactly)');
  parts.push('');
  parts.push('A designer has reviewed and approved the following design brief for this feature. This brief is authoritative and **overrides any inference you would otherwise make**. Honor it precisely.');
  if (input.extendMode) {
    parts.push('');
    parts.push('**Scope of this brief (EXTEND mode):** this brief is authoritative for the NEW or changed behavior (the delta) ONLY. The EXISTING page layout is defined by the actual page code and screenshot provided below — if any wording here describes the existing layout differently than the real code/screenshot, the code/screenshot win. Do NOT use this brief to redraw the existing page.');
  }
  parts.push('');

  if (plan!.designBrief?.trim()) {
    parts.push(plan!.designBrief.trim());
    parts.push('');
  }

  const meta: string[] = [];
  if (plan!.decision) meta.push(`- **Decision:** ${plan!.decision}${plan!.decision === 'update-page' && input.targetRoute ? ` (extend the existing page at \`${input.targetRoute}\`)` : ''}`);
  if (plan!.targetPageTitle) meta.push(`- **Page title:** ${plan!.targetPageTitle}`);
  if (plan!.layoutPattern) meta.push(`- **Layout pattern:** ${plan!.layoutPattern}`);
  if (plan!.primaryComponents?.length) meta.push(`- **Primary components to use:** ${plan!.primaryComponents.join(', ')}`);
  if (plan!.states?.length) meta.push(`- **States to render:** ${plan!.states.join(', ')}`);
  if (plan!.rationale) meta.push(`- **Rationale:** ${plan!.rationale}`);
  if (plan!.notes?.trim()) meta.push(`- **Reviewer notes (must honor):** ${plan!.notes.trim()}`);
  if (meta.length) {
    parts.push('### Technical details');
    parts.push(...meta);
    parts.push('');
  }

  return parts.join('\n');
}
