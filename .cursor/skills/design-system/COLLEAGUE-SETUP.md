# Apex Design System for Prototypes — Colleague Setup Pack

**Goal:** Make design plans + HTML prototypes for the **Apex** project look like Apex (top header, Apex tokens, Apex routes) — **without changing MaxView**.

---

## Files in this folder (Apex repo only)

| File | Purpose |
|------|---------|
| `SKILL.md` | Authoritative Apex design system + shell + embedded routes (Bedrock design plan + prototypes) |
| `apex-screens.md` | Apex route inventory (for Project Settings `screenInventoryPath`) |
| `COLLEAGUE-SETUP.md` | This instruction sheet |

**Do not put these under the MaxView repo.**  
MaxView already has its own:

- `.cursor/skills/design-system/SKILL.md`
- `.cursor/skills/figma-ui-knowledge-base/clientapp-screens.md`

---

## Where to keep the files

```
Apex/                                      ← THIS repo only
  .cursor/
    skills/
      design-system/
        SKILL.md                 ← required
        apex-screens.md          ← recommended
        COLLEAGUE-SETUP.md       ← handoff notes
```

1. Commit + push to the Apex ADO branch that Project Settings will point at (usually `main` or your integration branch).
2. Apex loads these from **ADO at runtime**, not from your local disk alone — push is required.

---

## Project Settings (Apex project only)

In Apex UI → **Admin → Project Settings** (for the **Apex** project / its skill config row):

| Field | Set to |
|-------|--------|
| Skill Repo | Apex ADO repo name (e.g. `Apex` or `YourAdoProject/Apex`) |
| Skill Branch | Branch that contains the files above |
| Prototype Design System Path | `.cursor/skills/design-system/SKILL.md` |
| Screen Inventory Path | `.cursor/skills/design-system/apex-screens.md` |

Leave the **MaxView** project’s settings alone (they should keep pointing at MaxView’s design-system + `clientapp-screens.md`).

### Isolation guarantee

| Selected project | What Bedrock uses |
|------------------|-------------------|
| **Apex** | Apex `skillRepo` → these files → Apex header + tokens + routes |
| **MaxView** | MaxView `skillRepo` → MaxView design-system → left nav + MaxView routes |

Changing Apex settings does **not** rewrite MaxView generation.

---

## Design plan + screenshots (how to use)

### Design plan

1. Approve / generate a PRD under the **Apex** project.
2. Open **Design Plan** (`/backlog/design-plan/:id`).
3. With Apex skill settings configured, the plan brief should describe **Apex** chrome and can use Apex routes for `update-page`.
4. Edit decisions as needed: `new-page` | `update-page` | `no-ui`.
5. For `update-page`, set **one** Apex route (e.g. `/home`, `/backlog`, `/calendar`) — not MaxView routes like `/Timecard`.

### Screenshots (EXTEND / update-page)

Screenshots are stored in the **Apex database** (`page_screenshots`), keyed by **route string** — not in these skill files.

On Design Plan review, for each `update-page` feature:

1. Confirm `targetRoute` is a real Apex route from `apex-screens.md`.
2. Paste the page URL or route if needed (normalized to a path like `/backlog`).
3. Upload a PNG/JPEG screenshot (**&lt; 2 MB**).
4. Save the plan.

When prototypes generate in EXTEND mode, Apex looks up the screenshot **by that route** and feeds it to Bedrock as vision context.

**Tip:** Use Apex routes consistently (`/home`, `/backlog/prd/:id` patterns as listed). Do not upload MaxView screenshots under Apex routes or vice versa if you want clean EXTEND behavior.

---

## Quick verification checklist

- [ ] Files exist under **Apex** `.cursor/skills/design-system/` (not MaxView).
- [ ] Pushed to the branch configured in Apex Project Settings.
- [ ] Apex project → Prototype Design System Path points at `SKILL.md`.
- [ ] Apex project → Screen Inventory Path points at `apex-screens.md`.
- [ ] MaxView project settings unchanged.
- [ ] Generate a design plan for an **Apex** PRD → brief mentions Apex header / Apex tokens, not MaxView left nav.
- [ ] Generate a prototype → top **Apex** header, colors `#2747D9` / `#F8FAFF`, no MaxView purple sidebar.
- [ ] Generate a **MaxView** PRD prototype → still MaxView left nav (smoke check).

---

## Known caveats (share with eng if needed)

1. If Apex `skillRepo` is set but `SKILL.md` cannot be fetched from ADO, prototype generation **fails loudly** (no silent MaxView fallback).
2. The Interview “screen inventory” API used by some pickers still defaults to MaxView’s inventory in code today — prefer typing / selecting Apex routes from `apex-screens.md` on the design plan, and rely on Project Settings + these files for Bedrock plan/prototype context.
3. EXTEND mode page-source fetch is still more mature for MaxView; for Apex, screenshots + design brief are the main EXTEND signals until page-context fetch is fully project-parameterized.

---

## What to send your colleague

Zip or PR link containing this folder:

```
.cursor/skills/design-system/
  SKILL.md
  apex-screens.md
  COLLEAGUE-SETUP.md   ← start here
```

Ask them to:

1. Merge/push into the **Apex** repo.
2. Point **only the Apex project** skill settings at these paths.
3. Smoke-test Apex vs MaxView PRD prototype generation.
