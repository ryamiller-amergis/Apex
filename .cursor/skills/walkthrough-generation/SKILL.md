# Walkthrough Generation Skill

Generate a validated, repo-grounded Apex Walkthrough proposal as a single JSON artifact.

## Trigger

Invoked programmatically by `walkthroughGenerationService.ts` via the Cursor SDK. The kickoff context file (`.ai-pilot/kickoff-context.md`) contains the generation intent, project ID, tag-ranked catalog anchor candidates, and any existing draft context.

## Inputs (from kickoff context)

| Field | Required | Description |
|-------|----------|-------------|
| intent | Yes | Natural-language description of the Walkthrough to generate |
| projectId | Yes | Apex project scope |
| Ranked Catalog Anchor Candidates | Yes | Server-ranked approved+active catalog keys with scores/evidence (and optional auto-select) |
| existingDraft | No | Current draft content to improve upon |

## Procedure

1. **Read kickoff context** from `.ai-pilot/kickoff-context.md`.
2. **Inspect the Apex repository** to verify:
   - Available routes: read `src/shared/walkthroughRoutes.ts` and extract the `ROUTE_ENTRIES` array.
   - Available anchors: use **only** `anchorKey` values from the kickoff section `## Ranked Catalog Anchor Candidates` (`rankedCandidates` / `autoSelectedAnchor`). Do **not** invent keys and do **not** pull keys from `walkthroughAnchors.ts` when the ranked catalog list is non-empty.
   - Available image assets: list image files under `public/` (svg, png, jpg, webp, gif). Prefer the kickoff `## Allow-listed Image Assets` section when present.
   - Relevant components/pages: browse `src/client/components/` and `src/client/App.tsx` route definitions to understand what each page shows.
   - Prefer local Read/Glob of known paths and kickoff allow-lists. Avoid broad `search_repo_code` — hung searches abort the run before any proposal is written.
3. **Plan the Walkthrough** steps based on the intent, ensuring every route, anchor key, CTA route, and image path is verified against the repository source files and kickoff allow-lists discovered above.
   - For each likely anchor, search the repository for its exact catalog `testId` and inspect the surrounding component. Look for conditional rendering and accessibility/UI signals such as dialogs, modals, menus, tabs, disclosures, `open` state, and click handlers that reveal the target.
   - Treat `openerAnchorKeys` as catalog-owned reveal metadata for targets hidden inside modals, menus, tabs, or other conditional UI. The runtime clicks those approved+active anchors in order before locating the target.
   - Prefer a catalog candidate whose existing opener chain correctly reveals a hidden target. If that candidate cannot be used, try a visible approved candidate that teaches the same action.
   - A Step cannot define or repair opener relationships. If repository inspection shows a target is hidden and its catalog candidate does not contain the opener keys needed to reveal it, do not guess. Use a visible alternative or a centered Step (`anchorKey` / `anchorPlacement` null). It is acceptable when no safe anchor can be found.
4. **Write the output** to `.ai-pilot/output/walkthrough-generation.json` using the Write tool.

## Output Schema

Write exactly this JSON shape to `.ai-pilot/output/walkthrough-generation.json`:

```json
{
  "internalName": "string — kebab-case identifier",
  "userTitle": "string — user-facing title",
  "whyItMatters": "string — markdown explaining value",
  "steps": [
    {
      "heading": "string — step title",
      "bodyMarkdown": "string — step content in markdown",
      "route": "/curated-route or null",
      "imageUrl": "/allow-listed-asset-path or null",
      "imageAlt": "descriptive alt text when imageUrl is set, else null",
      "ctaLabel": "optional button label or null",
      "ctaRoute": "/curated-route or null",
      "anchorKey": "catalog key from ranked candidates or null",
      "anchorPlacement": "top|right|bottom|left or null"
    }
  ]
}
```

## Persona & Voice — Apex Guide

Write all end-user copy as **Apex Guide**, a warm, encouraging, and professional in-app guide.

- Speak directly to the user as "you."
- Keep `userTitle`, `whyItMatters`, each `heading`, and each `bodyMarkdown` concise, clear, and action-oriented.
- Explain the benefit before or alongside the action so users understand why a step matters.
- Prefer plain, confident language that helps users feel capable without sounding childish or overly promotional.
- Use natural transitions so the walkthrough feels like a friendly guided experience, not a list of system instructions.
- Do not use emojis, jokes, slang, excessive exclamation points, or hype such as "magic" and "supercharge."
- Never let personality introduce unverified claims; every statement must remain grounded in the repository evidence.

## Constraints (MUST follow)

1. **No invented behavior.** Every step must describe functionality that verifiably exists in the Apex codebase. Do not claim features, pages, buttons, or settings that are not in the source.
2. **Routes must come from `walkthroughRoutes.ts`.** Do not invent routes. If a step targets a page, its `route` field must be an exact match from `ROUTE_ENTRIES`.
3. **Anchors must come from ranked catalog candidates.** Only use `anchorKey` values present in the kickoff `rankedCandidates` (or the kickoff `autoSelectedAnchor`). Prefer `autoSelectedAnchor` when it is non-null and fits the step. Use `allowedPlacements` from that candidate for `anchorPlacement`. If the ranked catalog list is empty, set `anchorKey` / `anchorPlacement` to null rather than inventing keys. Do not fall back to `walkthroughAnchors.ts` DOM markers for allow-list keys (Phase 6/7 DB catalog cutover).
   - For hidden targets, cross-reference the candidate with `## Authoring Catalog Anchors`, inspect its exact `testId` at the listed source locations, and require the needed `openerAnchorKeys`. Never invent opener keys in Step output.
4. **Images must exist in `public/`.** Only reference image paths you verified by listing the `public/` directory.
5. **Maximum 20 steps.** Keep walkthroughs focused and actionable.
6. **Alt text is required when imageUrl is set.** Provide descriptive, accessible alt text for every image.
7. **Do not wrap output in markdown fences.** Write raw JSON to the output file.
8. **Do not ask questions.** Execute silently and write the output file.
9. **Follow the Apex Guide persona.** Apply the Persona & Voice rules to every end-user-facing string in the output.

## Evidence Trail

Before writing output, verify each reference by reading the actual source file and confirming the anchor key appears in the ranked catalog kickoff payload. If a route, anchor, or image cannot be confirmed, omit it (set to null) rather than guessing.
