/**
 * FEAT-003 TBI-008 — next actions and handoffs for a Brainstorm artifact.
 *
 * `computeActions` is pure. The engine's I/O methods load its input and call it,
 * so the panel, the inline chips and every write agree on what is offered.
 *
 * A handoff row is its own lock: preview inserts it, confirmation claims it with
 * a token, and the target is probed by thread before anything is created, so a
 * confirmation that stops part-way is finished by the next one, never repeated.
 * This module writes no ADR or Interview table; target services do.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, lt, ne, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { brainstormActions } from '../db/schema';
import {
  BRAINSTORM_ARTIFACT_TYPE_LABELS,
  BRAINSTORM_HANDOFF_CLAIM_MS,
  type BrainstormActionDto,
  type BrainstormActionId,
  type BrainstormActionKind,
  type BrainstormActionReason,
  type BrainstormActionsDto,
  type BrainstormArtifactType,
  type BrainstormHandoffExecutingDto,
  type BrainstormHandoffPreviewDto,
  type BrainstormHandoffResultDto,
  type BrainstormHandoffState,
  type BrainstormHandoffSummaryDto,
  type BrainstormResultRef,
  type BrainstormTargetModule,
} from '../../shared/types/brainstormArtifact';
import type { BrainstormCitationDto } from '../../shared/types/brainstormSources';
import {
  HANDOFF_TARGETS,
  buildHandoffContext,
  executeTarget,
  outlineArtifact,
  targetById,
  type HandoffCapabilities,
  type HandoffTarget,
  type TargetPlan,
  type TargetServices,
} from './brainstormHandoffTargets';
import { trackEvent } from './telemetry';

export class BrainstormHandoffError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'BrainstormHandoffError';
  }
}

export interface PreviewSnapshot {
  actionId: BrainstormActionId;
  contentSha256: string;
  plan: TargetPlan | null;
  preview: Omit<BrainstormHandoffPreviewDto, 'handoffId' | 'idempotencyKey' | 'state'> | null;
}

export interface HandoffRow {
  id: string;
  sessionId: string;
  project: string;
  actionKind: BrainstormActionKind;
  targetModule: BrainstormTargetModule;
  state: BrainstormHandoffState;
  previewSnapshot: PreviewSnapshot;
  confirmedAt: string | null;
  idempotencyKey: string;
  resultRef: BrainstormResultRef | null;
  artifactVersion: number;
  targetThreadId: string | null;
  claimToken: string | null;
  failureCode: string | null;
  updatedAt: string;
}

export interface NewHandoffRow {
  sessionId: string;
  project: string;
  actionKind: BrainstormActionKind;
  targetModule: BrainstormTargetModule;
  state: 'previewed' | 'completed';
  previewSnapshot: PreviewSnapshot;
  idempotencyKey: string;
  artifactVersion: number;
  resultRef: BrainstormResultRef | null;
  confirmedAt: string | null;
}

export interface HandoffPersistence {
  listForSession(sessionId: string, project: string): Promise<HandoffRow[]>;
  findById(sessionId: string, handoffId: string): Promise<HandoffRow | null>;
  /** The row for this action and version that has not failed. */
  findLive(sessionId: string, kind: BrainstormActionKind, version: number): Promise<HandoffRow | null>;
  /** Null when a live row for the same action and version already exists. */
  insert(row: NewHandoffRow): Promise<HandoffRow | null>;
  /** `previewed` → `executing`. False when another request claimed it first. */
  claim(id: string, token: string, at: string): Promise<boolean>;
  /** Replaces a claim older than `staleBefore`. */
  takeOver(id: string, oldToken: string, newToken: string, at: string, staleBefore: string): Promise<boolean>;
  storeThread(id: string, token: string, threadId: string): Promise<boolean>;
  complete(id: string, token: string, resultRef: BrainstormResultRef, at: string): Promise<boolean>;
  /** From `previewed` when `token` is null, otherwise from the claim. */
  fail(id: string, token: string | null, code: string, at: string): Promise<boolean>;
  /** Makes the claim stale at once so the next confirmation takes over. */
  release(id: string, token: string): Promise<void>;
}

export interface HandoffArtifactReader {
  getArtifact(sessionId: string, project: string): Promise<{
    id: string | null;
    type: BrainstormArtifactType | null;
    version: number;
    markdown: string;
  }>;
  getVersion(sessionId: string, project: string, sequence: number): Promise<{ markdown: string; artifactType: BrainstormArtifactType | null }>;
}

export interface HandoffSession {
  id: string;
  project: string;
  creatorId: string;
  state: string;
}

export interface HandoffEngineDeps {
  persistence: HandoffPersistence;
  artifacts: HandoffArtifactReader;
  loadCapabilities: (userId: string, project: string) => Promise<HandoffCapabilities>;
  listCitations: (sessionId: string, project: string) => Promise<BrainstormCitationDto[]>;
  services: TargetServices;
  now?: () => Date;
  newId?: () => string;
  track?: (event: string, properties: Record<string, string>) => void;
}

export function sha256(markdown: string): string {
  return createHash('sha256').update(markdown, 'utf8').digest('hex');
}

// ── Pure action list ──────────────────────────────────────────────────────────

const KEEP_ID: BrainstormActionId = 'keep-standalone';

export interface ComputeActionsInput {
  sessionState: string;
  isCreator: boolean;
  artifact: { type: BrainstormArtifactType | null; version: number; markdown: string };
  /** Required when `isCreator`; ignored otherwise. */
  capabilities: HandoffCapabilities | null;
  handoffs: readonly HandoffRow[];
}

export function toHandoffSummary(row: HandoffRow): BrainstormHandoffSummaryDto {
  return {
    handoffId: row.id,
    actionId: row.previewSnapshot.actionId,
    kind: row.actionKind,
    targetModule: row.targetModule,
    state: row.state,
    artifactVersion: row.artifactVersion,
    resultRef: row.resultRef,
    failureCode: row.failureCode,
    updatedAt: row.updatedAt,
  };
}

function liveRow(handoffs: readonly HandoffRow[], kind: BrainstormActionKind, version: number): HandoffRow | null {
  return handoffs.find((row) => row.actionKind === kind && row.artifactVersion === version && row.state !== 'failed') ?? null;
}

function withRow(action: BrainstormActionDto, row: HandoffRow | null): BrainstormActionDto {
  if (!row) return action;
  if (row.state === 'completed') {
    return { ...action, state: 'completed', handoffId: row.id, resultRef: row.resultRef, reasons: [] };
  }
  if (row.state === 'executing') {
    return {
      ...action,
      state: 'in_progress',
      handoffId: row.id,
      reasons: [{ code: 'IN_PROGRESS', text: 'This handoff is being created.' }],
    };
  }
  return action.state === 'available' ? { ...action, handoffId: row.id } : action;
}

/** Whether the creator may take this target at all; an action they may not take is omitted. */
export function targetOffered(target: HandoffTarget, type: BrainstormArtifactType | null, caps: HandoffCapabilities): boolean {
  return !!type && target.appliesTo(type) && target.allowed(caps) && caps.enabledMenus.has(target.menuKey);
}

export function computeActions(input: ComputeActionsInput): BrainstormActionsDto {
  const { artifact, handoffs } = input;
  const viewerCanAct = input.isCreator && input.sessionState === 'active';
  const summaries = handoffs
    .filter((row) => input.isCreator || row.state === 'completed')
    .map(toHandoffSummary);
  if (!viewerCanAct || !input.capabilities) {
    return { artifactVersion: artifact.version, viewerCanAct: false, actions: [], handoffs: summaries };
  }
  const caps = input.capabilities;
  const hasContent = artifact.version > 0 && artifact.markdown.trim().length > 0;
  const outline = outlineArtifact(artifact.markdown);
  const actions: BrainstormActionDto[] = [];

  for (const target of HANDOFF_TARGETS) {
    if (!targetOffered(target, artifact.type, caps)) continue;
    const missing = hasContent ? target.missingInformation(outline, caps) : ['Artifact content'];
    const reasons: BrainstormActionReason[] = missing.length > 0
      ? [{ code: 'MISSING_INFORMATION', text: `Add the following before you continue: ${missing.join(', ')}.` }]
      : [];
    actions.push(withRow({
      id: target.id,
      kind: target.kind,
      targetModule: target.module,
      label: target.label,
      description: target.description,
      state: missing.length > 0 ? 'unavailable' : 'available',
      reasons,
      missingInformation: missing,
      handoffId: null,
      resultRef: null,
    }, liveRow(handoffs, target.kind, artifact.version)));
  }

  actions.push(withRow({
    id: KEEP_ID,
    kind: 'keep_standalone',
    targetModule: 'standalone',
    label: 'Keep as standalone',
    description: 'Keep this artifact in Brainstorm. Project members can read it after the session ends.',
    state: hasContent ? 'available' : 'unavailable',
    reasons: hasContent ? [] : [{ code: 'NO_ARTIFACT', text: 'Ask the collaborator to draft the artifact first.' }],
    missingInformation: [],
    handoffId: null,
    resultRef: null,
  }, hasContent ? liveRow(handoffs, 'keep_standalone', artifact.version) : null));

  return { artifactVersion: artifact.version, viewerCanAct: true, actions, handoffs: summaries };
}

// ── Engine ────────────────────────────────────────────────────────────────────

function unavailable(action: BrainstormActionDto | undefined): BrainstormHandoffError {
  const reasons = action?.reasons.length
    ? action.reasons
    : [{ code: 'NOT_OFFERED', text: 'This action is not available for this artifact.' }];
  return new BrainstormHandoffError('ACTION_UNAVAILABLE', 409, { reasons, state: action?.state ?? null });
}

function isRefusal(err: unknown): boolean {
  if (err instanceof BrainstormHandoffError) return err.status < 500;
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) return true;
  return (err as { name?: string })?.name === 'ProjectRepositoryNotReady';
}

function refusalCode(err: unknown): string {
  if (err instanceof BrainstormHandoffError) return err.code;
  if ((err as { name?: string })?.name === 'ProjectRepositoryNotReady') return 'PROJECT_REPOSITORY_NOT_READY';
  const status = (err as { status?: number }).status;
  return status === 403 ? 'PERMISSION_MISSING' : 'TARGET_REFUSED';
}

export function createHandoffEngine(deps: HandoffEngineDeps) {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const track = deps.track ?? trackEvent;
  const { persistence } = deps;

  async function actionsFor(session: HandoffSession, viewerId: string) {
    const isCreator = session.creatorId === viewerId;
    const [artifact, handoffs, capabilities] = await Promise.all([
      deps.artifacts.getArtifact(session.id, session.project),
      persistence.listForSession(session.id, session.project),
      isCreator && session.state === 'active'
        ? deps.loadCapabilities(viewerId, session.project)
        : Promise.resolve(null),
    ]);
    return {
      artifact,
      capabilities,
      result: computeActions({ sessionState: session.state, isCreator, artifact, capabilities, handoffs }),
    };
  }

  function requireCreator(session: HandoffSession, userId: string): void {
    if (session.creatorId !== userId) throw new BrainstormHandoffError('NOT_CREATOR', 403);
    if (session.state !== 'active') throw new BrainstormHandoffError('SESSION_NOT_ACTIVE', 409);
  }

  function previewDto(row: HandoffRow): BrainstormHandoffPreviewDto {
    const preview = row.previewSnapshot.preview!;
    return { ...preview, handoffId: row.id, idempotencyKey: row.idempotencyKey, state: 'previewed' };
  }

  function result(row: HandoffRow, replayed: boolean): BrainstormHandoffResultDto {
    return { handoffId: row.id, state: 'completed', resultRef: row.resultRef!, replayed };
  }

  function stored(row: HandoffRow): BrainstormHandoffResultDto | BrainstormHandoffExecutingDto {
    if (row.state === 'completed') return result(row, true);
    if (row.state === 'failed') {
      throw new BrainstormHandoffError(row.failureCode ?? 'ACTION_UNAVAILABLE', 409, { failureCode: row.failureCode });
    }
    return { handoffId: row.id, state: 'executing' };
  }

  async function reread(session: HandoffSession, id: string): Promise<HandoffRow> {
    const row = await persistence.findById(session.id, id);
    if (!row) throw new BrainstormHandoffError('HANDOFF_NOT_FOUND', 404);
    return row;
  }

  /** Runs the claimed handoff to completion. Throws `HANDOFF_INTERRUPTED` after releasing the claim. */
  async function execute(session: HandoffSession, row: HandoffRow, token: string): Promise<BrainstormHandoffResultDto | BrainstormHandoffExecutingDto> {
    const target = targetById(row.previewSnapshot.actionId);
    const plan = row.previewSnapshot.plan;
    if (!target || !plan) throw new BrainstormHandoffError('ACTION_UNAVAILABLE', 409);
    let lostClaim = false;
    try {
      const [version, citations, caps] = await Promise.all([
        deps.artifacts.getVersion(session.id, session.project, row.artifactVersion),
        deps.listCitations(session.id, session.project),
        deps.loadCapabilities(session.creatorId, session.project),
      ]);
      if (sha256(version.markdown) !== row.previewSnapshot.contentSha256 || !version.artifactType) {
        throw new BrainstormHandoffError('PREVIEW_STALE', 409);
      }
      if (target.module !== 'feature-request' && !caps.repository) {
        throw new BrainstormHandoffError('MISSING_INFORMATION', 409);
      }
      const outcome = await executeTarget(target, {
        services: deps.services,
        userId: session.creatorId,
        project: session.project,
        plan,
        repository: caps.repository,
        markdown: version.markdown,
        context: buildHandoffContext({
          sessionId: session.id,
          project: session.project,
          artifactType: version.artifactType,
          version: row.artifactVersion,
          markdown: version.markdown,
          citations,
        }),
        today: now().toISOString().slice(0, 10),
        threadId: row.targetThreadId,
        storeThread: async (threadId) => {
          if (!(await persistence.storeThread(row.id, token, threadId))) {
            lostClaim = true;
            throw new Error('claim lost');
          }
        },
      });
      if (outcome.recovered) {
        track('brainstorm.handoff.recovered', { project: session.project, sessionId: session.id, handoffId: row.id, via: 'probe' });
      }
      if (!(await persistence.complete(row.id, token, outcome.resultRef, now().toISOString()))) {
        return stored(await reread(session, row.id));
      }
      track('brainstorm.handoff.completed', { project: session.project, sessionId: session.id, targetModule: target.module });
      return { handoffId: row.id, state: 'completed', resultRef: outcome.resultRef, replayed: false };
    } catch (err) {
      if (lostClaim) return stored(await reread(session, row.id));
      if (isRefusal(err)) {
        const code = refusalCode(err);
        await persistence.fail(row.id, token, code, now().toISOString());
        track('brainstorm.handoff.failed', { project: session.project, sessionId: session.id, failureCode: code });
        throw new BrainstormHandoffError(code, 409, { failureCode: code });
      }
      await persistence.release(row.id, token).catch(() => {});
      track('brainstorm.handoff.failed', { project: session.project, sessionId: session.id, failureCode: 'HANDOFF_INTERRUPTED' });
      throw new BrainstormHandoffError('HANDOFF_INTERRUPTED', 500);
    }
  }

  return {
    async listActions(session: HandoffSession, viewerId: string): Promise<BrainstormActionsDto> {
      return (await actionsFor(session, viewerId)).result;
    },

    async preview(session: HandoffSession, userId: string, input: { actionId: unknown; expectedVersion: number }): Promise<BrainstormHandoffPreviewDto> {
      requireCreator(session, userId);
      const target = typeof input.actionId === 'string' ? targetById(input.actionId as BrainstormActionId) : null;
      if (!target) throw unavailable(undefined);
      const { artifact, capabilities, result: listed } = await actionsFor(session, userId);
      if (artifact.version !== input.expectedVersion) {
        throw new BrainstormHandoffError('ARTIFACT_VERSION_CONFLICT', 409, { currentVersion: artifact.version });
      }
      const action = listed.actions.find((item) => item.id === target.id);
      if (!action || action.state !== 'available' || !capabilities || !artifact.type) throw unavailable(action);

      const existing = await persistence.findLive(session.id, target.kind, artifact.version);
      if (existing?.state === 'previewed' && existing.previewSnapshot.preview) return previewDto(existing);

      const outline = outlineArtifact(artifact.markdown);
      const plan = target.plan(outline, artifact.type, capabilities);
      const contentSha256 = sha256(artifact.markdown);
      const destinationLabel =
        target.module === 'adr'
          ? 'ADR'
          : target.module === 'interview'
            ? 'Interview'
            : 'Feature Request';
      const summary = [
        { label: 'Destination', value: destinationLabel },
        { label: 'Title', value: plan.title },
        ...(plan.repo ? [{ label: 'Repository', value: plan.repo }] : []),
        { label: 'Artifact', value: `${BRAINSTORM_ARTIFACT_TYPE_LABELS[artifact.type]}, version ${artifact.version}` },
        { label: 'Status', value: plan.status },
        ...(plan.skillPath ? [{ label: 'Interview skill', value: plan.skillPath }] : []),
      ];
      const snapshot: PreviewSnapshot = {
        actionId: target.id,
        contentSha256,
        plan,
        preview: {
          actionId: target.id,
          artifactVersion: artifact.version,
          target: { module: target.module, label: target.label },
          summary,
          sections: outline.headings,
          notes: target.notes(plan),
          contentSha256,
        },
      };
      const inserted = await persistence.insert({
        sessionId: session.id,
        project: session.project,
        actionKind: target.kind,
        targetModule: target.module,
        state: 'previewed',
        previewSnapshot: snapshot,
        idempotencyKey: newId(),
        artifactVersion: artifact.version,
        resultRef: null,
        confirmedAt: null,
      });
      const row = inserted ?? (await persistence.findLive(session.id, target.kind, artifact.version));
      if (!row || row.state !== 'previewed' || !row.previewSnapshot.preview) throw unavailable(action);
      track('brainstorm.handoff.previewed', { project: session.project, sessionId: session.id, targetModule: target.module });
      return previewDto(row);
    },

    async confirm(
      session: HandoffSession,
      userId: string,
      input: { handoffId: string; idempotencyKey: string | undefined },
    ): Promise<BrainstormHandoffResultDto | BrainstormHandoffExecutingDto> {
      requireCreator(session, userId);
      let row = await reread(session, input.handoffId);
      if (row.actionKind === 'keep_standalone') throw new BrainstormHandoffError('ACTION_UNAVAILABLE', 409);
      if (!input.idempotencyKey || input.idempotencyKey !== row.idempotencyKey) {
        throw new BrainstormHandoffError('IDEMPOTENCY_KEY_MISMATCH', 409);
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (row.state === 'completed') {
          track('brainstorm.handoff.replayed', { project: session.project, sessionId: session.id, handoffId: row.id });
          return result(row, true);
        }
        if (row.state === 'failed') return stored(row);

        if (row.state === 'previewed') {
          const { artifact, capabilities, result: listed } = await actionsFor(session, userId);
          if (artifact.version !== row.artifactVersion || sha256(artifact.markdown) !== row.previewSnapshot.contentSha256) {
            throw new BrainstormHandoffError('PREVIEW_STALE', 409, { currentVersion: artifact.version });
          }
          const target = targetById(row.previewSnapshot.actionId);
          const action = listed.actions.find((item) => item.id === row.previewSnapshot.actionId);
          if (!target || !action || action.state !== 'available' || !capabilities) {
            const code = !target || !capabilities || !targetOffered(target, artifact.type, capabilities)
              ? 'PERMISSION_MISSING'
              : 'MISSING_INFORMATION';
            await persistence.fail(row.id, null, code, now().toISOString());
            track('brainstorm.handoff.failed', { project: session.project, sessionId: session.id, failureCode: code });
            throw new BrainstormHandoffError('ACTION_UNAVAILABLE', 409, { failureCode: code, reasons: action?.reasons ?? [] });
          }
          const token = newId();
          if (await persistence.claim(row.id, token, now().toISOString())) {
            return execute(session, { ...row, state: 'executing', claimToken: token }, token);
          }
          row = await reread(session, row.id);
          continue;
        }

        // executing
        const claimedAt = row.confirmedAt ? Date.parse(row.confirmedAt) : 0;
        const staleBefore = new Date(now().getTime() - BRAINSTORM_HANDOFF_CLAIM_MS);
        if (claimedAt >= staleBefore.getTime()) return { handoffId: row.id, state: 'executing' };
        const token = newId();
        if (row.claimToken && await persistence.takeOver(row.id, row.claimToken, token, now().toISOString(), staleBefore.toISOString())) {
          track('brainstorm.handoff.recovered', { project: session.project, sessionId: session.id, handoffId: row.id, via: 'takeover' });
          return execute(session, { ...row, claimToken: token }, token);
        }
        row = await reread(session, row.id);
      }
      return stored(row);
    },

    async keepStandalone(session: HandoffSession, userId: string, input: { expectedVersion: number }): Promise<BrainstormHandoffResultDto> {
      requireCreator(session, userId);
      const { artifact, result: listed } = await actionsFor(session, userId);
      if (artifact.version !== input.expectedVersion) {
        throw new BrainstormHandoffError('ARTIFACT_VERSION_CONFLICT', 409, { currentVersion: artifact.version });
      }
      const action = listed.actions.find((item) => item.id === KEEP_ID);
      if (action?.state === 'completed') {
        const existing = await persistence.findLive(session.id, 'keep_standalone', artifact.version);
        if (existing?.resultRef) return result(existing, true);
      }
      if (!action || action.state !== 'available' || !artifact.id) throw unavailable(action);
      const resultRef: BrainstormResultRef = { module: 'standalone', id: artifact.id, link: `/brainstorm/${session.id}` };
      const inserted = await persistence.insert({
        sessionId: session.id,
        project: session.project,
        actionKind: 'keep_standalone',
        targetModule: 'standalone',
        state: 'completed',
        previewSnapshot: { actionId: KEEP_ID, contentSha256: sha256(artifact.markdown), plan: null, preview: null },
        idempotencyKey: newId(),
        artifactVersion: artifact.version,
        resultRef,
        confirmedAt: now().toISOString(),
      });
      if (inserted) {
        track('brainstorm.handoff.completed', { project: session.project, sessionId: session.id, targetModule: 'standalone' });
        return result(inserted, false);
      }
      const existing = await persistence.findLive(session.id, 'keep_standalone', artifact.version);
      if (existing?.state === 'completed' && existing.resultRef) return result(existing, true);
      throw unavailable(action);
    },

    async getHandoff(session: HandoffSession, viewerId: string, handoffId: string): Promise<BrainstormHandoffSummaryDto> {
      const row = await persistence.findById(session.id, handoffId);
      if (!row || (session.creatorId !== viewerId && row.state !== 'completed')) {
        throw new BrainstormHandoffError('HANDOFF_NOT_FOUND', 404);
      }
      return toHandoffSummary(row);
    },
  };
}

export type HandoffEngine = ReturnType<typeof createHandoffEngine>;

// ── Drizzle persistence ───────────────────────────────────────────────────────

type ActionRow = typeof brainstormActions.$inferSelect;

function parseResultRef(value: string | null): BrainstormResultRef | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as BrainstormResultRef;
  } catch {
    return null;
  }
}

function toRow(row: ActionRow): HandoffRow {
  return {
    id: row.id,
    sessionId: row.sessionId,
    project: row.project,
    actionKind: row.actionKind,
    targetModule: row.targetModule,
    state: row.state,
    previewSnapshot: row.previewSnapshot as unknown as PreviewSnapshot,
    confirmedAt: row.confirmedAt,
    idempotencyKey: row.idempotencyKey,
    resultRef: parseResultRef(row.resultRef),
    artifactVersion: row.artifactVersion ?? 0,
    targetThreadId: row.targetThreadId,
    claimToken: row.claimToken,
    failureCode: row.failureCode,
    updatedAt: row.updatedAt,
  };
}

export const drizzleHandoffPersistence: HandoffPersistence = {
  async listForSession(sessionId, project) {
    const rows = await db
      .select()
      .from(brainstormActions)
      .where(and(eq(brainstormActions.sessionId, sessionId), eq(brainstormActions.project, project)))
      .orderBy(sql`${brainstormActions.createdAt} DESC`);
    return rows.map(toRow);
  },
  async findById(sessionId, handoffId) {
    const [row] = await db
      .select()
      .from(brainstormActions)
      .where(and(eq(brainstormActions.id, handoffId), eq(brainstormActions.sessionId, sessionId)))
      .limit(1);
    return row ? toRow(row) : null;
  },
  async findLive(sessionId, kind, version) {
    const [row] = await db
      .select()
      .from(brainstormActions)
      .where(and(
        eq(brainstormActions.sessionId, sessionId),
        eq(brainstormActions.actionKind, kind),
        eq(brainstormActions.artifactVersion, version),
        ne(brainstormActions.state, 'failed'),
      ))
      .limit(1);
    return row ? toRow(row) : null;
  },
  async insert(input) {
    const [row] = await db
      .insert(brainstormActions)
      .values({
        sessionId: input.sessionId,
        project: input.project,
        actionKind: input.actionKind,
        targetModule: input.targetModule,
        state: input.state,
        previewSnapshot: input.previewSnapshot as unknown as Record<string, unknown>,
        idempotencyKey: input.idempotencyKey,
        artifactVersion: input.artifactVersion,
        resultRef: input.resultRef ? JSON.stringify(input.resultRef) : null,
        confirmedAt: input.confirmedAt,
      })
      .onConflictDoNothing({
        target: [brainstormActions.sessionId, brainstormActions.actionKind, brainstormActions.artifactVersion],
        where: sql`${brainstormActions.state} <> 'failed'`,
      })
      .returning();
    return row ? toRow(row) : null;
  },
  async claim(id, token, at) {
    const rows = await db
      .update(brainstormActions)
      .set({ state: 'executing', claimToken: token, confirmedAt: at, updatedAt: at })
      .where(and(eq(brainstormActions.id, id), eq(brainstormActions.state, 'previewed')))
      .returning({ id: brainstormActions.id });
    return rows.length === 1;
  },
  async takeOver(id, oldToken, newToken, at, staleBefore) {
    const rows = await db
      .update(brainstormActions)
      .set({ claimToken: newToken, confirmedAt: at, updatedAt: at })
      .where(and(
        eq(brainstormActions.id, id),
        eq(brainstormActions.state, 'executing'),
        eq(brainstormActions.claimToken, oldToken),
        lt(brainstormActions.confirmedAt, staleBefore),
      ))
      .returning({ id: brainstormActions.id });
    return rows.length === 1;
  },
  async storeThread(id, token, threadId) {
    const rows = await db
      .update(brainstormActions)
      .set({ targetThreadId: threadId, updatedAt: new Date().toISOString() })
      .where(and(eq(brainstormActions.id, id), eq(brainstormActions.claimToken, token), eq(brainstormActions.state, 'executing')))
      .returning({ id: brainstormActions.id });
    return rows.length === 1;
  },
  async complete(id, token, resultRef, at) {
    const rows = await db
      .update(brainstormActions)
      .set({ state: 'completed', resultRef: JSON.stringify(resultRef), confirmedAt: at, updatedAt: at })
      .where(and(eq(brainstormActions.id, id), eq(brainstormActions.claimToken, token), eq(brainstormActions.state, 'executing')))
      .returning({ id: brainstormActions.id });
    return rows.length === 1;
  },
  async fail(id, token, code, at) {
    const guard = token
      ? and(eq(brainstormActions.id, id), eq(brainstormActions.claimToken, token), eq(brainstormActions.state, 'executing'))
      : and(eq(brainstormActions.id, id), eq(brainstormActions.state, 'previewed'));
    const rows = await db
      .update(brainstormActions)
      .set({ state: 'failed', failureCode: code, updatedAt: at })
      .where(guard)
      .returning({ id: brainstormActions.id });
    return rows.length === 1;
  },
  async release(id, token) {
    await db
      .update(brainstormActions)
      .set({ confirmedAt: new Date(0).toISOString() })
      .where(and(eq(brainstormActions.id, id), eq(brainstormActions.claimToken, token)));
  },
};

// ── Production wiring ─────────────────────────────────────────────────────────

async function loadCapabilities(userId: string, project: string): Promise<HandoffCapabilities> {
  const [{ getUserPermissions }, { getUserGroupNames }, { getMenuConfig }, { resolveSkillConfig }, { isSuperAdminUserId }, menu] =
    await Promise.all([
      import('./rbacService'),
      import('./groupService'),
      import('./menuSettingsService'),
      import('./projectSettingsService'),
      import('../utils/superAdminUser'),
      import('../../shared/types/menuSettings'),
    ]);
  const [permissions, groups, menuConfig, skillConfig, isSuperAdmin] = await Promise.all([
    getUserPermissions(userId, project),
    getUserGroupNames(userId).catch(() => [] as string[]),
    getMenuConfig(project),
    resolveSkillConfig({ project }),
    isSuperAdminUserId(userId),
  ]);
  return {
    isSuperAdmin,
    permissions,
    groups,
    enabledMenus: new Set<string>(menuConfig?.enabledViews ?? menu.DEFAULT_ENABLED_MENU_VIEWS),
    repository: skillConfig?.skillRepo
      ? {
          repo: skillConfig.skillRepo,
          branch: skillConfig.skillBranch || 'main',
          provider: skillConfig.skillProvider ?? null,
          settingsId: skillConfig.id ?? null,
          interviewSkillPath: skillConfig.interviewSkillPath ?? null,
        }
      : null,
  };
}

export const defaultTargetServices: TargetServices = {
  async createThread(input) {
    const { createThread } = await import('./chatAgentService');
    const thread = await createThread(input.userId, {
      project: input.project,
      agentModule: input.module,
      repo: input.repository.repo,
      branch: input.repository.branch,
      skillProvider: input.repository.provider ?? undefined,
      skillPath: input.skillPath ?? undefined,
      freeformContext: input.freeformContext,
      skillSettingsId: input.repository.settingsId ?? undefined,
    }, { skipAutoKickoff: true });
    return thread.id;
  },
  async findRecordByThread(module, threadId) {
    if (module === 'feature-request') return null;
    if (module === 'adr') return (await import('./adrService')).findAdrIdByThread(threadId);
    return (await import('./interviewService')).findInterviewIdByThread(threadId);
  },
  async createAdrFromContent(input) {
    const { createAdrFromContent } = await import('./adrService');
    return (await createAdrFromContent(input)).adrId;
  },
  async createInterview(input) {
    const { createInterview } = await import('./interviewService');
    return (await createInterview(input)).interviewId;
  },
  async createFeatureRequestFromPlan(input) {
    const { createFeatureRequest } = await import('./featureRequestService');
    const created = await createFeatureRequest(input.userId, input.project, {
      type: 'technical',
      title: input.title,
      request: input.request,
    });
    return created.id;
  },
  async markInterviewThread(threadId) {
    const { markAsInterviewThread } = await import('./chatAgentService');
    markAsInterviewThread(threadId);
  },
};

let defaultEngine: HandoffEngine | null = null;

export function brainstormHandoffEngine(): HandoffEngine {
  if (!defaultEngine) {
    defaultEngine = createHandoffEngine({
      persistence: drizzleHandoffPersistence,
      artifacts: {
        async getArtifact(sessionId, project) {
          const { brainstormArtifactStore } = await import('./brainstormArtifactVersionStore');
          return brainstormArtifactStore.getArtifact(sessionId, project);
        },
        async getVersion(sessionId, project, sequence) {
          const { brainstormArtifactStore } = await import('./brainstormArtifactVersionStore');
          return brainstormArtifactStore.getVersion(sessionId, project, sequence);
        },
      },
      loadCapabilities,
      async listCitations(sessionId, project) {
        const { brainstormSourceRuntime } = await import('../routes/brainstormSources');
        return brainstormSourceRuntime().citations.list(sessionId, project);
      },
      services: defaultTargetServices,
    });
  }
  return defaultEngine;
}
