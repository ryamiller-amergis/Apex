import type { ChangelogEntry } from './changelog';

/** Discriminated bootstrap status for What's New evaluation. */
export type WhatsNewStatus = 'ready' | 'unavailable' | 'seeded';

/**
 * Unified What's New state returned from authenticated bootstrap / acknowledgement.
 * `lastSeenVersion` maps to DB column `last_seen_changelog_version`.
 */
export interface WhatsNewState {
  status: WhatsNewStatus;
  currentVersion: string | null;
  lastSeenVersion: string | null;
  unread: boolean;
  showOnLogin: boolean;
  seeded: boolean;
}

export interface AcknowledgeWhatsNewRequest {
  /** Must equal the current valid bundled release. */
  lastSeenVersion?: string;
  showChangelogOnLogin?: boolean;
  /** Legacy adapter — resolved server-side to the current valid bundled version. */
  markChangelogRead?: boolean;
}

export interface AcknowledgeWhatsNewResponse {
  ok: true;
  whatsNew: WhatsNewState;
}

export type WhatsNewOpenMode = 'automatic' | 'manual';
export type WhatsNewSurface = 'badge' | 'menu' | 'banner' | 'modal';

export type { ChangelogEntry };
