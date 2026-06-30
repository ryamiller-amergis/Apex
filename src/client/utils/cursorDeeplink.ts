const MAXVIEW_REPO_URL = 'https://dev.azure.com/amergis/_git/MaxView';

/* MWx Design System (component library) Figma file. Used as the source for
 * design-system component instances when building the Figma screen. */
const MWX_DESIGN_SYSTEM_FILE_KEY = 'EDtAXPJZtgxFFoHSZt8deF';

/* "Maxview-Updates" — destination Figma file where new mock pages are added.
 * https://www.figma.com/design/ZsL1t2zBbuBCQDwgVHCvEO/Maxview-Updates */
const MAXVIEW_UX_MOCKS_FILE_KEY = 'ZsL1t2zBbuBCQDwgVHCvEO';
const MAXVIEW_UX_MOCKS_FILE_NAME = 'Maxview-Updates';

export function buildDesignDocKickoffPrompt(adoWorkItemId: number): string {
  return `/design-doc-kickoff ${adoWorkItemId}`;
}

export function buildCursorPromptDeeplink(promptText: string): {
  desktop: string;
  web: string;
} {
  const encoded = encodeURIComponent(promptText);
  return {
    desktop: `cursor://anysphere.cursor-deeplink/prompt?text=${encoded}`,
    web: `https://cursor.com/link/prompt?text=${encoded}`,
  };
}

export function getMaxViewRepoUrl(): string {
  return MAXVIEW_REPO_URL;
}

/* ── Figma import prompt ─────────────────────────────────────────
   Mirrors the work the legacy sessionStart hook used to do silently —
   but as a one-shot prompt the user can review before running.
   The user opens Cursor Desktop, the prompt is prefilled, and they
   press Enter to kick off the Figma export.
──────────────────────────────────────────────────────────────────── */

export interface FigmaImportPromptArgs {
  featureId: string;
  featureTitle: string;
  pagePath: string;
  /** Project name for the ADO API callback (e.g. "MaxView") */
  project: string;
  /** Area path for the ADO API callback (e.g. "MaxView") */
  areaPath: string;
  /** Absolute URL the agent fetches to render the mock for screenshot capture.
   *  Should already include the read-scope agent token as `?token=…` so the
   *  agent can fetch it in production where the localhost auth bypass doesn't
   *  apply. */
  mockHtmlUrl: string;
  /** Server origin used for the update-figma-url callback */
  apiOrigin: string;
  /** Agent token (write scope) that authorizes the update-figma-url callback
   *  in production. Embedded into the callback URL inside the prompt. */
  writeToken?: string;
  /** PBI id when this is a PBI-scoped view; omitted for the feature overview */
  pbiId?: string;
  /** PBI title — combined with featureTitle for the Figma page name */
  pbiTitle?: string;
  /** Azure DevOps work item id when the backlog node is merged to ADO */
  adoWorkItemId?: number;
  /** Link to edit the work item in Azure DevOps */
  adoWorkItemUrl?: string;
  /** Whether the ADO item is the Feature or a PBI */
  adoWorkItemType?: 'Feature' | 'PBI';

  /* ── Semantic context — gives the agent enough information to pick the
        right design-system components when running use_figma + search_design_system,
        rather than blindly guessing from the screenshot alone. ─────────────────── */
  featureDescription?: string;
  pbiDescription?: string;
  acceptanceCriteria?: string[];
  /** AI's UI decision for this mock — informs whether the agent should match an
   *  existing screen pattern (update-page) or build something fresh (new-page). */
  decision?: 'new-page' | 'update-page' | 'no-ui';
  /** Existing app route the mock targets, e.g. "/shift-scheduler". */
  targetPageRoute?: string;
  /** Human-readable page title shown in the mock's shell header. */
  targetPageTitle?: string;
  /** Sub-tabs the mock uses, in display order (e.g. ["Schedule", "Availability"]). */
  targetPageSubTabs?: string[];
  /** Active sub-tab on the mock, if any. */
  targetSubTabActive?: string;
  /** AI's rationale for the layout choice — useful context for component selection. */
  rationale?: string;
}

export function buildFigmaImportPrompt(args: FigmaImportPromptArgs): string {
  const pageName = args.pbiId && args.pbiTitle
    ? `${args.featureTitle} — ${args.pbiTitle}`
    : args.featureTitle;

  const callbackBody = args.pbiId
    ? `{
  "featureId": "${args.featureId}",
  "pbiId": "${args.pbiId}",
  "pagePath": "${args.pagePath}",
  "figmaUrl": "<the Figma page URL from Step 1>",
  "project": "${args.project}",
  "areaPath": "${args.areaPath}"
}`
    : `{
  "featureId": "${args.featureId}",
  "pagePath": "${args.pagePath}",
  "figmaUrl": "<the Figma page URL from Step 1>",
  "project": "${args.project}",
  "areaPath": "${args.areaPath}"
}`;

  /* ── Mock context block — inline semantic info so the agent can pick the right
        design-system components instead of guessing from the screenshot alone. */
  const contextLines: string[] = [];
  contextLines.push(`Feature: "${args.featureTitle}"`);
  if (args.featureDescription?.trim()) {
    contextLines.push(`Feature description: ${args.featureDescription.trim()}`);
  }
  if (args.pbiId && args.pbiTitle) {
    contextLines.push(`PBI: "${args.pbiTitle}"`);
    if (args.pbiDescription?.trim()) {
      contextLines.push(`PBI description: ${args.pbiDescription.trim()}`);
    }
  }
  if (args.acceptanceCriteria && args.acceptanceCriteria.length > 0) {
    contextLines.push(`Acceptance criteria:\n${args.acceptanceCriteria.map(ac => `  - ${ac}`).join('\n')}`);
  }
  if (args.decision) {
    const decisionExplanation = args.decision === 'update-page'
      ? `update-page (this mock extends an existing screen — match its existing patterns/components)`
      : args.decision === 'new-page'
        ? `new-page (this mock introduces a brand-new screen — set the visual baseline thoughtfully)`
        : args.decision;
    contextLines.push(`Decision: ${decisionExplanation}`);
  }
  if (args.targetPageRoute) {
    contextLines.push(`Target route: ${args.targetPageRoute}`);
  }
  if (args.targetPageTitle) {
    contextLines.push(`Page header title: "${args.targetPageTitle}"`);
  }
  if (args.targetPageSubTabs && args.targetPageSubTabs.length > 0) {
    const tabs = args.targetPageSubTabs.map(t => `"${t}"`).join(', ');
    const active = args.targetSubTabActive ? ` (active: "${args.targetSubTabActive}")` : '';
    contextLines.push(`Sub-tabs (in order): ${tabs}${active}`);
  }
  if (args.rationale?.trim()) {
    contextLines.push(`AI's design rationale: ${args.rationale.trim()}`);
  }

  const mockContextSection = `## Mock context (what this screen represents)

${contextLines.join('\n')}

When you run \`use_figma + search_design_system\` in Step 1, use this context to pick semantically appropriate components from the MWx Design System — e.g. if the screen is a scheduling/availability view, prefer scheduling/calendar components over generic grids; if it extends an existing page, mirror the patterns already used on that page.

`;

  const adoSection =
    args.adoWorkItemId != null && args.adoWorkItemType
      ? `## Azure DevOps target

This mock is linked to **${args.adoWorkItemType}** work item **#${args.adoWorkItemId}** in Azure DevOps${args.adoWorkItemUrl ? ` (${args.adoWorkItemUrl})` : ''}. Step 2 persists the Figma URL to the backlog wiki and appends the same link to that ADO work item description.

`
      : '';

  return `Create a Figma design for an approved UI mock and save the URL back to the backlog.

Before you start, read and follow the figma-generate-design skill AND the figma-use skill.

GOAL: Create a screen using the MWx Design System (fileKey: ${MWX_DESIGN_SYSTEM_FILE_KEY}) placed as a new page in the "${MAXVIEW_UX_MOCKS_FILE_NAME}" Figma file (fileKey: ${MAXVIEW_UX_MOCKS_FILE_KEY}). The new page name should be "${pageName}".

${adoSection}${mockContextSection}## Step 1 — Build the Figma design

Run BOTH of these IN PARALLEL:
1. generate_figma_design — capture this URL with outputMode='existingFile', fileKey='${MAXVIEW_UX_MOCKS_FILE_KEY}' ("${MAXVIEW_UX_MOCKS_FILE_NAME}"):
   ${args.mockHtmlUrl}
   Poll every 5s until status='completed'. This produces the pixel-perfect layout reference.
2. use_figma + search_design_system — follow the figma-generate-design skill to build the screen using real components and variables from the MWx Design System library. Use the Mock context above to choose components that match the screen's purpose. Target file: ${MAXVIEW_UX_MOCKS_FILE_KEY} ("${MAXVIEW_UX_MOCKS_FILE_NAME}").

Once both complete: refine the use_figma output to match the layout from generate_figma_design. Transfer any image hashes. Then delete the generate_figma_design capture — it was layout reference only.

Get the Figma page URL of the final use_figma design.

## Step 2 — Save the URL back (backlog wiki + Azure DevOps)

POST ${args.apiOrigin}/api/backlog/update-figma-url${args.writeToken ? `?token=${args.writeToken}` : ''}
Content-Type: application/json

${callbackBody}

This endpoint updates the backlog draft (for the web app) and appends the Figma link to the linked Azure DevOps work item description.

If Step 1 fails for any reason, POST to the same URL with figmaUrl set to null and include an "error" field describing what went wrong.`;
}

export function getMwxDesignSystemFileKey(): string {
  return MWX_DESIGN_SYSTEM_FILE_KEY;
}

export function getMaxViewUxMocksFileKey(): string {
  return MAXVIEW_UX_MOCKS_FILE_KEY;
}
