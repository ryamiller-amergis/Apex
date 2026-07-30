---
name: Walkthrough Anchor Smart Tagging
description: Classifies newly discovered walkthrough anchor candidates with evidence-based smart tags, route/label/placement suggestions, confidence, and rationale
---

# Walkthrough Anchor Smart Tagging

Classify **newly discovered** Apex walkthrough anchor candidates. Produce structured smart-tag suggestions grounded in repository evidence — never invent product behavior, routes, or UI that is not in the source.

This skill is invoked programmatically (Wave 2) via the Cursor SDK, mirroring `walkthroughGenerationService.ts`. Wave 1 authors the contract only.

## Trigger

Kickoff context in `.ai-pilot/kickoff-context.md` lists candidate test IDs with source paths/snippets. Classify only those candidates.

## Inputs (from kickoff context)

| Field                 | Required | Description                                                                                                                               |
| --------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| candidates            | Yes      | Array of `{ testId, sourceLocations[], sourceKind?, codeSnippets? }`                                                                      |
| accessiblePageModules | Yes      | All application modules managed from Platform Admin, plus fixed Home/Admin/Profile modules, with page entries and stable suggested routes |
| curatedRoutes         | Yes      | Snapshot of allow-listed routes from `walkthroughRoutes.ts`                                                                               |
| existingCatalogHints  | No       | Existing labels/tags for nearby anchors (do not copy blindly)                                                                             |

## Procedure

1. **Read kickoff context** from `.ai-pilot/kickoff-context.md`.
2. **Inspect the Apex repository** for each candidate:
   - Open the listed `sourceLocations.filePath` files and confirm the `data-testid` / `anchorTestIdProps(...)` occurrence.
   - Starting at the source component, find its import/render references and trace upward until reaching a page entry component from `accessiblePageModules`.
   - When the source is a common component, classify the anchor for the specific page module that renders it. Do not infer ownership from the common component's filename or assign a broad parent module without verifying the reference chain.
   - Use the most specific verified page/workflow in the label, tags, and rationale (for example, `prd-review` for a modal rendered by `PrdReviewView`).
   - Treat a page entry `routePattern` containing `:placeholders` as ownership evidence only. Never emit a placeholder route.
   - Emit the matched page entry's stable `suggestedRoute`; page-specific query routes are preferred over broad module routes.
   - Verify any `suggestedRoute` against `src/shared/walkthroughRoutes.ts` `ROUTE_ENTRIES` (exact match only).
   - Choose `allowedPlacements` from `top | right | bottom | left` based on layout evidence (e.g. header controls → prefer `bottom`; left-nav items → prefer `right`).
3. **Assign smart tags** using the controlled rubric below (3–8 tags).
4. **Write the output** to `.ai-pilot/output/walkthrough-anchor-smart-tagging.json` using the Write tool.

## Controlled tagging rubric

Every suggestion must include **3–8 lowercase kebab-case** tags drawn from these dimensions. Prefer concrete, searchable tokens over vague ones. Cover multiple dimensions when evidence supports it.

| Dimension          | Purpose                         | Example tags                                                                                             |
| ------------------ | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **domain**         | Product area / feature          | `ado`, `profile`, `notifications`, `backlog`, `standup`, `calendar`, `admin`, `walkthrough`, `changelog` |
| **action**         | What the user does              | `open`, `edit`, `save`, `dismiss`, `navigate`, `filter`, `create`, `approve`                             |
| **UI element**     | Control / surface type          | `button`, `menu-item`, `modal`, `section`, `tab`, `input`, `avatar`, `header`, `banner`                  |
| **state / signal** | Condition the coachmark teaches | `error`, `success`, `warning`, `empty`, `loading`                                                        |
| **workflow**       | Journey the control supports    | `onboarding`, `settings`, `review`, `authoring`, `reporting`, `navigation`                               |
| **audience**       | Who typically uses it           | `all-users`, `project-admin`, `super-admin`, `contributor`                                               |
| **intent**         | Coaching purpose                | `discover`, `configure`, `complete-task`, `troubleshoot`, `announce`                                     |

Rules for tags:

- Lowercase kebab-case only (`^[a-z0-9]+(?:-[a-z0-9]+)*$`).
- Deduplicate; do not pad with synonyms just to hit 8.
- Do not invent domains or workflows that the source file does not support.
- Prefer tags that help walkthrough generation match intent → anchors later.
- **Evidence-first (required):** Any meaningful token already present in `testId` / label / visible copy (e.g. `ado-create-error` → include `ado`, `create`, `error`) **must** appear in `smartTags` when it is a valid kebab token of length ≥ 3. Do not replace those with only generic workflow tags like `backlog` / `review` / `modal`.
- If the rationale mentions a product system or failure mode (ADO, error banner, etc.), those same concepts must be reflected as tags.

## Output Schema

Write exactly this JSON shape to `.ai-pilot/output/walkthrough-anchor-smart-tagging.json`:

```json
{
  "suggestions": [
    {
      "testId": "string — exact discovered data-testid",
      "anchorKey": "string — stable allow-list key (usually matches testId)",
      "suggestedLabel": "string — human-readable authoring label",
      "suggestedRoute": "/curated-route or null",
      "allowedPlacements": ["top|right|bottom|left"],
      "smartTags": ["kebab-case-tag", "..."],
      "confidence": 0.0,
      "rationale": "string — evidence citing file paths / UI observed in source"
    }
  ]
}
```

Field requirements:

- `suggestions` — exactly one entry for every input candidate; never return a partial batch.
- `testId` / `anchorKey` / `suggestedLabel` / `rationale` — required non-empty strings.
- `suggestedRoute` — `null` or an exact curated route from `walkthroughRoutes.ts`.
- `allowedPlacements` — non-empty subset of `top`, `right`, `bottom`, `left`.
- `smartTags` — **3–8** lowercase kebab-case strings.
- `confidence` — finite number in inclusive range **[0, 1]**.
- **No invented / extra fields** at the root or inside a suggestion.

## Constraints (MUST follow)

1. **No invented behavior.** Describe only controls and pages verified in source. If evidence is weak, lower confidence and say so in `rationale`; do not fabricate features.
2. **Routes must come from `walkthroughRoutes.ts`.** Never invent routes or entity IDs.
3. **Placements are cardinal only:** `top`, `right`, `bottom`, `left`.
4. **Tags are lowercase kebab-case**, length 3–8 after dedupe.
5. **Do not wrap output in markdown fences.** Write raw JSON.
6. **Do not ask questions.** Execute silently and write the output file.
7. **Never skip a candidate.** Sync already limited the batch to reachable source files. If ownership is shared or ambiguous, choose the closest verified page entry, lower confidence, and explain the ambiguity.
8. **Stay within accessible modules.** Classify candidates only against modules supplied in `accessiblePageModules`; Home, Admin, and Profile are valid fixed modules.

## Confidence guidance

| Range       | When to use                                                                   |
| ----------- | ----------------------------------------------------------------------------- |
| `0.85–1.0`  | Explicit walkthrough marker or clear page ownership + visible label in source |
| `0.55–0.84` | Stable `data-testid` with reasonable route/placement inference                |
| `0.25–0.54` | Ambiguous container / shared layout; Super Admin should review carefully      |
| `0.0–0.24`  | Speculative — only if the ID exists but purpose is unclear                    |

## Evidence trail

Before writing output, verify each reference by reading the actual source file. Cite paths (and line context when helpful) in `rationale`. Use the matched page entry's stable `suggestedRoute` and conservative placements when ownership is ambiguous.
