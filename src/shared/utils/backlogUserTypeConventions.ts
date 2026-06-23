/**
 * Canonical rules for `userTypes` / `personaBehaviors` on PRD backlog JSON.
 * Used by validation context, fix prompts, and the PRD assistant so agents
 * score persona coverage on PBIs/features only — not TBIs.
 */
export const BACKLOG_USER_TYPE_CONVENTIONS_MD = [
  '## Backlog user-type conventions',
  '',
  'The backlog uses canonical user-type slugs: **S** (System Admin), **I** (Internal), **C** (Contact), **E** (External), **CO** (Coder), **Q** (QR Scanner), **PA** (Portal Admin), **SC** (Subcontractor).',
  '',
  '- **Features** and **PBIs** (`type: "PBI"`) may have `userTypes` and `personaBehaviors` when there is persona evidence (user story, description, or interview context). These feed design-prototype generation.',
  '- **TBIs** (`type: "TBI"`) are technical/infrastructure work items. They must **NOT** have `userTypes` or `personaBehaviors`. Absence on TBIs is correct — do not penalize, flag as a gap, or suggest adding them.',
  '- When fixing validation gaps: preserve `userTypes` on user-facing PBIs and features; remove (do not add) them on TBIs.',
].join('\n');
