import { computeDiffHunks, mergeSelectedHunks } from './diff';
import type { DiffHunk } from './diff';
import { computeBacklogDiff } from './backlogDiff';
import type { ItemChange } from './backlogDiff';

export type ChangeDecision = 'pending' | 'approved' | 'rejected';

export type ChangeUnitKind = 'markdown-hunk' | 'backlog-item';

export type DesignDocSectionKey = 'design' | 'tech_spec' | 'assumptions';

export interface MarkdownHunkMeta {
  hunk: DiffHunk;
  /** When set, scopes this hunk to a design-doc section (or ADR). */
  docSection?: DesignDocSectionKey | 'adr' | 'content';
}

const DESIGN_DOC_SECTION_LABELS: Record<DesignDocSectionKey, string> = {
  design: 'Design',
  tech_spec: 'Tech Spec',
  assumptions: 'Assumptions',
};

interface MermaidFenceRange {
  start: number;
  end: number;
}

function findMermaidFenceRanges(markdown: string): MermaidFenceRange[] {
  const lines = markdown.split('\n');
  const ranges: MermaidFenceRange[] = [];

  for (let i = 0; i < lines.length; i++) {
    const opening = /^\s*(`{3,}|~{3,})\s*mermaid\b/i.exec(lines[i]);
    if (!opening) continue;

    const marker = opening[1][0];
    const closingPattern = marker === '`' ? /^\s*`{3,}\s*$/ : /^\s*~{3,}\s*$/;
    for (let end = i + 1; end < lines.length; end++) {
      if (!closingPattern.test(lines[end])) continue;
      ranges.push({ start: i, end: end + 1 });
      i = end;
      break;
    }
  }

  return ranges;
}

function mergeMermaidFenceHunks(
  current: string,
  proposed: string,
  hunks: DiffHunk[],
): DiffHunk[] {
  if (hunks.length < 2) return hunks;

  const currentLines = current.split('\n');
  const proposedLines = proposed.split('\n');
  const replacements = new Map<number, DiffHunk>();
  const skipped = new Set<number>();

  for (const range of findMermaidFenceRanges(proposed)) {
    const affected = hunks
      .map((hunk, index) => ({ hunk, index }))
      .filter(({ hunk, index }) => {
        if (skipped.has(index) || replacements.has(index)) return false;
        if (hunk.newCount === 0) {
          return hunk.newStart >= range.start && hunk.newStart < range.end;
        }
        const hunkEnd = hunk.newStart + hunk.newCount;
        return hunk.newStart < range.end && hunkEnd > range.start;
      });

    if (affected.length < 2) continue;

    const firstIndex = affected[0].index;
    const oldStart = Math.min(...affected.map(({ hunk }) => hunk.oldStart));
    const oldEnd = Math.max(...affected.map(({ hunk }) => hunk.oldStart + hunk.oldCount));
    const newStart = Math.min(...affected.map(({ hunk }) => hunk.newStart));
    const newEnd = Math.max(...affected.map(({ hunk }) => hunk.newStart + hunk.newCount));
    const oldText = currentLines.slice(oldStart, oldEnd).join('\n');
    const newText = proposedLines.slice(newStart, newEnd).join('\n');

    replacements.set(firstIndex, {
      id: `mermaid:${affected.map(({ hunk }) => hunk.id).join(':')}`,
      oldStart,
      oldCount: oldEnd - oldStart,
      newStart,
      newCount: newEnd - newStart,
      oldText,
      newText,
    });
    affected.slice(1).forEach(({ index }) => skipped.add(index));
  }

  return hunks.flatMap((hunk, index) => {
    const replacement = replacements.get(index);
    if (replacement) return [replacement];
    return skipped.has(index) ? [] : [hunk];
  });
}

function computeMarkdownDiffHunks(current: string, proposed: string): DiffHunk[] {
  return mergeMermaidFenceHunks(current, proposed, computeDiffHunks(current, proposed));
}

export interface BacklogItemMeta {
  change: ItemChange;
  /** Stable path used for regenerate targeting, e.g. "Epic > Feature > PBI". */
  itemPath: string;
}

export interface ChangeUnit {
  id: string;
  title: string;
  kind: ChangeUnitKind;
  oldText: string;
  newText: string;
  meta: MarkdownHunkMeta | BacklogItemMeta;
  decision: ChangeDecision;
  feedback?: string;
}

function itemPath(change: ItemChange): string {
  return change.parentPath ? `${change.parentPath} > ${change.title}` : change.title;
}

function backlogUnitId(change: ItemChange): string {
  return `backlog:${change.kind}:${change.itemType}:${itemPath(change)}`;
}

function formatBacklogOldText(change: ItemChange): string {
  if (change.kind === 'added') return '(not present)';
  if (change.kind === 'removed') {
    return [
      `${change.itemType}: ${change.title}`,
      ...change.details.map((d) => `${d.label}: ${d.value}`),
    ].join('\n');
  }
  return change.fields.map((f) => `${f.field}: ${f.oldValue}`).join('\n') || change.title;
}

function formatBacklogNewText(change: ItemChange): string {
  if (change.kind === 'removed') return '(removed)';
  if (change.kind === 'added') {
    return [
      `${change.itemType}: ${change.title}`,
      ...change.details.map((d) => `${d.label}: ${d.value}`),
    ].join('\n');
  }
  return change.fields.map((f) => `${f.field}: ${f.newValue}`).join('\n') || change.title;
}

export function buildPrdChangeUnits(
  current: { content: string; backlog?: unknown },
  proposed: { content?: string | null; backlog?: unknown },
): ChangeUnit[] {
  const units: ChangeUnit[] = [];

  if (proposed.content != null && proposed.content !== current.content) {
    const hunks = computeMarkdownDiffHunks(current.content, proposed.content);
    const total = hunks.length;
    hunks.forEach((hunk, idx) => {
      units.push({
        id: `content:${hunk.id}`,
        title: total === 1 ? 'PRD content — change' : `PRD content — change ${idx + 1} of ${total}`,
        kind: 'markdown-hunk',
        oldText: hunk.oldText,
        newText: hunk.newText,
        meta: { hunk },
        decision: 'pending',
      });
    });
  }

  if (proposed.backlog != null && current.backlog != null) {
    const changes = computeBacklogDiff(current.backlog, proposed.backlog);
    const total = changes.length;
    changes.forEach((change, idx) => {
      const path = itemPath(change);
      units.push({
        id: backlogUnitId(change),
        title:
          total === 1
            ? `Backlog — ${change.kind} ${change.itemType}`
            : `Backlog — ${change.kind} ${change.itemType} (${idx + 1} of ${total})`,
        kind: 'backlog-item',
        oldText: formatBacklogOldText(change),
        newText: formatBacklogNewText(change),
        meta: { change, itemPath: path },
        decision: 'pending',
      });
    });
  } else if (proposed.backlog != null && current.backlog == null) {
    // Entire backlog is new — treat as one unit using JSON snapshot
    units.push({
      id: 'backlog:added:all',
      title: 'Backlog — new backlog',
      kind: 'backlog-item',
      oldText: '(empty)',
      newText: JSON.stringify(proposed.backlog, null, 2),
      meta: {
        change: {
          kind: 'added',
          itemType: 'Epic',
          title: '(entire backlog)',
          fields: [],
          details: [],
        },
        itemPath: '(entire backlog)',
      },
      decision: 'pending',
    });
  }

  return units;
}

/**
 * After proposed content regenerates, rebuild units and re-apply prior decisions
 * for units whose ids still match (or whose old/new text still matches).
 * The regenerated unit (and any newly introduced units) stay `pending`.
 */
export function reapplyDecisions(
  nextUnits: ChangeUnit[],
  priorUnits: ChangeUnit[],
  regeneratedUnitId?: string,
): ChangeUnit[] {
  const priorById = new Map(priorUnits.map((u) => [u.id, u]));
  const priorByText = new Map(
    priorUnits.map((u) => [`${u.kind}\0${u.oldText}\0${u.newText}`, u]),
  );

  return nextUnits.map((u) => {
    if (regeneratedUnitId && u.id === regeneratedUnitId) {
      return { ...u, decision: 'pending', feedback: undefined };
    }
    const prior = priorById.get(u.id) ?? priorByText.get(`${u.kind}\0${u.oldText}\0${u.newText}`);
    if (!prior || prior.decision === 'pending') return u;
    // Don't carry over a decision from the regenerated unit onto a replacement
    if (regeneratedUnitId && prior.id === regeneratedUnitId) {
      return { ...u, decision: 'pending', feedback: undefined };
    }
    return { ...u, decision: prior.decision, feedback: prior.feedback };
  });
}

/* ── Backlog selective merge ─────────────────────────────────────────────── */

interface BacklogNode {
  title: string;
  features?: BacklogNode[];
  items?: BacklogNode[];
  [key: string]: unknown;
}

interface BacklogRoot {
  epics?: BacklogNode[];
  [key: string]: unknown;
}

function cloneJson<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

function findEpic(root: BacklogRoot, title: string): BacklogNode | undefined {
  return (root.epics ?? []).find((e) => e.title === title);
}

function findFeature(epic: BacklogNode, title: string): BacklogNode | undefined {
  return (epic.features ?? []).find((f) => f.title === title);
}

function findItem(feature: BacklogNode, title: string): BacklogNode | undefined {
  return (feature.items ?? []).find((i) => i.title === title);
}

function findInProposed(
  proposed: BacklogRoot,
  change: ItemChange,
): BacklogNode | undefined {
  const parts = change.parentPath ? change.parentPath.split(' > ') : [];
  if (change.itemType === 'Epic') {
    return findEpic(proposed, change.title);
  }
  if (change.itemType === 'Feature') {
    const epic = findEpic(proposed, parts[0] ?? '');
    return epic ? findFeature(epic, change.title) : undefined;
  }
  // PBI / Item
  const epic = findEpic(proposed, parts[0] ?? '');
  const feature = epic && parts[1] ? findFeature(epic, parts[1]) : undefined;
  return feature ? findItem(feature, change.title) : undefined;
}

function removeNode(parentList: BacklogNode[] | undefined, title: string): void {
  if (!parentList) return;
  const idx = parentList.findIndex((n) => n.title === title);
  if (idx >= 0) parentList.splice(idx, 1);
}

function applyApprovedChange(
  result: BacklogRoot,
  proposed: BacklogRoot,
  change: ItemChange,
): void {
  const parts = change.parentPath ? change.parentPath.split(' > ') : [];

  if (change.kind === 'added') {
    const node = findInProposed(proposed, change);
    if (!node) return;
    if (change.itemType === 'Epic') {
      result.epics = result.epics ?? [];
      if (!findEpic(result, change.title)) result.epics.push(cloneJson(node));
      return;
    }
    if (change.itemType === 'Feature') {
      const epic = findEpic(result, parts[0] ?? '');
      if (!epic) return;
      epic.features = epic.features ?? [];
      if (!findFeature(epic, change.title)) epic.features.push(cloneJson(node));
      return;
    }
    const epic = findEpic(result, parts[0] ?? '');
    const feature = epic && parts[1] ? findFeature(epic, parts[1]) : undefined;
    if (!feature) return;
    feature.items = feature.items ?? [];
    if (!findItem(feature, change.title)) feature.items.push(cloneJson(node));
    return;
  }

  if (change.kind === 'removed') {
    if (change.itemType === 'Epic') {
      removeNode(result.epics, change.title);
      return;
    }
    if (change.itemType === 'Feature') {
      const epic = findEpic(result, parts[0] ?? '');
      if (epic) removeNode(epic.features, change.title);
      return;
    }
    const epic = findEpic(result, parts[0] ?? '');
    const feature = epic && parts[1] ? findFeature(epic, parts[1]) : undefined;
    if (feature) removeNode(feature.items, change.title);
    return;
  }

  // modified — replace node with proposed version
  const proposedNode = findInProposed(proposed, change);
  if (!proposedNode) return;

  if (change.itemType === 'Epic') {
    const idx = (result.epics ?? []).findIndex((e) => e.title === change.title);
    if (idx >= 0 && result.epics) {
      // Preserve nested features from current result unless also changed elsewhere;
      // take proposed epic fields but keep current features if proposed omits children diffs.
      const currentFeatures = result.epics[idx].features;
      result.epics[idx] = {
        ...cloneJson(proposedNode),
        features: proposedNode.features ?? currentFeatures,
      };
    }
    return;
  }

  if (change.itemType === 'Feature') {
    const epic = findEpic(result, parts[0] ?? '');
    if (!epic?.features) return;
    const idx = epic.features.findIndex((f) => f.title === change.title);
    if (idx >= 0) {
      const currentItems = epic.features[idx].items;
      epic.features[idx] = {
        ...cloneJson(proposedNode),
        items: proposedNode.items ?? currentItems,
      };
    }
    return;
  }

  const epic = findEpic(result, parts[0] ?? '');
  const feature = epic && parts[1] ? findFeature(epic, parts[1]) : undefined;
  if (!feature?.items) return;
  const idx = feature.items.findIndex((i) => i.title === change.title);
  if (idx >= 0) {
    feature.items[idx] = cloneJson(proposedNode);
  }
}

/**
 * Merge backlog by starting from current and applying only approved item changes
 * from the proposed backlog.
 */
export function mergeBacklogSelective(
  currentBacklog: unknown,
  proposedBacklog: unknown,
  units: ChangeUnit[],
): unknown {
  if (proposedBacklog == null) return currentBacklog;
  if (currentBacklog == null) {
    const allApproved = units
      .filter((u) => u.kind === 'backlog-item')
      .every((u) => u.decision === 'approved');
    return allApproved ? proposedBacklog : currentBacklog;
  }

  const result = cloneJson(currentBacklog) as BacklogRoot;
  const proposed = proposedBacklog as BacklogRoot;

  for (const unit of units) {
    if (unit.kind !== 'backlog-item' || unit.decision !== 'approved') continue;
    const meta = unit.meta as BacklogItemMeta;
    if (meta.itemPath === '(entire backlog)') {
      return cloneJson(proposedBacklog);
    }
    applyApprovedChange(result, proposed, meta.change);
  }

  return result;
}

export interface MergedPrdProposal {
  content?: string;
  backlogJson?: unknown;
}

/**
 * Produce the final content/backlog to write on Finish, based on unit decisions.
 * - Pending units are treated as rejected (keep live).
 * - If no content units were approved and content was proposed, keep current content.
 * - If all content units rejected (or none approved), omit content (server keeps live).
 */
function mergeMarkdownFromUnits(
  current: string,
  proposed: string | null | undefined,
  units: ChangeUnit[],
): string | undefined {
  if (proposed == null) return undefined;
  const contentUnits = units.filter((u) => u.kind === 'markdown-hunk');
  if (contentUnits.length === 0) return current;
  const approvedIds = new Set(
    contentUnits
      .filter((u) => u.decision === 'approved')
      .map((u) => (u.meta as MarkdownHunkMeta).hunk.id),
  );
  const hunks = contentUnits.map((u) => (u.meta as MarkdownHunkMeta).hunk);
  return mergeSelectedHunks(current, hunks, approvedIds);
}

export function mergePrdProposalFromUnits(
  current: { content: string; backlog?: unknown },
  proposed: { content?: string | null; backlog?: unknown },
  units: ChangeUnit[],
): MergedPrdProposal {
  const result: MergedPrdProposal = {};

  const contentUnits = units.filter((u) => {
    if (u.kind !== 'markdown-hunk') return false;
    const section = (u.meta as MarkdownHunkMeta).docSection;
    return !section || section === 'content';
  });
  const content = mergeMarkdownFromUnits(current.content, proposed.content, contentUnits);
  if (content !== undefined) result.content = content;

  const backlogUnits = units.filter((u) => u.kind === 'backlog-item');
  if (proposed.backlog != null && backlogUnits.length > 0) {
    result.backlogJson = mergeBacklogSelective(current.backlog, proposed.backlog, backlogUnits);
  }

  return result;
}

function pushMarkdownSectionUnits(
  units: ChangeUnit[],
  sectionKey: DesignDocSectionKey | 'adr' | 'content',
  label: string,
  current: string,
  proposed: string | null | undefined,
): void {
  if (proposed == null || proposed === current) return;
  const hunks = computeMarkdownDiffHunks(current, proposed);
  const total = hunks.length;
  hunks.forEach((hunk, idx) => {
    units.push({
      id: `${sectionKey}:${hunk.id}`,
      title: total === 1 ? `${label} — change` : `${label} — change ${idx + 1} of ${total}`,
      kind: 'markdown-hunk',
      oldText: hunk.oldText,
      newText: hunk.newText,
      meta: { hunk, docSection: sectionKey },
      decision: 'pending',
    });
  });
}

export function buildDesignDocChangeUnits(
  current: { design: string; techSpec: string; assumptions: string },
  proposed: {
    design?: string | null;
    techSpec?: string | null;
    assumptions?: string | null;
  },
): ChangeUnit[] {
  const units: ChangeUnit[] = [];
  pushMarkdownSectionUnits(units, 'design', DESIGN_DOC_SECTION_LABELS.design, current.design, proposed.design);
  pushMarkdownSectionUnits(
    units,
    'tech_spec',
    DESIGN_DOC_SECTION_LABELS.tech_spec,
    current.techSpec,
    proposed.techSpec,
  );
  pushMarkdownSectionUnits(
    units,
    'assumptions',
    DESIGN_DOC_SECTION_LABELS.assumptions,
    current.assumptions,
    proposed.assumptions,
  );
  return units;
}

export interface MergedDesignDocProposal {
  designContent?: string;
  techSpecContent?: string;
  assumptionsContent?: string;
}

export function mergeDesignDocProposalFromUnits(
  current: { design: string; techSpec: string; assumptions: string },
  proposed: {
    design?: string | null;
    techSpec?: string | null;
    assumptions?: string | null;
  },
  units: ChangeUnit[],
): MergedDesignDocProposal {
  const result: MergedDesignDocProposal = {};
  const bySection = (section: DesignDocSectionKey) =>
    units.filter(
      (u) => u.kind === 'markdown-hunk' && (u.meta as MarkdownHunkMeta).docSection === section,
    );

  if (proposed.design != null) {
    result.designContent = mergeMarkdownFromUnits(current.design, proposed.design, bySection('design'));
  }
  if (proposed.techSpec != null) {
    result.techSpecContent = mergeMarkdownFromUnits(
      current.techSpec,
      proposed.techSpec,
      bySection('tech_spec'),
    );
  }
  if (proposed.assumptions != null) {
    result.assumptionsContent = mergeMarkdownFromUnits(
      current.assumptions,
      proposed.assumptions,
      bySection('assumptions'),
    );
  }
  return result;
}

export function buildAdrChangeUnits(
  currentContent: string,
  proposedContent: string | null | undefined,
): ChangeUnit[] {
  const units: ChangeUnit[] = [];
  pushMarkdownSectionUnits(units, 'adr', 'ADR', currentContent, proposedContent);
  return units;
}

export function mergeAdrProposalFromUnits(
  currentContent: string,
  proposedContent: string | null | undefined,
  units: ChangeUnit[],
): { content?: string } {
  const content = mergeMarkdownFromUnits(currentContent, proposedContent, units);
  return content !== undefined ? { content } : {};
}

export function allUnitsDecided(units: ChangeUnit[]): boolean {
  return units.length > 0 && units.every((u) => u.decision !== 'pending');
}

export function countDecisions(units: ChangeUnit[]): {
  approved: number;
  rejected: number;
  pending: number;
} {
  let approved = 0;
  let rejected = 0;
  let pending = 0;
  for (const u of units) {
    if (u.decision === 'approved') approved++;
    else if (u.decision === 'rejected') rejected++;
    else pending++;
  }
  return { approved, rejected, pending };
}
