---
name: data-grid-ui
description: Standard Apex data grid layout — shared toolbar (filter pills left, search right), table shell, and row actions. Use when adding or changing tabular admin/list views (Platform Admin, catalogs, registries).
---

# Apex Data Grid UI Standard

When building or updating a **data grid** (tabular list with filters), follow this pattern so views match Interviews, Walkthroughs, and Anchor Management.

## Required building blocks

| Piece | Location | Purpose |
|-------|----------|---------|
| `DataGridToolbar` | `src/client/components/DataGridToolbar.tsx` | Filter area (left) + search (right) |
| `DataGridFilterPills` | same file | **Default** filter control for small enum sets (≤ ~6 options) |
| `DataGridFilterSelect` | same file | **Override** labeled dropdown when pills are awkward (many routes, multi-dimension filters, admin preference) |
| `DataGrid.module.css` | `src/client/components/DataGrid.module.css` | Section header, table wrap, row action buttons |

**Reference implementations:**

- `WalkthroughCatalog.tsx` — lifecycle **pills** + search + Edit/Archive actions column
- `WalkthroughAnchorManagement.tsx` — **dropdowns** for status/route/source/presence + search (dense filter surface)
- `InterviewsDashboard.tsx` — original pill + search layout (card grid; same toolbar tokens)

## Toolbar layout

```
┌─────────────────────────────────────────────────────────────┐
│  [Pill filters …]  OR  [labeled selects …]   [🔍 Search …] │
└─────────────────────────────────────────────────────────────┘
```

### Filter control choice

| Use **pills** (`DataGridFilterPills`) when | Use **dropdowns** (`DataGridFilterSelect`) when |
|--------------------------------------------|------------------------------------------------|
| Few mutually exclusive values (lifecycle, tab status) | Many options (curated routes, long enums) |
| Users switch filters frequently | Several independent dimensions on one row |
| Matches Interviews / Walkthroughs catalog | Anchor-style registry with status + route + source + presence |

Both sit in the **left** `DataGridToolbar` children slot. **Search stays on the right** in all cases.

Rules:

1. **Filters on the left** — pills by default; swap to `DataGridFilterSelect` per filter when the table needs it (document why in PR if non-obvious).
2. **Search on the right** — always `DataGridToolbar` search input (rounded, icon). Never a separate labeled search field above the table.
3. **Separate pill groups** with `filterDivider` when multiple pill groups sit on one row.
4. **Test IDs** — `searchTestId` on toolbar; pills: `testIdPrefix` → `{prefix}-{value}`; selects: `testId` on the `<select>`.

## Table layout

1. Use `gridStyles.section`, `gridStyles.header`, `gridStyles.title`, `gridStyles.hint` for page chrome.
2. Primary CTA (Create, Sync, Add New) in `headerActions` / `buttonPrimary` on the header row.
3. Table: `gridStyles.tableWrap` + `gridStyles.table`.
4. **Actions column** — last column; `gridStyles.rowActions` with `gridStyles.buttonGhost` for Edit / Delete / Archive. Do **not** make the name/title cell a link or button that opens the editor.
5. Empty/loading/error: `gridStyles.empty`, `gridStyles.loading`, `gridStyles.error`.

## Filtering behavior

- Prefer **server-side** filters when the list API supports them (pass params from pill/select state).
- Apply **client-side search** on visible text fields when the API has no search param (substring match on name, title, key, label).
- Show empty copy that distinguishes “no data” vs “no matches for search”.

## Destructive actions

- Row **Delete** or **Archive** must use a confirm modal; never immediate mutation from the grid row.
- Invalidate the relevant TanStack Query catalog key after successful save/delete/archive.

## Do not

- Introduce a second table visual system (custom borders, different search placement, clickable name rows) for admin grids.
- Replace every filter with pills when dropdowns are clearer for that screen.
- Skip `data-testid` on search, filters, row actions, and table root.

## Checklist (copy for PRs)

- [ ] `DataGridToolbar` + pills and/or `DataGridFilterSelect` (justify dropdowns)
- [ ] `DataGrid.module.css` table + header
- [ ] Actions column; name column is plain text
- [ ] Search right-aligned; filters left-aligned
- [ ] Unit tests for search and at least one filter control
- [ ] Query invalidation on mutations
