# Playbook authoring canvas — spike timebox

**Flag:** `playbooks-authoring-canvas`  
**Timebox:** 10 working days after the first weekday a BA can open `/playbooks/definitions/:definitionId` in a project where the flag is enabled.  
**Start date:** _not started — record here when the flag is turned on for the trial project._

## Bar for “usable”

A BA with `playbooks:author` can:

1. Drag `cursor-agent` and `notify` onto the canvas and connect them (PBI-015 a).
2. See a refused self-connection that names the loop (PBI-015 b).
3. Reopen the draft and see nodes where they were last dragged (PBI-015 c).

## Fallback (not built in the spike slice)

If the bar is not met by the end of the tenth working day, stop canvas-only work and schedule an **ordered-list step editor** plus a **generated read-only diagram**. Keep unchanged: step config forms, draft/publish APIs, graph guards, `playbook_version_layouts`, dry-run service, and live run projection.

## Carry-over (must not import `@xyflow/react`)

- `playbookStepPaletteService` / step-types route
- `playbookVersionLayoutService`
- `playbookDryRunService` (when implemented)
- `publishDraft` and `assertGraphWithinGuards`

## Decision

| Date | Outcome | Recorded by |
|------|---------|-------------|
| | _pass or fallback_ | Playbook dependency owner |
