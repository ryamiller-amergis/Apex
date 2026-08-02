import { useCallback, useEffect, useRef, useState } from 'react';
import type { WhatsNewOpenMode, WhatsNewState, WhatsNewSurface } from '../../shared/types/whatsNew';
import { useChangelog } from './useChangelog';
import { trackEvent } from '../services/telemetry';

const ALLOWED_TELEMETRY_KEYS = new Set(['version', 'mode', 'surface']);

function allowlistedProps(
  props: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    if (ALLOWED_TELEMETRY_KEYS.has(key) && value != null && value !== '') {
      out[key] = value;
    }
  }
  return out;
}

function emit(name: string, props: Record<string, string | undefined>): void {
  trackEvent(name, allowlistedProps(props));
}

export interface UseWhatsNewStateOptions {
  /** Bootstrap snapshot from GET /api/me/permissions — captured once per session. */
  bootstrap: WhatsNewState | null;
  enabled?: boolean;
}

export interface UseWhatsNewStateResult {
  status: 'loading' | WhatsNewState['status'];
  unread: boolean;
  showOnLogin: boolean;
  currentVersion: string | null;
  /** Pre-acknowledgement last-seen boundary for the history divider. */
  lastSeenVersion: string | null;
  isOpen: boolean;
  openMode: WhatsNewOpenMode | null;
  /** Proactive surfaces (badge/banner/auto-modal) may render. */
  proactive: boolean;
  /** Manual open should show the benign unavailable dialog. */
  manualUnavailable: boolean;
  /**
   * FEAT-005 — bootstrap + changelog evaluation finished so overlay arbitration may run.
   */
  automaticOverlaySettled: boolean;
  /**
   * FEAT-005 — What's New will or did auto-open; Walkthrough must not launch this load.
   */
  blocksAutomaticWalkthrough: boolean;
  open: (mode: WhatsNewOpenMode) => void;
  dismiss: (surface: 'modal' | 'banner') => void;
  setShowOnLogin: (show: boolean) => void;
  closeWithoutAck: () => void;
}

/**
 * Sole client owner for What's New: one load-time snapshot, optimistic ack,
 * surface coordination, and privacy-safe telemetry (FEAT-006 / TBI-010).
 */
export function useWhatsNewState({
  bootstrap,
  enabled = true,
}: UseWhatsNewStateOptions): UseWhatsNewStateResult {
  const [snapshot, setSnapshot] = useState<WhatsNewState | null>(null);
  const [unread, setUnread] = useState(false);
  const [showOnLogin, setShowOnLoginState] = useState(true);
  const [isOpen, setIsOpen] = useState(false);
  const [openMode, setOpenMode] = useState<WhatsNewOpenMode | null>(null);
  const [sessionAcknowledged, setSessionAcknowledged] = useState(false);
  const [capturedVersion, setCapturedVersion] = useState<string | null>(null);
  const [dividerBoundary, setDividerBoundary] = useState<string | null>(null);
  const [autoOpened, setAutoOpened] = useState(false);

  const capturedVersionRef = useRef<string | null>(null);
  const dismissInFlightRef = useRef(false);
  const impressionKeysRef = useRef(new Set<string>());
  const autoOpenTelemetrySentRef = useRef(false);

  // Capture bootstrap once during render — ignore subsequent project-driven payloads.
  if (enabled && bootstrap && !snapshot) {
    setSnapshot(bootstrap);
    setUnread(bootstrap.unread);
    setShowOnLoginState(bootstrap.showOnLogin);
    setCapturedVersion(bootstrap.currentVersion);
    setDividerBoundary(bootstrap.lastSeenVersion);
  }

  // Mirror for stable callbacks — never read this ref during render.
  useEffect(() => {
    capturedVersionRef.current = capturedVersion;
  }, [capturedVersion]);

  const changelogQuery = useChangelog(enabled && !!snapshot);
  const changelogFailed =
    changelogQuery.isError ||
    (changelogQuery.isFetched && !changelogQuery.data);
  const changelogReady = !!changelogQuery.data?.entries?.length;
  const changelogSettled =
    !enabled ||
    !snapshot ||
    changelogQuery.isFetched ||
    changelogQuery.isError;

  const status: UseWhatsNewStateResult['status'] = !snapshot
    ? 'loading'
    : snapshot.status === 'unavailable' || changelogFailed
      ? 'unavailable'
      : snapshot.status;

  const proactive =
    status === 'ready' &&
    unread &&
    !sessionAcknowledged &&
    changelogReady;

  const manualUnavailable =
    isOpen &&
    openMode === 'manual' &&
    (status === 'unavailable' || changelogFailed);

  // Automatic modal — preference only gates this path (not badge/banner).
  if (proactive && showOnLogin && !autoOpened && !isOpen) {
    setAutoOpened(true);
    setOpenMode('automatic');
    setIsOpen(true);
  }

  /** FEAT-005: What's New auto-overlay decision is definitive for this document. */
  const automaticOverlaySettled =
    !enabled || (snapshot != null && (status === 'unavailable' || changelogSettled));

  /** FEAT-005: What's New will or did consume the automatic overlay slot. */
  const blocksAutomaticWalkthrough =
    autoOpened || (automaticOverlaySettled && proactive && showOnLogin);

  useEffect(() => {
    if (!isOpen || openMode !== 'automatic' || autoOpenTelemetrySentRef.current) return;
    autoOpenTelemetrySentRef.current = true;
    emit('whats_new.modal_opened', {
      version: capturedVersionRef.current ?? undefined,
      mode: 'automatic',
    });
  }, [isOpen, openMode]);

  const trackImpression = useCallback((surface: WhatsNewSurface) => {
    if (!proactive) return;
    const version = capturedVersionRef.current ?? 'unknown';
    const key = `${surface}:${version}`;
    if (impressionKeysRef.current.has(key)) return;
    impressionKeysRef.current.add(key);
    const event =
      surface === 'banner' ? 'whats_new.banner_impression' : 'whats_new.badge_impression';
    emit(event, { version, surface });
  }, [proactive]);

  // Expose impression helper via effect when proactive becomes true — callers
  // invoke trackImpression through returned API if needed. Badge/banner components
  // call open() which is enough; we also auto-track badge once when proactive.
  useEffect(() => {
    if (proactive) {
      trackImpression('badge');
      trackImpression('banner');
    }
  }, [proactive, trackImpression]);

  const openModeRef = useRef<WhatsNewOpenMode | null>(null);
  useEffect(() => {
    openModeRef.current = openMode;
  }, [openMode]);

  const open = useCallback((mode: WhatsNewOpenMode) => {
    setOpenMode(mode);
    setIsOpen(true);
    emit('whats_new.modal_opened', {
      version: capturedVersionRef.current ?? undefined,
      mode,
    });
  }, []);

  const closeWithoutAck = useCallback(() => {
    setIsOpen(false);
    setOpenMode(null);
  }, []);

  const dismiss = useCallback((surface: 'modal' | 'banner') => {
    if (dismissInFlightRef.current) return;
    dismissInFlightRef.current = true;

    const version = capturedVersionRef.current;
    const mode = openModeRef.current;
    setUnread(false);
    setSessionAcknowledged(true);
    setIsOpen(false);
    setOpenMode(null);

    emit(
      surface === 'banner' ? 'whats_new.banner_dismissed' : 'whats_new.modal_dismissed',
      { version: version ?? undefined, surface, mode: mode ?? undefined },
    );

    void fetch('/api/me/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(
        version
          ? { lastSeenVersion: version }
          : { markChangelogRead: true },
      ),
    })
      .then(async (res) => {
        if (!res.ok) {
          emit('whats_new.acknowledgement_failed', {
            version: version ?? undefined,
            surface,
          });
        }
      })
      .catch(() => {
        emit('whats_new.acknowledgement_failed', {
          version: version ?? undefined,
          surface,
        });
      })
      .finally(() => {
        dismissInFlightRef.current = false;
      });
  }, []);

  const setShowOnLogin = useCallback((show: boolean) => {
    setShowOnLoginState(show);
    void fetch('/api/me/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ showChangelogOnLogin: show }),
    });
  }, []);

  return {
    status,
    unread: proactive,
    showOnLogin,
    currentVersion: capturedVersion ?? snapshot?.currentVersion ?? null,
    lastSeenVersion: dividerBoundary,
    isOpen,
    openMode,
    proactive,
    manualUnavailable,
    automaticOverlaySettled,
    blocksAutomaticWalkthrough,
    open,
    dismiss,
    setShowOnLogin,
    closeWithoutAck,
  };
}
