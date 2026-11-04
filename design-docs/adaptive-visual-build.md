# Adaptive Visual Build

Build from prompt now separates **hard enterprise constraints** from **creative visual guidance**.

## Hard constraints (unchanged)

- Security, privacy, accessibility, API contracts, and verification evidence remain mandatory.
- Pull requests open only after the requester accepts a preview (`acceptBuild` → `continueAccept`).
- Agents never write approved design preferences directly.

## Visual contract

When intake or requirements look UI-heavy, Apex:

1. Classifies the run as `ui` or `mixed` (`src/shared/buildUiClassifier.ts`).
2. Injects visual NFR/DOD/BR requirements (`src/shared/buildVisualBrief.ts`).
3. Builds a frozen visual brief from the approved per-project design profile (`src/server/services/buildVisualBriefService.ts`).
4. Embeds the brief in the repository agent prompt (`taskCandidateBuilder.ts`).

## Design preference profile

Per repository configuration (`project_design_preference_profiles` + proposals):

- Admins edit approved preferences in Project Settings → Design Preferences.
- Revision feedback can create a **pending proposal** (Build workspace checkbox or API).
- Only an admin **Accept** updates the approved profile.

## Visual quality gate

After code evidence passes, Apex evaluates `visualReview` and snapshot test references in `apex-evidence` (`buildVisualVerificationService.ts`). UI builds fail verification when the gate fails, triggering the existing repair loop.

## Starter template

`templates/full-stack-express` adds optional MUI icons, MUI X date pickers, `PageHeader`, `ContentSurface`, and optional nav icons. Agents should prefer these building blocks but may compose custom UI when they document reuse rationale in evidence.

## Operator checklist

1. Run migration `20261104100000_design-preference-profiles.sql`.
2. Set Design Preferences for each Build-enabled repository configuration.
3. Configure Cursor Cloud Agent environment with Node 24 for repos that require it (separate from this feature).
