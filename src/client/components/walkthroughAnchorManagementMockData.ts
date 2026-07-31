/**
 * Typed mock catalog for Smart Anchor Management UI shell (Wave 1 Phase 5).
 * Wave 2 replaces this with CRUD/sync hooks.
 */

import {
  WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS,
  type WalkthroughAnchorRegistryRecord,
} from '../../shared/types/walkthroughAnchorRegistry';

const NOW = '2026-07-30T04:00:00.000Z';
const EARLIER = '2026-07-28T12:00:00.000Z';
const MISSING_SINCE = '2026-07-29T18:30:00.000Z';

function seedToRecord(
  seed: (typeof WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS)[number],
  index: number,
): WalkthroughAnchorRegistryRecord {
  return {
    id: `anchor-seed-${String(index + 1).padStart(2, '0')}`,
    anchorKey: seed.anchorKey,
    testId: seed.testId,
    label: seed.label,
    suggestedRoute: seed.suggestedRoute,
    approvedRoute: seed.approvedRoute,
    allowedPlacements: seed.allowedPlacements,
    smartTags: seed.smartTags,
    openerAnchorKeys: seed.openerAnchorKeys ?? [],
    sourceKind: seed.sourceKind,
    sourceLocations: seed.sourceLocations,
    sourceHash: seed.sourceHash,
    reviewStatus: seed.reviewStatus,
    isActive: seed.isActive,
    lastSeenAt: seed.lastSeenAt ?? EARLIER,
    missingSince: seed.missingSince ?? null,
    deletedAt: seed.deletedAt ?? null,
    aiProvenance: seed.aiProvenance ?? null,
    createdBy: seed.createdBy,
    createdAt: EARLIER,
    updatedBy: seed.updatedBy,
    updatedAt: EARLIER,
  };
}

/** Sync-review-only fixtures (not in the main catalog grid until modal save). */
export const MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES: readonly WalkthroughAnchorRegistryRecord[] = [
  {
    id: 'anchor-pending-01',
    anchorKey: 'notification-bell',
    testId: 'notification-bell',
    label: 'Notification bell',
    suggestedRoute: '/home',
    approvedRoute: null,
    allowedPlacements: ['bottom', 'left'],
    smartTags: ['notifications', 'header', 'bell'],
    openerAnchorKeys: [],
    sourceKind: 'data_testid',
    sourceLocations: [
      {
        filePath: 'src/client/components/NotificationBell.tsx',
        line: 42,
        discoveryKind: 'data_testid',
      },
    ],
    sourceHash: 'scan:v1:notification-bell',
    reviewStatus: 'pending',
    isActive: false,
    lastSeenAt: NOW,
    missingSince: null,
    deletedAt: null,
    aiProvenance: {
      provider: 'cursor',
      model: 'composer-2.5',
      skillPath: '.cursor/skills/walkthrough-generation/SKILL.md',
      generatedAt: NOW,
      confidence: 0.82,
      rationale: 'Header control for opening the notification center; high reuse across routes.',
    },
    createdBy: 'scanner',
    createdAt: NOW,
    updatedBy: 'scanner',
    updatedAt: NOW,
  },
  {
    id: 'anchor-pending-02',
    anchorKey: 'ask-apex-composer',
    testId: 'ask-apex-composer-input',
    label: 'Ask Apex composer',
    suggestedRoute: '/home',
    approvedRoute: null,
    allowedPlacements: ['top', 'bottom'],
    smartTags: ['ask-apex', 'chat', 'composer', 'home'],
    openerAnchorKeys: [],
    sourceKind: 'data_testid',
    sourceLocations: [
      {
        filePath: 'src/client/components/AskApexChat.tsx',
        line: 118,
        discoveryKind: 'data_testid',
      },
    ],
    sourceHash: 'scan:v1:ask-apex-composer',
    reviewStatus: 'pending',
    isActive: false,
    lastSeenAt: NOW,
    missingSince: null,
    deletedAt: null,
    aiProvenance: {
      provider: 'bedrock',
      model: 'claude-sonnet',
      skillPath: '.cursor/skills/walkthrough-generation/SKILL.md',
      generatedAt: NOW,
      confidence: 0.64,
      rationale: 'Primary chat input on Agent Home; route affinity is /home.',
    },
    createdBy: 'scanner',
    createdAt: NOW,
    updatedBy: 'scanner',
    updatedAt: NOW,
  },
];

/** Missing / rejected examples layered on top of the seven approved baseline seeds. */
const EXTRA_MOCK_RECORDS: readonly WalkthroughAnchorRegistryRecord[] = [
  {
    id: 'anchor-missing-01',
    anchorKey: 'standup-submit',
    testId: 'standup-submit-update',
    label: 'Standup — Submit update',
    suggestedRoute: '/standup',
    approvedRoute: '/standup',
    allowedPlacements: ['top', 'left'],
    smartTags: ['standup', 'submit', 'ceremony'],
    openerAnchorKeys: [],
    sourceKind: 'explicit',
    sourceLocations: [
      {
        filePath: 'src/client/components/StandupCeremonyView.tsx',
        line: 210,
        discoveryKind: 'explicit',
      },
    ],
    sourceHash: 'baseline:v1:standup-submit',
    reviewStatus: 'approved',
    isActive: true,
    lastSeenAt: EARLIER,
    missingSince: MISSING_SINCE,
    deletedAt: null,
    aiProvenance: null,
    createdBy: 'system',
    createdAt: EARLIER,
    updatedBy: 'scanner',
    updatedAt: MISSING_SINCE,
  },
  {
    id: 'anchor-rejected-01',
    anchorKey: 'dev-only-debug-panel',
    testId: 'dev-debug-panel',
    label: 'Dev debug panel',
    suggestedRoute: '/my-work',
    approvedRoute: null,
    allowedPlacements: ['right'],
    smartTags: ['debug', 'dev-only'],
    openerAnchorKeys: [],
    sourceKind: 'manual',
    sourceLocations: [
      {
        filePath: 'src/client/components/DevWorkbenchView.tsx',
        discoveryKind: 'manual',
      },
    ],
    sourceHash: 'manual:v1:dev-only-debug-panel',
    reviewStatus: 'rejected',
    isActive: false,
    lastSeenAt: null,
    missingSince: null,
    deletedAt: null,
    aiProvenance: {
      provider: 'cursor',
      model: 'composer-2.5',
      skillPath: '.cursor/skills/walkthrough-generation/SKILL.md',
      generatedAt: EARLIER,
      confidence: 0.31,
      rationale: 'Internal debug surface — not suitable for end-user walkthroughs.',
    },
    createdBy: 'admin',
    createdAt: EARLIER,
    updatedBy: 'admin',
    updatedAt: EARLIER,
  },
];

/** Full mock catalog grid: 7 approved seeds + missing/rejected examples (no sync-pending rows). */
export const MOCK_WALKTHROUGH_ANCHOR_REGISTRY: readonly WalkthroughAnchorRegistryRecord[] = [
  ...WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS.map(seedToRecord),
  ...EXTRA_MOCK_RECORDS,
];

/** Review statuses shown in the Anchor Management catalog grid (pending sync rows stay in the modal). */
export const WALKTHROUGH_ANCHOR_CATALOG_GRID_STATUSES = ['approved', 'rejected'] as const;

export function isAnchorCatalogGridRecord(record: WalkthroughAnchorRegistryRecord): boolean {
  return record.reviewStatus !== 'pending';
}

export type AnchorPresenceFilter = 'all' | 'present' | 'missing';

export interface AnchorCatalogCounts {
  total: number;
  approved: number;
  pending: number;
  rejected: number;
  missing: number;
  present: number;
}

export function computeAnchorCatalogCounts(
  records: readonly WalkthroughAnchorRegistryRecord[],
): AnchorCatalogCounts {
  let approved = 0;
  let pending = 0;
  let rejected = 0;
  let missing = 0;
  let present = 0;

  for (const r of records) {
    if (r.reviewStatus === 'approved') approved += 1;
    else if (r.reviewStatus === 'pending') pending += 1;
    else if (r.reviewStatus === 'rejected') rejected += 1;

    if (r.missingSince != null) missing += 1;
    else if (r.lastSeenAt != null) present += 1;
  }

  return {
    total: records.length,
    approved,
    pending,
    rejected,
    missing,
    present,
  };
}

export function filterAnchorCatalog(
  records: readonly WalkthroughAnchorRegistryRecord[],
  opts: {
    search: string;
    status: 'all' | WalkthroughAnchorRegistryRecord['reviewStatus'];
    route: string;
    source: 'all' | WalkthroughAnchorRegistryRecord['sourceKind'];
    presence: AnchorPresenceFilter;
  },
): WalkthroughAnchorRegistryRecord[] {
  const q = opts.search.trim().toLowerCase();
  return records.filter((r) => {
    if (!isAnchorCatalogGridRecord(r)) return false;
    if (opts.status !== 'all' && r.reviewStatus !== opts.status) return false;
    if (opts.source !== 'all' && r.sourceKind !== opts.source) return false;
    if (opts.presence === 'missing' && r.missingSince == null) return false;
    if (opts.presence === 'present' && (r.missingSince != null || r.lastSeenAt == null)) {
      return false;
    }
    if (opts.route) {
      const route = r.approvedRoute ?? r.suggestedRoute ?? '';
      if (route !== opts.route) return false;
    }
    if (!q) return true;
    const haystack = [
      r.anchorKey,
      r.testId,
      r.label,
      r.approvedRoute ?? '',
      r.suggestedRoute ?? '',
      ...r.smartTags,
      ...r.sourceLocations.map((l) => l.filePath),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}
