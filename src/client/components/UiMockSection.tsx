import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  BacklogFeature,
  BacklogPBI,
  BacklogDocumentPayload,
  UiMock,
  UiMockView,
  UiMockDecision,
  UiMockHistoryEntry,
} from '../../shared/types/backlog';
import { UiMockPreview } from './UiMockPreview';
import BeginFigmaImportModal from './BeginFigmaImportModal';
import type { FigmaImportPromptArgs } from '../utils/cursorDeeplink';
import './UiMockSection.css';

/* ── API helpers ─────────────────────────────────────────────── */

interface UiMockApiResult {
  decision: UiMockDecision;
  rationale: string;
  targetPageRoute?: string;
  targetPageTitle?: string;
  targetPageSubTabs?: string[];
  mockHtml?: string;
}

interface PbiViewApiResult extends UiMockApiResult {
  pbiId: string;
  pbiTitle: string;
}

async function apiGenerateUiMock(
  featureId: string,
  document: BacklogDocumentPayload,
  project: string,
  areaPath: string,
  additionalContext?: string
): Promise<UiMockApiResult> {
  const res = await fetch('/api/backlog/generate-ui-mock', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ featureId, document, project, areaPath, additionalContext }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `Generate failed: ${res.status}`);
  }
  return res.json();
}

async function apiRegenerateUiMock(
  featureId: string,
  document: BacklogDocumentPayload,
  feedback: string,
  priorHtml: string,
  priorDecision: UiMockDecision,
  priorTargetRoute: string | undefined,
  priorPageTitle: string | undefined,
  priorSubTabs: string[] | undefined,
  priorActiveSubTab: string | undefined
): Promise<UiMockApiResult> {
  const res = await fetch('/api/backlog/regenerate-ui-mock', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      featureId, document, feedback,
      priorHtml, priorDecision, priorTargetRoute,
      priorPageTitle, priorSubTabs, priorActiveSubTab,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `Regenerate failed: ${res.status}`);
  }
  return res.json();
}

async function apiGeneratePbiView(
  featureId: string,
  pbiId: string,
  document: BacklogDocumentPayload,
  project: string,
  areaPath: string,
  additionalContext?: string,
  featureOverviewHtml?: string
): Promise<PbiViewApiResult> {
  const res = await fetch('/api/backlog/generate-pbi-view', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ featureId, pbiId, document, project, areaPath, additionalContext, featureOverviewHtml }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `Generate PBI view failed: ${res.status}`);
  }
  return res.json();
}

async function apiRegeneratePbiView(
  featureId: string,
  pbiId: string,
  document: BacklogDocumentPayload,
  feedback: string,
  priorHtml: string,
  priorDecision: UiMockDecision,
  priorTargetRoute: string | undefined,
  priorPageTitle: string | undefined,
  priorSubTabs: string[] | undefined,
  priorActiveSubTab: string | undefined
): Promise<PbiViewApiResult> {
  const res = await fetch('/api/backlog/regenerate-pbi-view', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      featureId, pbiId, document, feedback,
      priorHtml, priorDecision, priorTargetRoute,
      priorPageTitle, priorSubTabs, priorActiveSubTab,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `Regenerate PBI view failed: ${res.status}`);
  }
  return res.json();
}

async function apiMarkDesignReady(
  featureId: string,
  pagePath: string,
  project: string,
  areaPath: string,
  pbiId?: string
): Promise<{ designReadyAt: string }> {
  const res = await fetch('/api/backlog/mark-design-ready', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ featureId, pagePath, project, areaPath, pbiId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `Mark design ready failed: ${res.status}`);
  }
  return res.json();
}

async function apiSaveDraft(
  pagePath: string,
  document: BacklogDocumentPayload,
  project: string,
  areaPath: string
): Promise<void> {
  const res = await fetch('/api/backlog/drafts', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pagePath, document, project, areaPath }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `Save failed: ${res.status}`);
  }
}

interface AgentTokenPair {
  readToken: string;
  writeToken: string;
  expiresAt: number;
}

/* Mints short-lived tokens scoped to (featureId, pbiId?) so the Cursor agent —
   which runs on the user's machine, not the server — can fetch the mock HTML
   and POST back the Figma URL when the app is deployed behind auth. In dev
   the localhost bypass already covers this, but the same code path runs in
   both environments for consistency. */
async function apiMintAgentToken(
  featureId: string,
  pbiId?: string
): Promise<AgentTokenPair> {
  const res = await fetch('/api/backlog/mint-agent-token', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ featureId, pbiId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `Mint token failed: ${res.status}`);
  }
  return res.json();
}

/* ── Figma logo icon ────────────────────────────────────────── */

const FigmaIcon: React.FC<{ muted?: boolean }> = ({ muted }) => (
  <svg
    width="12"
    height="18"
    viewBox="0 0 38 57"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    style={{ flexShrink: 0, opacity: muted ? 0.7 : 1 }}
  >
    <path d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z" fill="#1ABCFE"/>
    <path d="M0 47.5a9.5 9.5 0 0 1 9.5-9.5H19v9.5a9.5 9.5 0 0 1-19 0z" fill="#0ACF83"/>
    <path d="M19 0v19h9.5a9.5 9.5 0 0 0 0-19H19z" fill="#FF7262"/>
    <path d="M0 9.5a9.5 9.5 0 0 0 9.5 9.5H19V0H9.5A9.5 9.5 0 0 0 0 9.5z" fill="#F24E1E"/>
    <path d="M0 28.5a9.5 9.5 0 0 0 9.5 9.5H19V19H9.5A9.5 9.5 0 0 0 0 28.5z" fill="#A259FF"/>
  </svg>
);

/* ── Decision badge ─────────────────────────────────────────── */

const DECISION_LABELS: Record<UiMockDecision, string> = {
  'new-page': 'New Page',
  'update-page': 'Update Page',
  'no-ui': 'No UI Needed',
};

const DECISION_CSS: Record<UiMockDecision, string> = {
  'new-page': 'decision-new-page',
  'update-page': 'decision-update-page',
  'no-ui': 'decision-no-ui',
};

/* ── Shared mock body helpers ───────────────────────────────── */

function buildHistoryEntry(
  result: UiMockApiResult,
  version: number,
  feedbackText?: string
): UiMockHistoryEntry {
  return {
    version,
    decision: result.decision,
    rationale: result.rationale,
    targetPageRoute: result.targetPageRoute,
    targetPageTitle: result.targetPageTitle,
    mockHtml: result.mockHtml,
    feedback: feedbackText,
    createdAt: new Date().toISOString(),
  };
}

/* ── MockViewPanel ───────────────────────────────────────────
   Renders the body of a single mock (feature-level OR pbi-level).
   Keeps all per-view state (feedback, selectedVersion, mutations)
   local so each tab is fully independent.
──────────────────────────────────────────────────────────────── */

interface MockViewPanelProps {
  /** 'feature' for the overview tab; 'pbi' for a PBI-scoped tab */
  kind: 'feature' | 'pbi';
  mock: UiMock | UiMockView | null;
  feature: BacklogFeature;
  pbi?: BacklogPBI;
  document: BacklogDocumentPayload;
  pagePath: string;
  project: string;
  areaPath: string;
  onMockChange: (updated: UiMock | UiMockView) => void;
  onDiscard: () => void;
  /** External busy flag — e.g. a parent-level Generate All is in progress */
  externalBusy?: boolean;
  /** When true, hides the empty-state "Generate UI Mock" button — used when a
   *  higher-level "Generate All" action already covers initial generation. */
  suppressEmptyState?: boolean;
}

const MockViewPanel: React.FC<MockViewPanelProps> = ({
  kind,
  mock,
  feature,
  pbi,
  document,
  pagePath,
  project,
  areaPath,
  onMockChange,
  onDiscard,
  externalBusy = false,
  suppressEmptyState = false,
}) => {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [showFigmaModal, setShowFigmaModal] = useState(false);
  /* Tokens minted just before showing the import modal. Tied to the agent's
     fetch URLs in production where the server's localhost bypass doesn't
     apply. Cleared whenever the modal closes so a fresh, unexpired pair is
     minted on the next open. */
  const [agentTokens, setAgentTokens] = useState<AgentTokenPair | null>(null);

  /* Build the args needed by the Figma import modal. The mockHtmlUrl uses
     window.location.origin so it works behind the Vite dev proxy and in
     any future deployment without hard-coding localhost:3001.

     Also passes semantic context (descriptions, decision, route, sub-tabs,
     rationale) so the agent can pick the right design-system components
     when running use_figma + search_design_system. */
  const buildFigmaPromptArgs = (): FigmaImportPromptArgs | null => {
    if (!mock?.mockHtml) return null;
    const apiOrigin = typeof window !== 'undefined' ? window.location.origin : '';
    const params = new URLSearchParams({ pagePath, project, areaPath });
    if (kind === 'pbi' && pbi) params.set('pbiId', pbi.id);

    /* Page-level fields (subtabs, page title) live on the feature mock — fall
       back there when a PBI view doesn't have its own copy. */
    const featureLevelMock = feature.uiMock;
    const targetPageTitle = mock.targetPageTitle ?? featureLevelMock?.targetPageTitle;
    const targetPageRoute = mock.targetPageRoute ?? featureLevelMock?.targetPageRoute;
    const targetPageSubTabs = (mock as UiMock).targetPageSubTabs ?? featureLevelMock?.targetPageSubTabs;
    const targetSubTabActive = (mock as any).targetSubTabActive as string | undefined;

    /* Embed the read-scope token into the mock URL so the Cursor agent can
       fetch it in production without a session cookie. In dev the same URL
       still works via the localhost bypass — the token is just ignored. */
    if (agentTokens?.readToken) params.set('token', agentTokens.readToken);

    return {
      featureId: feature.id,
      featureTitle: feature.title,
      pagePath,
      project,
      areaPath,
      apiOrigin,
      mockHtmlUrl: `${apiOrigin}/api/backlog/mock-html/${encodeURIComponent(feature.id)}?${params.toString()}`,
      writeToken: agentTokens?.writeToken,
      pbiId: kind === 'pbi' && pbi ? pbi.id : undefined,
      pbiTitle: kind === 'pbi' && pbi ? pbi.title : undefined,
      featureDescription: feature.description,
      pbiDescription: kind === 'pbi' && pbi ? pbi.description : undefined,
      acceptanceCriteria: kind === 'pbi' && pbi ? pbi.acceptanceCriteria : undefined,
      decision: mock.decision,
      targetPageRoute,
      targetPageTitle,
      targetPageSubTabs,
      targetSubTabActive,
      rationale: mock.rationale,
    };
  };

  /* ── Mint agent tokens, then open the import modal ──
     The modal renders the prompt with finalized URLs (token query params
     baked in), so we mint first and only show the modal once tokens are
     ready. Errors fall back to surfacing inline (rare — usually transient). */
  const importToFigmaMutation = useMutation({
    mutationFn: () => apiMintAgentToken(feature.id, kind === 'pbi' && pbi ? pbi.id : undefined),
    onSuccess: (tokens) => {
      setAgentTokens(tokens);
      setShowFigmaModal(true);
    },
    onError: (e: Error) => setLocalError(e.message),
  });

  const closeFigmaModal = () => {
    setShowFigmaModal(false);
    setAgentTokens(null);
  };

  const selectedEntry = selectedVersion != null && mock
    ? (selectedVersion === mock.mockVersion
        ? { mockHtml: mock.mockHtml, decision: mock.decision, targetPageRoute: mock.targetPageRoute }
        : mock.history.find(h => h.version === selectedVersion))
    : null;
  const priorHtmlForRegen = selectedEntry?.mockHtml ?? mock?.mockHtml ?? '';
  const priorDecisionForRegen = selectedEntry?.decision ?? mock?.decision;
  // The version number the regenerate will use as its baseline — shown to the
  // user so they know exactly which mock the AI will modify.
  const baseVersionForRegen = selectedVersion ?? mock?.mockVersion;
  const nextVersionForRegen = (mock?.mockVersion ?? 0) + 1;

  /* ── Generate ── */
  const generateMutation = useMutation({
    mutationFn: () => kind === 'pbi' && pbi
      ? apiGeneratePbiView(feature.id, pbi.id, document, project, areaPath)
      : apiGenerateUiMock(feature.id, document, project, areaPath),
    onSuccess: (result) => {
      setLocalError(null);
      const version = 1;
      const entry = buildHistoryEntry(result, version);
      const updated: UiMock | UiMockView = kind === 'pbi' && pbi
        ? { pbiId: pbi.id, pbiTitle: pbi.title, decision: result.decision, rationale: result.rationale,
            targetPageRoute: result.targetPageRoute, targetPageTitle: result.targetPageTitle,
            mockHtml: result.mockHtml, mockVersion: version, status: 'draft', history: [entry] }
        : { ...(mock as UiMock ?? {}), decision: result.decision, rationale: result.rationale,
            targetPageRoute: result.targetPageRoute, targetPageTitle: result.targetPageTitle,
            targetPageSubTabs: result.targetPageSubTabs,
            mockHtml: result.mockHtml, mockVersion: version, status: 'draft', history: [entry] } as UiMock;
      onMockChange(updated);
      queryClient.invalidateQueries({ queryKey: ['backlog-drafts'] });
    },
    onError: (e: Error) => setLocalError(e.message),
  });

  /* ── Regenerate ── */
  const regenerateMutation = useMutation({
    mutationFn: () => {
      if (!mock) throw new Error('No existing mock to regenerate from');
      const decision = priorDecisionForRegen ?? mock.decision;
      const route = selectedEntry?.targetPageRoute ?? mock.targetPageRoute;
      /* Send the page-level state alongside the HTML so the AI knows what
         sub-tabs / page title currently exist (these live in the shell, not
         in the inner HTML, so without this the model has to invent them). */
      const title = (mock as UiMock).targetPageTitle ?? feature.uiMock?.targetPageTitle;
      const subTabs = (mock as UiMock).targetPageSubTabs ?? feature.uiMock?.targetPageSubTabs;
      const activeSubTab = (mock as any).targetSubTabActive as string | undefined;
      return kind === 'pbi' && pbi
        ? apiRegeneratePbiView(feature.id, pbi.id, document, feedback.trim(), priorHtmlForRegen, decision, route, title, subTabs, activeSubTab)
        : apiRegenerateUiMock(feature.id, document, feedback.trim(), priorHtmlForRegen, decision, route, title, subTabs, activeSubTab);
    },
    onSuccess: (result) => {
      setLocalError(null);
      setFeedback('');
      // Land on the just-generated version so the preview reflects the change,
      // even if the user was previewing an older version when they hit regenerate.
      setSelectedVersion(null);
      const version = (mock?.mockVersion ?? 0) + 1;
      const entry = buildHistoryEntry(result, version, feedback.trim());
      const updated: UiMock | UiMockView = {
        ...mock!,
        decision: result.decision,
        rationale: result.rationale,
        targetPageRoute: result.targetPageRoute,
        targetPageTitle: result.targetPageTitle,
        ...(kind === 'feature' && { targetPageSubTabs: result.targetPageSubTabs }),
        mockHtml: result.mockHtml,
        mockVersion: version,
        status: 'draft',
        history: [...(mock!.history ?? []), entry],
      };
      onMockChange(updated);
      queryClient.invalidateQueries({ queryKey: ['backlog-drafts'] });
    },
    onError: (e: Error) => setLocalError(e.message),
  });

  /* ── Approve ── */
  // The version being approved: whatever is currently previewed, or the latest.
  const versionToApprove = selectedVersion ?? mock?.mockVersion;

  const approveMutation = useMutation({
    mutationFn: async () => {
      if (!mock) throw new Error('No mock to approve');
      const endpoint = kind === 'pbi' ? '/api/backlog/approve-pbi-view' : '/api/backlog/approve-mock';
      const base = kind === 'pbi' && pbi
        ? { featureId: feature.id, pbiId: pbi.id, pagePath, project, areaPath }
        : { featureId: feature.id, pagePath, project, areaPath };
      const res = await fetch(endpoint, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...base, approvedVersion: versionToApprove }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(b?.error ?? `Approve failed: ${res.status}`);
      }
      onMockChange({ ...mock, status: 'approved', approvedVersion: versionToApprove ?? mock.mockVersion });
      queryClient.invalidateQueries({ queryKey: ['backlog-drafts'] });
    },
    onSuccess: () => setLocalError(null),
    onError: (e: Error) => setLocalError(e.message),
  });

  /* ── Delete a version from history ── */
  const deleteVersionMutation = useMutation({
    mutationFn: async (version: number) => {
      if (!mock) throw new Error('No mock');
      const res = await fetch('/api/backlog/delete-mock-version', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureId: feature.id,
          pbiId: kind === 'pbi' && pbi ? pbi.id : undefined,
          pagePath, project, areaPath, version,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(b?.error ?? `Delete version failed: ${res.status}`);
      }
      const data = await res.json();
      if (data.discarded) {
        // Last version removed — discard the whole mock
        onDiscard();
      } else {
        onMockChange(data.mock);
        if (version === selectedVersion) setSelectedVersion(null);
      }
      queryClient.invalidateQueries({ queryKey: ['backlog-drafts'] });
    },
    onSuccess: () => setLocalError(null),
    onError: (e: Error) => setLocalError(e.message),
  });

  /* ── Mark Design Ready ── */
  const markDesignReadyMutation = useMutation({
    mutationFn: async () => {
      if (!mock?.figmaUrl) throw new Error('No Figma design to mark ready');
      const result = await apiMarkDesignReady(
        feature.id, pagePath, project, areaPath,
        kind === 'pbi' && pbi ? pbi.id : undefined
      );
      onMockChange({ ...mock, designReady: true, designReadyAt: result.designReadyAt });
      queryClient.invalidateQueries({ queryKey: ['backlog-drafts'] });
    },
    onSuccess: () => setLocalError(null),
    onError: (e: Error) => setLocalError(e.message),
  });

  const isBusy =
    externalBusy ||
    generateMutation.isPending || regenerateMutation.isPending || approveMutation.isPending ||
    markDesignReadyMutation.isPending || deleteVersionMutation.isPending ||
    importToFigmaMutation.isPending;

  /* ── Render ── */
  return (
    <div className="mock-view-panel">
      {/* Panel header: decision badge + status badges */}
      <div className="mock-view-panel__header">
        {mock && (
          <span className={`ui-mock-decision-badge ${DECISION_CSS[mock.decision]}`}>
            {DECISION_LABELS[mock.decision]}
            {mock.decision === 'update-page' && mock.targetPageTitle && (
              <span className="ui-mock-decision-badge__route"> — {mock.targetPageTitle}</span>
            )}
          </span>
        )}
        {mock?.status === 'approved' && (
          <span className="ui-mock-approved-badge">✓ Approved</span>
        )}
        {mock?.designReady && (
          <span className="ui-mock-design-ready-badge" title={mock.designReadyAt ? `Marked ready ${new Date(mock.designReadyAt).toLocaleDateString()}` : undefined}>
            ✓ Design Ready
          </span>
        )}
      </div>

      {localError && <div className="ui-mock-section__error">{localError}</div>}

      {/* Empty state */}
      {!mock && !suppressEmptyState && (
        <div className="ui-mock-section__empty">
          <p className="ui-mock-section__empty-text">
            {kind === 'pbi'
              ? 'Generate a focused UI mock for this PBI only.'
              : 'Ask AI to determine if this feature needs a new page, updates an existing page, or requires no UI — and generate a mid-fidelity mock.'}
          </p>
          <button className="ui-mock-section__btn-generate" onClick={() => { setLocalError(null); generateMutation.mutate(); }} disabled={isBusy}>
            {generateMutation.isPending ? 'Generating…' : 'Generate UI Mock'}
          </button>
        </div>
      )}

      {/* Mock body */}
      {mock && (
        <>
          <div className="ui-mock-section__rationale">{mock.rationale}</div>

          {(mock.mockHtml || mock.history.some(h => h.mockHtml)) && (
            <UiMockPreview
              mock={mock as UiMock}
              feedback={feedback}
              onFeedbackChange={setFeedback}
              onRegenerate={() => { setLocalError(null); regenerateMutation.mutate(); }}
              onSelectVersion={setSelectedVersion}
              onDeleteVersion={(v) => { setLocalError(null); deleteVersionMutation.mutate(v); }}
              isBusy={isBusy}
            />
          )}

          {mock.decision === 'no-ui' && (
            <div className="ui-mock-section__no-ui-notice">
              This feature has no user-facing interface. No mock is needed.
            </div>
          )}

          <div className="ui-mock-section__feedback-block">
            <textarea
              className="ui-mock-section__feedback-input"
              placeholder="Describe requested changes and click Regenerate…"
              value={feedback}
              onChange={e => setFeedback(e.target.value)}
              rows={3}
              disabled={isBusy}
            />
            {feedback.trim() && (
              <div className="ui-mock-section__feedback-hint">
                AI will modify <strong>v{baseVersionForRegen}</strong> in place using your feedback,
                producing <strong>v{nextVersionForRegen}</strong>. Unchanged elements will be preserved.
              </div>
            )}
          </div>

          <div className="ui-mock-section__action-row">
            <button
              className="ui-mock-section__btn-regenerate"
              onClick={() => { setLocalError(null); regenerateMutation.mutate(); }}
              disabled={isBusy || !feedback.trim()}
              title={!feedback.trim() ? 'Enter a comment above to regenerate' : undefined}
            >
              {regenerateMutation.isPending ? 'Regenerating…' : '↻ Regenerate'}
            </button>

            {mock.status === 'draft' && (
              <>
                <button className="ui-mock-section__btn-approve" onClick={() => { setLocalError(null); approveMutation.mutate(); }} disabled={isBusy}
                  title={versionToApprove != null && versionToApprove !== mock.mockVersion ? `Approving version ${versionToApprove} (not the latest)` : undefined}
                >
                  {approveMutation.isPending
                    ? 'Approving…'
                    : versionToApprove != null && versionToApprove !== mock.mockVersion
                      ? `Approve v${versionToApprove}`
                      : 'Approve Mock'}
                </button>
                <button
                  className="ui-mock-section__btn-discard"
                  onClick={() => { if (window.confirm('Discard this mock? This cannot be undone.')) { setLocalError(null); onDiscard(); } }}
                  disabled={isBusy}
                >
                  Discard
                </button>
              </>
            )}

            {mock.status === 'approved' && (
              <>
                {mock.figmaUrl && (
                  <>
                    <a className="ui-mock-section__btn-figma" href={mock.figmaUrl} target="_blank" rel="noopener noreferrer" title="Open Figma design in a new tab">
                      <FigmaIcon />
                      View in Figma
                      <span className="ui-mock-section__btn-figma-arrow">↗</span>
                    </a>
                    {!mock.designReady && (
                      <button
                        className="ui-mock-section__btn-design-ready"
                        onClick={() => { setLocalError(null); markDesignReadyMutation.mutate(); }}
                        disabled={isBusy}
                        title="Mark the Figma design as polished and ready for development"
                      >
                        {markDesignReadyMutation.isPending ? 'Marking…' : '✓ Mark Design Ready'}
                      </button>
                    )}
                  </>
                )}
                {mock.mockHtml && (
                  <button
                    className="ui-mock-section__btn-send-figma"
                    onClick={() => { setLocalError(null); importToFigmaMutation.mutate(); }}
                    disabled={isBusy}
                    title="Open Cursor Desktop with the Figma import prompt prefilled"
                  >
                    <FigmaIcon muted />
                    {importToFigmaMutation.isPending
                      ? 'Preparing…'
                      : mock.figmaUrl ? 'Re-import to Figma' : 'Import to Figma'}
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}

      {/* Figma import modal — opens Cursor Desktop with a prefilled prompt
          mirroring the dev-kickoff flow. Replaces the legacy auto-queue. */}
      {showFigmaModal && (() => {
        const promptArgs = buildFigmaPromptArgs();
        if (!promptArgs) return null;
        const mockTitle = kind === 'pbi' && pbi
          ? pbi.title
          : feature.title + ' (Feature Overview)';
        return (
          <BeginFigmaImportModal
            mockTitle={mockTitle}
            mockKind={kind === 'pbi' ? 'PBI' : 'Feature'}
            isReimport={!!mock?.figmaUrl}
            promptArgs={promptArgs}
            onClose={closeFigmaModal}
            onImportInitiated={() => { /* leave modal open so user sees web fallback */ }}
          />
        );
      })()}
    </div>
  );
};

/* ── Props ──────────────────────────────────────────────────── */

interface UiMockSectionProps {
  feature: BacklogFeature;
  document: BacklogDocumentPayload;
  pagePath: string;
  project: string;
  areaPath: string;
  onFeatureUpdated: (updated: BacklogFeature) => void;
}

/* ── UiMockSection ──────────────────────────────────────────── */

export const UiMockSection: React.FC<UiMockSectionProps> = ({
  feature,
  document,
  pagePath,
  project,
  areaPath,
  onFeatureUpdated,
}) => {
  const queryClient = useQueryClient();

  // PBIs that belong to this feature
  const childPBIs = (document.pbis ?? []).filter(p => p.parentId === feature.id);

  // Active tab: first PBI id (or null when there are no PBIs)
  const [activeTab, setActiveTab] = useState<string | null>(
    () => childPBIs[0]?.id ?? null
  );
  // Progress label shown while "Generate All" is running
  const [generateAllProgress, setGenerateAllProgress] = useState<string | null>(null);
  // Additional context the BA/UX types before clicking "Generate All"
  const [generateAllContext, setGenerateAllContext] = useState('');

  /* ── Save updated feature to wiki ── */
  const saveFeature = async (updated: BacklogFeature) => {
    const updatedDoc: BacklogDocumentPayload = {
      ...document,
      features: document.features.map(f => (f.id === updated.id ? updated : f)),
    };
    await apiSaveDraft(pagePath, updatedDoc, project, areaPath);
    queryClient.invalidateQueries({ queryKey: ['backlog-drafts'] });
    onFeatureUpdated(updated);
  };

  /* ── Generate All: all PBI views in parallel (no feature overview step) ── */
  const generateAllMutation = useMutation({
    mutationFn: async () => {
      if (childPBIs.length === 0) return;
      const ctx = generateAllContext.trim() || undefined;

      setGenerateAllProgress(`Generating ${childPBIs.length} PBI mock${childPBIs.length > 1 ? 's' : ''}…`);

      const existingViews: UiMockView[] = feature.uiMock?.views ?? [];
      const pbiResults = await Promise.allSettled(
        childPBIs.map(pbi =>
          apiGeneratePbiView(feature.id, pbi.id, document, project, areaPath, ctx)
        )
      );

      const updatedViews: UiMockView[] = [...existingViews];
      pbiResults.forEach((r, i) => {
        if (r.status !== 'fulfilled') return;
        const result = r.value;
        const pbi = childPBIs[i];
        const existingViewIdx = updatedViews.findIndex(v => v.pbiId === pbi.id);
        const existingView = existingViewIdx >= 0 ? updatedViews[existingViewIdx] : undefined;
        const viewVersion = (existingView?.mockVersion ?? 0) + 1;
        const entry = buildHistoryEntry(result, viewVersion);
        const view: UiMockView = {
          ...(existingView ?? {}),
          pbiId: pbi.id,
          pbiTitle: pbi.title,
          decision: result.decision,
          rationale: result.rationale,
          targetPageRoute: result.targetPageRoute,
          targetPageTitle: result.targetPageTitle,
          mockHtml: result.mockHtml,
          mockVersion: viewVersion,
          status: 'draft',
          history: [...(existingView?.history ?? []), entry],
        };
        if (existingViewIdx >= 0) updatedViews[existingViewIdx] = view;
        else updatedViews.push(view);
      });

      const existingMock = feature.uiMock;
      const finalMock: UiMock = existingMock
        ? { ...existingMock, views: updatedViews }
        : { decision: 'new-page', rationale: '', mockVersion: 0, status: 'draft', history: [], views: updatedViews } as UiMock;

      await saveFeature({ ...feature, uiMock: finalMock });

      const failures = pbiResults
        .map((r, i) => r.status === 'rejected' ? childPBIs[i].title : null)
        .filter(Boolean);
      if (failures.length) throw new Error(`Failed to generate: ${failures.join(', ')}`);
    },
    onSuccess: () => { setGenerateAllProgress(null); setGenerateAllContext(''); },
    onError: (e: Error) => { setGenerateAllProgress(null); console.error('Generate all error:', e); },
  });

  const isGeneratingAll = generateAllMutation.isPending;

  /* ── Handlers for PBI views ── */
  const handlePbiViewChange = async (pbiId: string, updated: UiMock | UiMockView) => {
    const currentViews = feature.uiMock?.views ?? [];
    const existingIdx = currentViews.findIndex(v => v.pbiId === pbiId);
    const newViews = existingIdx >= 0
      ? currentViews.map((v, i) => (i === existingIdx ? updated as UiMockView : v))
      : [...currentViews, updated as UiMockView];

    const updatedMock: UiMock = {
      ...(feature.uiMock ?? {
        decision: 'new-page', rationale: '', mockVersion: 0, status: 'draft', history: [],
      }),
      views: newViews,
    };
    const updatedFeature: BacklogFeature = { ...feature, uiMock: updatedMock };
    try { await saveFeature(updatedFeature); } catch { /* error surfaced inside panel */ }
  };

  const handlePbiViewDiscard = async (pbiId: string) => {
    const newViews = (feature.uiMock?.views ?? []).filter(v => v.pbiId !== pbiId);
    const updatedMock: UiMock = { ...feature.uiMock!, views: newViews };
    const updatedFeature: BacklogFeature = { ...feature, uiMock: updatedMock };
    try { await saveFeature(updatedFeature); } catch { /* error surfaced inside panel */ }
  };

  /* ── Derive active content ── */
  const activePbi = activeTab ? childPBIs.find(p => p.id === activeTab) : undefined;
  const activePbiView = activePbi
    ? (feature.uiMock?.views ?? []).find(v => v.pbiId === activePbi.id) ?? null
    : null;

  return (
    <div className="ui-mock-section">
      {/* Section title */}
      <div className="ui-mock-section__header">
        <h4 className="ui-mock-section__title">UI Visualization</h4>
        {isGeneratingAll && generateAllProgress && (
          <span className="ui-mock-section__generate-all-progress">
            <span className="ui-mock-section__generate-all-spinner" />
            {generateAllProgress}
          </span>
        )}
      </div>

      {/* Generate All panel — shown when there are multiple PBIs */}
      {childPBIs.length > 1 && !isGeneratingAll && (
        <div className="ui-mock-generate-all-panel">
          <textarea
            className="ui-mock-generate-all-panel__context"
            placeholder={`Optional context applied to all ${childPBIs.length} mocks — e.g. "focus on mobile-first layout", "target persona: staffing coordinator", "use a card grid instead of tables"…`}
            value={generateAllContext}
            onChange={e => setGenerateAllContext(e.target.value)}
            rows={2}
            disabled={isGeneratingAll}
          />
          <button
            className="ui-mock-section__btn-generate-all"
            onClick={() => generateAllMutation.mutate()}
            disabled={isGeneratingAll}
            title={(feature.uiMock?.views ?? []).length > 0
              ? `Regenerate all ${childPBIs.length} PBI mocks — each will get a new version on top of its existing history`
              : `Generate mocks for all ${childPBIs.length} PBIs at once`}
          >
            {(feature.uiMock?.views ?? []).length > 0
              ? `↻ Regenerate All (${childPBIs.length})`
              : `⚡ Generate All (${childPBIs.length})`}
          </button>
        </div>
      )}

      {/* Tab bar — only shown when there are multiple PBIs */}
      {childPBIs.length > 1 && (
        <div className="ui-mock-tabs" role="tablist">
          {childPBIs.map(pbi => {
            const view = (feature.uiMock?.views ?? []).find(v => v.pbiId === pbi.id);
            return (
              <button
                key={pbi.id}
                role="tab"
                aria-selected={activeTab === pbi.id}
                className={`ui-mock-tab${activeTab === pbi.id ? ' ui-mock-tab--active' : ''}`}
                onClick={() => setActiveTab(pbi.id)}
                title={pbi.title}
              >
                <span className="ui-mock-tab__label">{pbi.title}</span>
                {view?.designReady && <span className="ui-mock-tab__dot ui-mock-tab__dot--ready" title="Design ready" />}
                {view?.status === 'approved' && !view.designReady && <span className="ui-mock-tab__dot ui-mock-tab__dot--approved" title="Approved" />}
              </button>
            );
          })}
        </div>
      )}

      {/* Active PBI panel */}
      {activePbi ? (
        <MockViewPanel
          key={activePbi.id}
          kind="pbi"
          mock={activePbiView}
          feature={feature}
          pbi={activePbi}
          document={document}
          pagePath={pagePath}
          project={project}
          areaPath={areaPath}
          onMockChange={(updated) => handlePbiViewChange(activePbi.id, updated)}
          onDiscard={() => handlePbiViewDiscard(activePbi.id)}
          externalBusy={isGeneratingAll}
        />
      ) : (
        <div className="ui-mock-section__empty">
          <p className="ui-mock-section__empty-text">No PBIs found for this feature. Add PBIs to generate UI mocks.</p>
        </div>
      )}
    </div>
  );
};
