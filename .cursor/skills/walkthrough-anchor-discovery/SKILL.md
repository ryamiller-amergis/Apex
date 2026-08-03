---
name: Walkthrough Anchor Discovery
description: Searches the Apex client source for a coachable element matching a walkthrough step, and proposes a new catalog anchor draft with tags, route, placements, and evidence
---

# Walkthrough Anchor Discovery

Given a walkthrough **step context** (heading, body, route, intent), search the Apex client source for a coachable UI element that is **not already in the catalog**, and propose a new anchor draft grounded in repository evidence.

This skill is invoked programmatically via the Cursor SDK (mirrors `walkthrough-anchor-smart-tagging`).

## Trigger

Kickoff context in `.ai-pilot/kickoff-context.md` describes the step to coach and lists existing catalog keys to exclude.

## Inputs (from kickoff context)

| Field | Required | Description |
| ----- | -------- | ----------- |
| step | Yes | `{ heading, body, route?, intent? }` for the proposal step needing an anchor |
| curatedRoutes | Yes | Snapshot of allow-listed routes from `walkthroughRoutes.ts` |
| existingCatalogKeys | Yes | Anchor keys / testIds already in the catalog — **must not** propose these |
| accessiblePageModules | No | Page module hints when provided |

## Procedure

1. **Read kickoff context** from `.ai-pilot/kickoff-context.md`.
2. **Search** `src/client/` for coachable elements (`data-testid`, `anchorTestIdProps(...)`) whose labels/copy/routes match the step heading/body/route.
3. **Exclude** any key already listed in `existingCatalogKeys`.
4. **Ground** `suggestedRoute` against `src/shared/walkthroughRoutes.ts` `ROUTE_ENTRIES` (exact match only; never invent routes or entity IDs).
5. **Assign smart tags** using the same controlled rubric as `walkthrough-anchor-smart-tagging` (3–8 lowercase kebab-case tags across domain/action/UI/workflow/intent dimensions). Evidence-first: tokens from `testId` / visible copy of length ≥ 3 must appear when valid.
6. **Choose** `allowedPlacements` from `top | right | bottom | left` based on layout evidence.
7. **Write** `.ai-pilot/output/walkthrough-anchor-discovery.json` using the Write tool.

## Output Schema

Write exactly this JSON shape:

```json
{
  "proposals": [
    {
      "testId": "string — exact data-testid from source",
      "anchorKey": "string — usually matches testId",
      "label": "string — human-readable authoring label",
      "suggestedRoute": "/curated-route or null",
      "allowedPlacements": ["top|right|bottom|left"],
      "smartTags": ["kebab-case-tag", "..."],
      "sourceLocations": [{ "filePath": "src/client/...", "line": 0 }],
      "confidence": 0.0,
      "rationale": "string — evidence citing file paths / UI observed in source"
    }
  ]
}
```

Field requirements:

- `proposals` — 1–5 ranked proposals (best first). Empty array only when no coachable match exists.
- `testId` / `anchorKey` / `label` / `rationale` — required non-empty strings.
- `suggestedRoute` — `null` or an exact curated route.
- `allowedPlacements` — non-empty subset of `top`, `right`, `bottom`, `left`.
- `smartTags` — **3–8** lowercase kebab-case strings.
- `confidence` — finite number in inclusive range **[0, 1]**.
- **No invented / extra fields** at the root or inside a proposal.

## Constraints (MUST follow)

1. **No invented behavior.** Describe only controls verified in source.
2. **Do not propose keys in `existingCatalogKeys`.**
3. **Routes must come from `walkthroughRoutes.ts`.**
4. **Placements are cardinal only.**
5. **Do not wrap output in markdown fences.** Write raw JSON.
6. **Do not ask questions.** Execute silently and write the output file.
7. Prefer elements that are durable coachmark targets (buttons, nav items, section headers) over ephemeral toast/spinner chrome.

## Confidence guidance

| Range | When to use |
| ----- | ----------- |
| `0.85–1.0` | Clear page ownership + visible label matching step intent |
| `0.55–0.84` | Stable `data-testid` with reasonable route/placement inference |
| `0.25–0.54` | Ambiguous / shared layout; author should review carefully |
| `0.0–0.24` | Speculative — only if the ID exists but purpose is unclear |
