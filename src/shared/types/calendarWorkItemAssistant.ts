import { z } from 'zod';

// ── Field support matrix ──────────────────────────────────────────────────────

/** Work item types that support the Description field. */
export const DESCRIPTION_SUPPORTED_TYPES = ['Epic', 'Feature', 'Product Backlog Item', 'Technical Backlog Item'] as const;

/** Work item types that support the Acceptance Criteria field. */
export const ACCEPTANCE_CRITERIA_SUPPORTED_TYPES = ['Epic', 'Feature', 'Product Backlog Item'] as const;

export type DescriptionSupportedType = (typeof DESCRIPTION_SUPPORTED_TYPES)[number];
export type AcceptanceCriteriaSupportedType = (typeof ACCEPTANCE_CRITERIA_SUPPORTED_TYPES)[number];

/** Names of the two editable content fields. */
export type EditableContentField = 'description' | 'acceptanceCriteria';

/** Maximum number of work items that may be selected in one session. */
export const MAX_SELECTED_ITEMS = 50;

/** Maximum byte size for a single generated field value (64 KB). */
export const MAX_FIELD_BYTES = 65_536;

// ── Hierarchy ─────────────────────────────────────────────────────────────────

/** A node in the work-item hierarchy loaded from ADO at context-build time. */
export interface WorkItemHierarchyNode {
  id: number;
  parentId: number | null;
  depth: number;
  workItemType: string;
  title: string;
  state: string;
  areaPath: string;
  /** Current ADO revision number — used for optimistic concurrency on apply. */
  rev: number;
  changedDate: string;
  description?: string;
  acceptanceCriteria?: string;
  /** Fields this item type supports editing through the assistant. */
  supportedFields: EditableContentField[];
}

// ── Sessions ──────────────────────────────────────────────────────────────────

/** Lifecycle status of a `work_item_assistant_sessions` row. */
export type WorkItemAssistantSessionStatus = 'active' | 'closed';

/** Immutable session created when the user launches the assistant. */
export interface WorkItemAssistantSession {
  id: string;
  ownerUserId: string;
  project: string;
  areaPath: string;
  anchorWorkItemId: number;
  /** Ordered, immutable list of selected work item IDs (includes anchor). */
  selectedWorkItemIds: number[];
  /** Snapshot of hierarchy nodes at session-create time, stored as JSONB. */
  contextSnapshot: WorkItemHierarchyNode[];
  /** Persistent chat thread ID (FK into chat_threads). */
  threadId: string | null;
  status: WorkItemAssistantSessionStatus;
  createdAt: string;
  updatedAt: string;
}

// ── Proposals ─────────────────────────────────────────────────────────────────

/** Lifecycle of a `work_item_change_proposals` row. */
export type WorkItemProposalStatus =
  | 'pending'
  | 'applying'
  | 'partially_applied'
  | 'applied'
  | 'rejected'
  | 'superseded';

/** A single field change inside a proposal for one work item. */
export interface ProposedFieldChange {
  field: EditableContentField;
  /**
   * Plain-text normalisation of the before-value from the session snapshot.
   * Supplied by the server; never accepted from the model or browser.
   */
  before: string;
  /** Agent-generated replacement text (Markdown; rendered to ADO HTML on apply). */
  after: string;
}

/** Per-item proposal entry inside a change set. */
export interface ProposedWorkItemChange {
  workItemId: number;
  workItemType: string;
  title: string;
  /** Baseline ADO revision at proposal time (from context snapshot). */
  baselineRev: number;
  fields: ProposedFieldChange[];
}

/** The full change set staged by the agent via the MCP tool. */
export interface WorkItemChangeSet {
  /** Schema version — always 1 for this release. */
  version: 1;
  proposalId: string;
  sessionId: string;
  threadId: string;
  project: string;
  areaPath: string;
  anchorWorkItemId: number;
  /** Must be a strict subset of `session.selectedWorkItemIds`. */
  changes: ProposedWorkItemChange[];
  proposedAt: string;
}

/** Full proposal row. */
export interface WorkItemChangeProposal {
  id: string;
  sessionId: string;
  changeSet: WorkItemChangeSet;
  status: WorkItemProposalStatus;
  /** Per-item results populated after apply. */
  itemResults: WorkItemApplyItemResult[] | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Apply / Reject ────────────────────────────────────────────────────────────

/** Result for a single work item after an apply attempt. */
export interface WorkItemApplyItemResult {
  workItemId: number;
  status: 'applied' | 'skipped' | 'stale' | 'failed' | 'not_selected';
  /** New ADO revision if applied; undefined otherwise. */
  newRev?: number;
  /** Human-readable reason for non-applied status. */
  reason?: string;
  /** ADO error detail when status === 'failed'. */
  error?: string;
}

/** Response returned by the POST .../apply endpoint. */
export interface ApplyWorkItemChangesResponse {
  proposalId: string;
  status: WorkItemProposalStatus;
  applied: WorkItemApplyItemResult[];
  skipped: WorkItemApplyItemResult[];
  stale: WorkItemApplyItemResult[];
  failed: WorkItemApplyItemResult[];
}

// ── Request bodies ────────────────────────────────────────────────────────────

export const CreateSessionRequestSchema = z.object({
  project: z.string().min(1),
  areaPath: z.string(),
  anchorWorkItemId: z.number().int().positive(),
  selectedWorkItemIds: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_SELECTED_ITEMS),
  forceNew: z.boolean().optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const ApplyProposalRequestSchema = z.object({
  /** IDs of items the user has approved; must be a subset of the proposal's change set. */
  approvedWorkItemIds: z.array(z.number().int().positive()).min(1),
  /** Explicit acknowledgement required when any approved item is in a terminal state. */
  acknowledgeTerminalStates: z.boolean().optional(),
  /** Explicit acknowledgement required when any field value will be cleared. */
  acknowledgeContentCleared: z.boolean().optional(),
});
export type ApplyProposalRequest = z.infer<typeof ApplyProposalRequestSchema>;

export const RejectProposalRequestSchema = z.object({
  reason: z.string().optional(),
});
export type RejectProposalRequest = z.infer<typeof RejectProposalRequestSchema>;

// ── MCP tool input ────────────────────────────────────────────────────────────

/**
 * Input schema for the `propose_work_item_changes` MCP tool.
 * The agent must call this; chat-only descriptions are not staged proposals.
 */
export const ProposeWorkItemChangesSchema = z.object({
  threadId: z.string().uuid(),
  sessionId: z.string().uuid(),
  changes: z
    .array(
      z.object({
        workItemId: z.number().int().positive(),
        fields: z
          .array(
            z.object({
              field: z.enum(['description', 'acceptanceCriteria']),
              after: z.string().max(MAX_FIELD_BYTES),
            }),
          )
          .min(1)
          .max(2),
      }),
    )
    .min(1)
    .max(MAX_SELECTED_ITEMS),
});
export type ProposeWorkItemChangesInput = z.infer<typeof ProposeWorkItemChangesSchema>;

// ── Terminal ADO states (warn before applying) ────────────────────────────────

export const TERMINAL_WORK_ITEM_STATES = [
  'Closed',
  'Done',
  'Removed',
  'Resolved',
  'Cancelled',
] as const;
export type TerminalWorkItemState = (typeof TERMINAL_WORK_ITEM_STATES)[number];
