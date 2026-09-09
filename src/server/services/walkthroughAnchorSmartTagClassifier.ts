/**
 * In-process smart-tag classifier that implements the walkthrough-anchor-smart-tagging
 * skill rubric from evidence Apex already extracts (testId, snippets, owning pages).
 */

import {
  isValidSmartTag,
  normalizeSmartTags,
  type WalkthroughAnchorAiProvenance,
  type WalkthroughAnchorSourceLocation,
} from '../../shared/types/walkthroughAnchorRegistry';
import type { WalkthroughRegistryPlacement } from '../../shared/walkthroughAnchors';
import { WALKTHROUGH_REGISTRY_PLACEMENTS } from '../../shared/walkthroughAnchors';
import { isWalkthroughRoute } from '../../shared/walkthroughRoutes';
import { humanizeWalkthroughTestId, inferSuggestedRoute } from './walkthroughAnchorSyncHeuristics';

export const ANCHOR_CLASSIFIER_MODEL = 'anchor-classifier';
export const ANCHOR_CLASSIFIER_SKILL_PATH =
  '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md';
/** Rows at or above this band are review-ready; below are optional background AI leftovers. */
export const ANCHOR_CLASSIFIER_AI_THRESHOLD = 0.55;

const TOKEN_SPLIT = /[^a-z0-9]+/g;

const ACTION_TOKENS = new Set([
  'open',
  'edit',
  'save',
  'dismiss',
  'close',
  'cancel',
  'navigate',
  'filter',
  'create',
  'add',
  'approve',
  'reject',
  'submit',
  'delete',
  'remove',
  'search',
  'select',
  'toggle',
  'upload',
  'download',
  'export',
  'import',
  'sync',
  'refresh',
]);

const UI_TOKENS = new Set([
  'button',
  'btn',
  'menu',
  'item',
  'modal',
  'dialog',
  'section',
  'tab',
  'input',
  'field',
  'avatar',
  'header',
  'nav',
  'sidebar',
  'fab',
  'toast',
  'banner',
  'table',
  'row',
  'card',
  'panel',
  'form',
  'checkbox',
  'radio',
  'select',
  'dropdown',
  'link',
  'icon',
  'trigger',
]);

const DOMAIN_HINTS: Array<{ match: RegExp; tag: string }> = [
  { match: /\bprofile\b/, tag: 'profile' },
  { match: /\bnotification/, tag: 'notifications' },
  { match: /\bstandup\b/, tag: 'standup' },
  { match: /\bcalendar\b/, tag: 'calendar' },
  { match: /\bbacklog\b|\bprd\b|\binterview\b/, tag: 'backlog' },
  { match: /\badmin\b|\brbac\b|\broles?\b|\busers?\b|\bgroups?\b/, tag: 'admin' },
  { match: /\bwalkthrough\b|\bcoachmark\b|\btour\b/, tag: 'walkthrough' },
  { match: /\bchangelog\b|\bwhats-?new\b/, tag: 'changelog' },
  { match: /\bado\b|azure.?devops|work.?item/, tag: 'ado' },
  { match: /\bfeature.?request/, tag: 'feature-requests' },
  { match: /\bdesign.?module/, tag: 'design-module' },
  { match: /\bload.?test/, tag: 'load-tests' },
  { match: /\bai.?cost|cost.?analytics/, tag: 'ai-cost' },
  { match: /\bhome\b|agent.?home|ask.?apex/, tag: 'home' },
  { match: /\bplanning\b|roadmap|dev.?stats/, tag: 'planning' },
];

export interface ClassifierOwningPageEntry {
  component: string;
  routePattern: string;
  suggestedRoute: string;
  moduleKey: string;
  moduleLabel: string;
}

export interface ClassifyWalkthroughAnchorInput {
  testId: string;
  sourceLocations?: readonly WalkthroughAnchorSourceLocation[] | null;
  codeSnippets?: readonly string[] | null;
  owningPageEntries?: readonly ClassifierOwningPageEntry[] | null;
}

export interface ClassifyWalkthroughAnchorResult {
  label: string;
  suggestedRoute: string | null;
  allowedPlacements: WalkthroughRegistryPlacement[];
  smartTags: string[];
  aiProvenance: WalkthroughAnchorAiProvenance;
}

function tokenize(value: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const withCamelBreaks = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  for (const raw of withCamelBreaks.toLowerCase().split(TOKEN_SPLIT)) {
    const token = raw.trim();
    if (token.length < 2 || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function pushUnique(tags: string[], tag: string): void {
  const normalized = tag.trim().toLowerCase();
  if (!isValidSmartTag(normalized)) return;
  if (tags.includes(normalized)) return;
  tags.push(normalized);
}

function primarySourceLocation(
  locations: readonly WalkthroughAnchorSourceLocation[] | null | undefined,
): WalkthroughAnchorSourceLocation | null {
  return locations?.[0] ?? null;
}

function pickOwningEntry(
  entries: readonly ClassifierOwningPageEntry[] | null | undefined,
): ClassifierOwningPageEntry | null {
  if (!entries || entries.length === 0) return null;
  if (entries.length === 1) return entries[0];
  return [...entries].sort(
    (a, b) => b.suggestedRoute.length - a.suggestedRoute.length,
  )[0];
}

function resolveSuggestedRoute(
  testId: string,
  sourcePath: string,
  owning: readonly ClassifierOwningPageEntry[] | null | undefined,
): string | null {
  const picked = pickOwningEntry(owning);
  if (picked && isWalkthroughRoute(picked.suggestedRoute)) {
    return picked.suggestedRoute;
  }
  return inferSuggestedRoute(testId, sourcePath);
}

function resolveConfidence(input: {
  uniqueOwningPage: boolean;
  sharedOwner: boolean;
  curatedRoute: boolean;
}): number {
  if (input.uniqueOwningPage && input.curatedRoute) return 0.9;
  if (input.curatedRoute) return 0.7;
  if (input.sharedOwner) return 0.42;
  return 0.4;
}

function inferSmartTags(
  testId: string,
  sourcePath: string,
  suggestedRoute: string | null,
  snippets: string,
  owningModuleLabel: string,
): string[] {
  const tags: string[] = [];
  const tokenSource = `${testId} ${sourcePath} ${suggestedRoute ?? ''} ${owningModuleLabel} ${snippets}`;
  const haystack = tokenSource.toLowerCase();
  const tokens = tokenize(tokenSource);

  // Evidence-first: meaningful testId tokens (length ≥ 3) must appear.
  for (const token of tokenize(testId)) {
    if (token.length >= 3) pushUnique(tags, token);
  }

  for (const hint of DOMAIN_HINTS) {
    if (hint.match.test(haystack)) pushUnique(tags, hint.tag);
  }

  for (const token of tokens) {
    if (ACTION_TOKENS.has(token)) {
      pushUnique(tags, token === 'add' ? 'create' : token === 'close' ? 'dismiss' : token);
    }
    if (UI_TOKENS.has(token)) {
      if (token === 'btn') pushUnique(tags, 'button');
      else if (token === 'menu' || token === 'item') pushUnique(tags, 'menu-item');
      else if (token === 'dialog') pushUnique(tags, 'modal');
      else if (token === 'nav') pushUnique(tags, 'header');
      else pushUnique(tags, token);
    }
  }

  if (/\berror|warning|fail|troubleshoot\b/.test(haystack)) {
    pushUnique(tags, 'troubleshoot');
  }
  if (/\bsettings|preference|config\b/.test(haystack)) {
    pushUnique(tags, 'settings');
  }
  if (/\bonboard|getting.?started|tour\b/.test(haystack)) {
    pushUnique(tags, 'onboarding');
  }

  if (/\badmin|super.?admin|platform.?admin\b/.test(haystack)) {
    pushUnique(tags, 'super-admin');
  } else {
    pushUnique(tags, 'all-users');
  }

  if (
    !tags.some(
      (t) =>
        t === 'discover' ||
        t === 'configure' ||
        t === 'complete-task' ||
        t === 'troubleshoot' ||
        t === 'announce',
    )
  ) {
    pushUnique(tags, tags.includes('troubleshoot') ? 'troubleshoot' : 'discover');
  }

  const normalized = normalizeSmartTags(tags).slice(0, 8);
  while (normalized.length < 3) {
    const filler = ['navigation', 'section', 'button'][normalized.length];
    if (filler && !normalized.includes(filler)) normalized.push(filler);
    else break;
  }
  return normalized;
}

export function classifyWalkthroughAnchor(
  input: ClassifyWalkthroughAnchorInput,
): ClassifyWalkthroughAnchorResult {
  const testId = input.testId.trim();
  const primary = primarySourceLocation(input.sourceLocations);
  const sourcePath = primary?.filePath?.trim() ?? '';
  const snippets = (input.codeSnippets ?? []).join('\n');
  const owning = input.owningPageEntries ?? [];
  const uniqueOwningPage = owning.length === 1;
  const sharedOwner = owning.length > 1;
  const picked = pickOwningEntry(owning);
  const suggestedRoute = resolveSuggestedRoute(testId, sourcePath, owning);
  const curatedRoute = suggestedRoute != null && isWalkthroughRoute(suggestedRoute);
  const confidence = resolveConfidence({
    uniqueOwningPage,
    sharedOwner,
    curatedRoute,
  });
  const smartTags = inferSmartTags(
    testId,
    sourcePath,
    suggestedRoute,
    snippets,
    picked?.moduleLabel ?? '',
  );
  const label = humanizeWalkthroughTestId(testId);
  const lineBit =
    primary?.line != null ? `${sourcePath}:${primary.line}` : sourcePath || 'no source path';
  const ownerBit = picked
    ? `owning module ${picked.moduleLabel} (${picked.component})`
    : 'no unique owning page';

  const aiProvenance: WalkthroughAnchorAiProvenance = {
    provider: 'cursor',
    model: ANCHOR_CLASSIFIER_MODEL,
    skillPath: ANCHOR_CLASSIFIER_SKILL_PATH,
    generatedAt: new Date().toISOString(),
    runId: null,
    threadId: null,
    confidence,
    rationale: `Classifier rubric from evidence (${lineBit}; ${ownerBit}; route ${suggestedRoute ?? 'null'}).`,
  };

  return {
    label,
    suggestedRoute,
    allowedPlacements: [...WALKTHROUGH_REGISTRY_PLACEMENTS],
    smartTags,
    aiProvenance,
  };
}

export function isHighConfidenceClassifierProvenance(row: {
  smartTags?: readonly string[] | null;
  aiProvenance?: WalkthroughAnchorAiProvenance | null;
}): boolean {
  if (row.aiProvenance?.model !== ANCHOR_CLASSIFIER_MODEL) return false;
  const confidence = row.aiProvenance.confidence ?? 0;
  const tags = row.smartTags ?? [];
  return confidence >= ANCHOR_CLASSIFIER_AI_THRESHOLD && tags.length > 0;
}
