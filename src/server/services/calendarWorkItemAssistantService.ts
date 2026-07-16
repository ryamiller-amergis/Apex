/**
 * Calendar Work-Item Assistant domain service.
 *
 * Responsibilities:
 *  - Load ADO hierarchy (read-only, via per-user token or PAT)
 *  - Create/reuse owner-scoped sessions
 *  - Build grounded context snapshot for the chat workspace
 *  - Stage proposals from the agent (MCP handler)
 *  - Apply approved proposals to ADO with revision guards
 *  - Reject / supersede proposals
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { workItemAssistantSessions, workItemChangeProposals, chatThreads } from '../db/schema';
import { AzureDevOpsService } from './azureDevOps';
import { adoWriteFromToken } from './adoFactory';
import { normalizeAdoHtml, markdownToAdoHtml } from '../utils/adoRichText';
import { retryWithBackoff } from '../utils/retry';
import type {
  WorkItemHierarchyNode,
  WorkItemAssistantSession,
  WorkItemChangeProposal,
  WorkItemChangeSet,
  ProposedWorkItemChange,
  WorkItemApplyItemResult,
  ApplyWorkItemChangesResponse,
  ProposeWorkItemChangesInput,
  EditableContentField,
} from '../../shared/types/calendarWorkItemAssistant';
import {
  ProposeWorkItemChangesSchema,
  MAX_SELECTED_ITEMS,
  MAX_FIELD_BYTES,
  TERMINAL_WORK_ITEM_STATES,
  DESCRIPTION_SUPPORTED_TYPES,
  ACCEPTANCE_CRITERIA_SUPPORTED_TYPES,
} from '../../shared/types/calendarWorkItemAssistant';
import { getThread } from './chatAgentService';

// ── Session management ────────────────────────────────────────────────────────

/**
 * Load the full hierarchy rooted at anchorId, then create or reuse an
 * owner-scoped session. The session is immutable after creation:
 * selectedWorkItemIds and contextSnapshot cannot change.
 */
export async function createOrReuseSession(opts: {
  ownerUserId: string;
  project: string;
  areaPath: string;
  anchorWorkItemId: number;
  selectedWorkItemIds: number[];
  forceNew: boolean;
  adoToken: string | null;
}): Promise<{ session: WorkItemAssistantSession; isNew: boolean }> {
  const { ownerUserId, project, areaPath, anchorWorkItemId, selectedWorkItemIds, forceNew, adoToken } = opts;

  if (selectedWorkItemIds.length > MAX_SELECTED_ITEMS) {
    throw new Error(`Cannot select more than ${MAX_SELECTED_ITEMS} items in one session.`);
  }
  if (!selectedWorkItemIds.includes(anchorWorkItemId)) {
    throw new Error('Anchor work item must be in the selected work item IDs list.');
  }

  // Try to reuse an existing active session for the same scope
  if (!forceNew) {
    const existing = await db.query.workItemAssistantSessions.findFirst({
      where: and(
        eq(workItemAssistantSessions.ownerUserId, ownerUserId),
        eq(workItemAssistantSessions.project, project),
        eq(workItemAssistantSessions.anchorWorkItemId, anchorWorkItemId),
        eq(workItemAssistantSessions.status, 'active'),
      ),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });

    if (existing) {
      const existingIds = (existing.selectedWorkItemIds as number[]).sort();
      const requestedIds = [...selectedWorkItemIds].sort();
      if (existingIds.join(',') === requestedIds.join(',')) {
        return {
          session: toSessionShape(existing),
          isNew: false,
        };
      }
    }
  }

  // Load hierarchy from ADO using user token (or PAT fallback) for read
  const readService = adoToken
    ? new AzureDevOpsService(project, areaPath, { bearerToken: adoToken })
    : new AzureDevOpsService(project, areaPath);

  const allNodes = await readService.getWorkItemHierarchy(anchorWorkItemId);

  // Validate: all requested IDs must be in the hierarchy
  const nodeIds = new Set(allNodes.map(n => n.id));
  const unknownIds = selectedWorkItemIds.filter(id => !nodeIds.has(id));
  if (unknownIds.length > 0) {
    throw new Error(
      `The following work item IDs are not descendants of anchor #${anchorWorkItemId}: ${unknownIds.join(', ')}`,
    );
  }

  // Filter snapshot to selected IDs only
  const selectedSet = new Set(selectedWorkItemIds);
  const snapshot = allNodes.filter(n => selectedSet.has(n.id));

  const now = new Date().toISOString();
  const sessionId = uuidv4();

  const [row] = await db
    .insert(workItemAssistantSessions)
    .values({
      id: sessionId,
      ownerUserId,
      project,
      areaPath: areaPath || '',
      anchorWorkItemId,
      selectedWorkItemIds: selectedWorkItemIds as any,
      contextSnapshot: snapshot as any,
      threadId: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return { session: toSessionShape(row), isNew: true };
}

/** Attach a persistent chat thread to a session (call after createThread). */
export async function setSessionThread(sessionId: string, threadId: string): Promise<void> {
  await db
    .update(workItemAssistantSessions)
    .set({ threadId, updatedAt: new Date().toISOString() })
    .where(eq(workItemAssistantSessions.id, sessionId));
}

/** Load a session by ID. Returns null if not found. */
export async function getSession(sessionId: string): Promise<WorkItemAssistantSession | null> {
  const row = await db.query.workItemAssistantSessions.findFirst({
    where: eq(workItemAssistantSessions.id, sessionId),
  });
  return row ? toSessionShape(row) : null;
}

/** Close an active session (prevents reuse without forceNew). */
export async function closeSession(sessionId: string): Promise<void> {
  await db
    .update(workItemAssistantSessions)
    .set({ status: 'closed', updatedAt: new Date().toISOString() })
    .where(eq(workItemAssistantSessions.id, sessionId));
}

// ── Context snapshot ──────────────────────────────────────────────────────────

/**
 * Build a Markdown context file written to the chat workspace so the agent
 * can read current Description/AC values without MCP round-trips.
 */
export function buildContextMarkdown(snapshot: WorkItemHierarchyNode[]): string {
  const lines: string[] = [
    '# Work-Item Assistant Context',
    '',
    'This file contains the current content of all selected work items.',
    'Read it before proposing any changes.',
    '',
  ];

  for (const node of snapshot) {
    const indent = '  '.repeat(node.depth);
    lines.push(`## ${indent}[#${node.id}] ${node.workItemType}: ${node.title}`);
    lines.push(`${indent}**State:** ${node.state} | **Rev:** ${node.rev}`);
    lines.push(`${indent}**Supported fields:** ${node.supportedFields.join(', ')}`);
    lines.push('');

    if (node.supportedFields.includes('description')) {
      const desc = node.description ? normalizeAdoHtml(node.description) : '(empty)';
      lines.push(`${indent}### Description`);
      lines.push(desc.split('\n').map(l => indent + l).join('\n'));
      lines.push('');
    }

    if (node.supportedFields.includes('acceptanceCriteria')) {
      const ac = node.acceptanceCriteria ? normalizeAdoHtml(node.acceptanceCriteria) : '(empty)';
      lines.push(`${indent}### Acceptance Criteria`);
      lines.push(ac.split('\n').map(l => indent + l).join('\n'));
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ── Proposals ─────────────────────────────────────────────────────────────────

/**
 * MCP-exported handler: validate and stage a change set.
 * Called by the `propose_work_item_changes` MCP tool.
 * Supersedes any existing `pending` proposal for the session.
 * NEVER writes to ADO.
 */
export async function handleProposeWorkItemChanges(
  rawInput: ProposeWorkItemChangesInput,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  // Validate thread ownership
  const thread = await getThread(rawInput.threadId);
  if (!thread) {
    return mcpError('Thread not found');
  }
  if (thread.kickoff.assistantType !== 'calendar-work-item') {
    return mcpError('This tool is only available in a Calendar Work-Item Assistant thread.');
  }

  // Load session
  const session = await getSession(rawInput.sessionId);
  if (!session) return mcpError(`Session ${rawInput.sessionId} not found`);
  if (session.ownerUserId !== thread.userId) return mcpError('Session owner mismatch');
  if (session.status !== 'active') return mcpError('Session is not active');
  if (session.threadId !== rawInput.threadId) return mcpError('Thread/session mismatch');

  const selectedSet = new Set(session.selectedWorkItemIds);
  const snapshotMap = new Map(session.contextSnapshot.map(n => [n.id, n]));

  // Validate each proposed change
  const builtChanges: ProposedWorkItemChange[] = [];
  for (const change of rawInput.changes) {
    if (!selectedSet.has(change.workItemId)) {
      return mcpError(`Work item #${change.workItemId} is not in the selected scope.`);
    }
    const node = snapshotMap.get(change.workItemId);
    if (!node) return mcpError(`Work item #${change.workItemId} not found in session snapshot.`);

    const validatedFields = [];
    for (const f of change.fields) {
      if (!node.supportedFields.includes(f.field as EditableContentField)) {
        return mcpError(`Field '${f.field}' is not supported for ${node.workItemType} (#${change.workItemId}).`);
      }
      if (Buffer.byteLength(f.after, 'utf8') > MAX_FIELD_BYTES) {
        return mcpError(`Field '${f.field}' for work item #${change.workItemId} exceeds the 64 KB limit.`);
      }
      // Server provides trusted 'before' from snapshot — not model-supplied
      const rawBefore = f.field === 'description' ? (node.description ?? '') : (node.acceptanceCriteria ?? '');
      validatedFields.push({
        field: f.field as EditableContentField,
        before: normalizeAdoHtml(rawBefore),
        after: f.after,
      });
    }

    builtChanges.push({
      workItemId: change.workItemId,
      workItemType: node.workItemType,
      title: node.title,
      baselineRev: node.rev,
      fields: validatedFields,
    });
  }

  const now = new Date().toISOString();
  const proposalId = uuidv4();

  // Supersede any pending proposal for this session
  await db
    .update(workItemChangeProposals)
    .set({ status: 'superseded', updatedAt: now })
    .where(
      and(
        eq(workItemChangeProposals.sessionId, session.id),
        eq(workItemChangeProposals.status, 'pending'),
      ),
    );

  const changeSet: WorkItemChangeSet = {
    version: 1,
    proposalId,
    sessionId: session.id,
    threadId: rawInput.threadId,
    project: session.project,
    areaPath: session.areaPath,
    anchorWorkItemId: session.anchorWorkItemId,
    changes: builtChanges,
    proposedAt: now,
  };

  await db.insert(workItemChangeProposals).values({
    id: proposalId,
    sessionId: session.id,
    changeSet: changeSet as any,
    status: 'pending',
    itemResults: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  console.log(`[calendar-assistant] staged proposal ${proposalId} for session ${session.id} (${builtChanges.length} items)`);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ok: true,
        proposalId,
        sessionId: session.id,
        changeCount: builtChanges.length,
        itemIds: builtChanges.map(c => c.workItemId),
      }),
    }],
  };
}

/** Load the latest pending proposal for a session. */
export async function getLatestProposal(sessionId: string): Promise<WorkItemChangeProposal | null> {
  const row = await db.query.workItemChangeProposals.findFirst({
    where: and(
      eq(workItemChangeProposals.sessionId, sessionId),
      eq(workItemChangeProposals.status, 'pending'),
    ),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
  return row ? toProposalShape(row) : null;
}

/** Load any proposal by ID. */
export async function getProposal(proposalId: string): Promise<WorkItemChangeProposal | null> {
  const row = await db.query.workItemChangeProposals.findFirst({
    where: eq(workItemChangeProposals.id, proposalId),
  });
  return row ? toProposalShape(row) : null;
}

// ── Reject ────────────────────────────────────────────────────────────────────

/**
 * Update the `after` text for a specific field on a specific work item inside
 * a pending proposal. Called when the user manually edits before applying.
 */
export async function updateProposalFieldContent(
  proposalId: string,
  workItemId: number,
  field: import('../../shared/types/calendarWorkItemAssistant').EditableContentField,
  newAfter: string,
): Promise<void> {
  if (Buffer.byteLength(newAfter, 'utf8') > MAX_FIELD_BYTES) {
    throw new Error(`Content exceeds the 64 KB limit for field '${field}'.`);
  }

  const row = await db.query.workItemChangeProposals.findFirst({
    where: eq(workItemChangeProposals.id, proposalId),
  });
  if (!row) throw new Error('Proposal not found');
  if (row.status !== 'pending') throw new Error(`Cannot edit a proposal with status '${row.status}'.`);

  const changeSet = row.changeSet as unknown as WorkItemChangeSet;
  const updatedChanges = changeSet.changes.map(change => {
    if (change.workItemId !== workItemId) return change;
    const updatedFields = change.fields.map(f =>
      f.field === field ? { ...f, after: newAfter } : f,
    );
    return { ...change, fields: updatedFields };
  });

  const updatedChangeSet: WorkItemChangeSet = { ...changeSet, changes: updatedChanges };
  await db
    .update(workItemChangeProposals)
    .set({ changeSet: updatedChangeSet as any, updatedAt: new Date().toISOString() })
    .where(eq(workItemChangeProposals.id, proposalId));
}

export async function rejectProposal(proposalId: string, resolverUserId: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(workItemChangeProposals)
    .set({
      status: 'rejected',
      resolvedBy: resolverUserId,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(eq(workItemChangeProposals.id, proposalId));
}

// ── Apply ─────────────────────────────────────────────────────────────────────

/**
 * Apply approved item IDs from a staged proposal to ADO.
 * Uses revision guards; returns per-item outcomes.
 * The apply is non-transactional across items — each item is attempted independently.
 */
export async function applyProposal(
  proposalId: string,
  approvedWorkItemIds: number[],
  resolverUserId: string,
  adoToken: string | null,
): Promise<ApplyWorkItemChangesResponse> {
  const now = new Date().toISOString();

  // Load and lock the proposal
  const proposalRow = await db.query.workItemChangeProposals.findFirst({
    where: eq(workItemChangeProposals.id, proposalId),
  });
  if (!proposalRow) throw new Error(`Proposal ${proposalId} not found`);
  if (proposalRow.status !== 'pending' && proposalRow.status !== 'applying') {
    throw new Error(`Proposal ${proposalId} is not in a pending state (status: ${proposalRow.status})`);
  }

  // Load session
  const session = await getSession(proposalRow.sessionId);
  if (!session) throw new Error(`Session ${proposalRow.sessionId} not found`);

  // Atomically claim the proposal
  await db
    .update(workItemChangeProposals)
    .set({ status: 'applying', updatedAt: now })
    .where(
      and(
        eq(workItemChangeProposals.id, proposalId),
        eq(workItemChangeProposals.status, 'pending'),
      ),
    );

  const changeSet = proposalRow.changeSet as unknown as WorkItemChangeSet;
  const approvedSet = new Set(approvedWorkItemIds);
  const writeService = adoToken
    ? new AzureDevOpsService(session.project, session.areaPath, { bearerToken: adoToken })
    : new AzureDevOpsService(session.project, session.areaPath);

  // Refresh current ADO state for revision validation
  const allIds = changeSet.changes.map(c => c.workItemId);
  const current = await writeService.getWorkItemContentByIds(allIds);
  const currentMap = new Map(current.map(c => [c.id, c]));

  const results: WorkItemApplyItemResult[] = [];
  let appliedCount = 0;
  let failedCount = 0;

  // Apply approved items with capped concurrency (3 at a time)
  const approved = changeSet.changes.filter(c => approvedSet.has(c.workItemId));
  const skipped = changeSet.changes.filter(c => !approvedSet.has(c.workItemId));

  for (const skip of skipped) {
    results.push({ workItemId: skip.workItemId, status: 'not_selected' });
  }

  const CONCURRENCY = 3;
  for (let i = 0; i < approved.length; i += CONCURRENCY) {
    const batch = approved.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(change => applySingleItem(change, currentMap, writeService, session.id, proposalId, resolverUserId)),
    );
    for (const r of batchResults) {
      results.push(r);
      if (r.status === 'applied') appliedCount++;
      else if (r.status === 'failed') failedCount++;
    }
  }

  // Determine final proposal status
  const finalStatus = failedCount > 0
    ? (appliedCount > 0 ? 'partially_applied' : 'pending')
    : 'applied';

  await db
    .update(workItemChangeProposals)
    .set({
      status: finalStatus,
      itemResults: results as any,
      resolvedBy: resolverUserId,
      resolvedAt: finalStatus === 'applied' ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(workItemChangeProposals.id, proposalId));

  const applied = results.filter(r => r.status === 'applied');
  const stale = results.filter(r => r.status === 'stale');
  const failed = results.filter(r => r.status === 'failed');
  const notSelected = results.filter(r => r.status === 'not_selected');

  return {
    proposalId,
    status: finalStatus,
    applied,
    skipped: notSelected,
    stale,
    failed,
  };
}

async function applySingleItem(
  change: ProposedWorkItemChange,
  currentMap: Map<number, { id: number; rev: number; state: string; description: string; acceptanceCriteria: string }>,
  writeService: AzureDevOpsService,
  sessionId: string,
  proposalId: string,
  actorUserId: string,
): Promise<WorkItemApplyItemResult> {
  const current = currentMap.get(change.workItemId);
  if (!current) {
    return { workItemId: change.workItemId, status: 'failed', error: 'Work item not found in ADO refresh' };
  }

  // Revision guard
  if (current.rev !== change.baselineRev) {
    return {
      workItemId: change.workItemId,
      status: 'stale',
      reason: `Work item #${change.workItemId} was modified since this session was created (expected rev ${change.baselineRev}, current rev ${current.rev}). Refresh and re-propose.`,
    };
  }

  // Build ADO HTML for each field
  const fieldsToApply: { description?: string; acceptanceCriteria?: string } = {};
  for (const f of change.fields) {
    const adoHtml = markdownToAdoHtml(f.after);
    if (f.field === 'description') fieldsToApply.description = adoHtml;
    else if (f.field === 'acceptanceCriteria') fieldsToApply.acceptanceCriteria = adoHtml;
  }

  // Idempotency: check if content is already equal to what we'd write
  const alreadyApplied = change.fields.every(f => {
    const currentVal = f.field === 'description' ? current.description : current.acceptanceCriteria;
    return markdownToAdoHtml(f.after) === currentVal;
  });
  if (alreadyApplied) {
    return { workItemId: change.workItemId, status: 'applied', newRev: current.rev };
  }

  const historyMessage = `Description/Acceptance Criteria updated via Apex Calendar Work-Item Assistant (proposal ${proposalId}, actor: ${actorUserId})`;

  try {
    const { newRev } = await writeService.updateWorkItemContent(
      change.workItemId,
      fieldsToApply,
      change.baselineRev,
      historyMessage,
    );
    return { workItemId: change.workItemId, status: 'applied', newRev };
  } catch (err: any) {
    if (err?.code === 'STALE_REV' || err?.statusCode === 412) {
      return {
        workItemId: change.workItemId,
        status: 'stale',
        reason: err.message,
      };
    }
    // Transient ADO failure
    return {
      workItemId: change.workItemId,
      status: 'failed',
      error: err?.message ?? 'Unknown ADO error',
    };
  }
}

// ── Shape helpers ─────────────────────────────────────────────────────────────

function toSessionShape(row: any): WorkItemAssistantSession {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    project: row.project,
    areaPath: row.areaPath,
    anchorWorkItemId: row.anchorWorkItemId,
    selectedWorkItemIds: row.selectedWorkItemIds as number[],
    contextSnapshot: row.contextSnapshot as WorkItemHierarchyNode[],
    threadId: row.threadId,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toProposalShape(row: any): WorkItemChangeProposal {
  return {
    id: row.id,
    sessionId: row.sessionId,
    changeSet: row.changeSet as WorkItemChangeSet,
    status: row.status,
    itemResults: row.itemResults as WorkItemApplyItemResult[] | null,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mcpError(message: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
}
