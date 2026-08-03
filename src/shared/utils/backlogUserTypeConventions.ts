/**
 * Canonical rules for `userTypes` / `personaBehaviors` on PRD backlog JSON.
 * Used by validation context, fix prompts, and the PRD assistant so agents
 * score persona coverage on PBIs/features only — not TBIs.
 */
export const BACKLOG_USER_TYPE_CONVENTIONS_MD = [
  '## Backlog user-type conventions',
  '',
  'Use Apex persona names only: **Product-Owner**, **BA**, **UI/UX**, **Manager**, **Developer**, **QA**, **Platform Admin**, **Project Admin**, **Authenticated User**.',
  '',
  '- Interview or PRD wording **"Super Admin"** maps to **Platform Admin**. Do not invent a separate Super Admin persona and do not flag Super Admin ↔ Platform Admin as a mismatch.',
  '- **Features** and **PBIs** (`type: "PBI"`) may have `userTypes` and `personaBehaviors` when there is persona evidence (user story, description, or interview context). These feed design-prototype generation and are schema-valid — do not score their presence as an `additionalProperties` / schema violation.',
  '- **TBIs** (`type: "TBI"`) are technical/infrastructure work items. They must **NOT** have `userTypes` or `personaBehaviors`. Absence on TBIs is correct — do not penalize, flag as a gap, or suggest adding them.',
  '- Do **not** use MaxView/timeclock slugs (`S`, `I`, `C`, `E`, `CO`, `Q`, `PA`, `SC`) on Apex backlogs.',
  '- When fixing validation gaps: preserve valid Apex `userTypes` on user-facing PBIs and features; remove (do not add) them on TBIs.',
].join('\n');
