/**
 * PostgreSQL repository for `chat_thread_commands` (Drizzle ORM).
 *
 * Provides atomic `(thread_id, command_id)` idempotency via
 * `INSERT ... ON CONFLICT (thread_id, command_id) DO NOTHING RETURNING *`,
 * steer cap counting, pending command queries, and slow-path control listing.
 *
 * Payload rule: `send` stores attachment ids only (`attachmentIds`), never
 * attachment file contents (`content` / `data` / `base64`). Never logs text or
 * payload contents.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { agentRuns, chatThreadCommands } from '../../db/schema';
import {
  isHarnessReceiptReason,
  type HarnessCommandBody,
  type HarnessCommandKind,
  type HarnessPendingCommand,
  type HarnessPendingControl,
  type HarnessReceipt,
  type HarnessReceiptReason,
  type HarnessReceiptStatus,
} from '../../../shared/types/chatHarness';
import { notifyThreadCommand } from '../pgNotifyService';

export interface ChatHarnessCommandRow {
  id: string;
  threadId: string;
  commandId: string;
  runId: string | null;
  kind: HarnessCommandKind;
  status: HarnessReceiptStatus;
  reason: HarnessReceiptReason | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface InsertCommandInput {
  threadId: string;
  commandId: string;
  runId?: string | null;
  kind: HarnessCommandKind;
  status: HarnessReceiptStatus;
  reason?: HarnessReceiptReason | null;
  payload?: Record<string, unknown> | null;
}

export interface InsertCommandResult {
  inserted: boolean;
  row: ChatHarnessCommandRow;
}

export interface UpdateCommandReceiptPatch {
  status: HarnessReceiptStatus;
  reason?: HarnessReceiptReason | null;
  runId?: string | null;
  /** Optional optimistic guard so a late timeout never overwrites a settled receipt. */
  expectedStatus?: HarnessReceiptStatus;
}

export type OnReceiptChangedHook = (
  threadId: string,
  receipt: HarnessReceipt,
) => void | Promise<void>;

export interface ChatHarnessCommandRepository {
  insertIfAbsent(input: InsertCommandInput): Promise<InsertCommandResult>;
  findByCommandId(
    threadId: string,
    commandId: string,
  ): Promise<ChatHarnessCommandRow | null>;
  updateReceipt(
    threadId: string,
    commandId: string,
    patch: UpdateCommandReceiptPatch,
  ): Promise<ChatHarnessCommandRow | null>;
  countActiveSteersForRun(threadId: string, runId: string): Promise<number>;
  listPendingCommands(threadId: string): Promise<HarnessPendingCommand[]>;
  listPendingControlForRun(
    threadId: string,
    runId: string,
  ): Promise<HarnessPendingControl[]>;
}

function normalizeTextForHash(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n');
}

export function computeCommandPayloadHash(body: HarnessCommandBody): string {
  let canonical: Record<string, unknown>;
  switch (body.kind) {
    case 'send':
      canonical = {
        kind: 'send',
        text: normalizeTextForHash(body.text),
        model: body.model?.trim() ?? null,
        skill: body.skill
          ? { name: body.skill.name.trim(), path: body.skill.path.trim() }
          : null,
        attachmentIds: (body.attachments ?? []).map((a) => a.id),
      };
      break;
    case 'steer':
      canonical = {
        kind: 'steer',
        text: normalizeTextForHash(body.text),
      };
      break;
    case 'retry':
      canonical = {
        kind: 'retry',
        runId: body.runId,
      };
      break;
    case 'summarize':
    case 'cancel':
      canonical = { kind: body.kind };
      break;
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex');
}

/**
 * Build the safe JSONB payload for `chat_thread_commands`.
 * Stores ONLY `attachmentIds` for `send` attachments — never file content.
 */
export function sanitizeCommandPayload(
  body: HarnessCommandBody,
  metadata?: { userId?: string },
): Record<string, unknown> | null {
  const payloadHash = computeCommandPayloadHash(body);
  switch (body.kind) {
    case 'send': {
      const payload: Record<string, unknown> = {
        text: body.text,
        payloadHash,
      };
      if (body.model !== undefined) payload.model = body.model;
      if (body.skill !== undefined) {
        payload.skill = { name: body.skill.name, path: body.skill.path };
      }
      if (body.attachments && body.attachments.length > 0) {
        payload.attachmentIds = body.attachments.map((a) => a.id);
      }
      return payload;
    }
    case 'steer': {
      const payload: Record<string, unknown> = {
        text: body.text,
        payloadHash,
      };
      if (metadata?.userId) payload.userId = metadata.userId;
      return payload;
    }
    case 'retry':
      return {
        runId: body.runId,
        payloadHash,
      };
    case 'summarize':
    case 'cancel':
      return null;
  }
}

/**
 * Strip raw attachment content if a caller ever passes an unsanitized payload.
 */
function stripRawAttachmentsFromPayload(
  payload: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!payload) return null;
  if (!('attachments' in payload)) return payload;
  const { attachments, ...rest } = payload;
  if (!('attachmentIds' in rest) && Array.isArray(attachments)) {
    const ids = attachments
      .map((item) =>
        item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
          ? (item as { id: string }).id
          : null,
      )
      .filter((id): id is string => id !== null);
    if (ids.length > 0) {
      return { ...rest, attachmentIds: ids };
    }
  }
  return rest;
}

/**
 * Check whether an incoming command matches a previously stored row.
 * A purged row (`storedPayload === null` after 24h maintenance) still matches
 * when `storedKind === body.kind` (VT-45).
 */
export function payloadMatchesCommand(
  storedKind: HarnessCommandKind,
  storedPayload: Record<string, unknown> | null,
  body: HarnessCommandBody,
): boolean {
  if (storedKind !== body.kind) return false;
  if (storedPayload === null) return true;

  if (typeof storedPayload.payloadHash === 'string') {
    return storedPayload.payloadHash === computeCommandPayloadHash(body);
  }

  switch (body.kind) {
    case 'send':
    case 'steer':
      return (
        typeof storedPayload.text === 'string' &&
        normalizeTextForHash(storedPayload.text) === normalizeTextForHash(body.text)
      );
    case 'retry':
      return storedPayload.runId === body.runId;
    case 'summarize':
    case 'cancel':
      return true;
  }
}

function mapCommandRow(
  row: typeof chatThreadCommands.$inferSelect,
): ChatHarnessCommandRow {
  return {
    id: row.id,
    threadId: row.threadId,
    commandId: row.commandId,
    runId: row.runId ?? null,
    kind: row.kind,
    status: row.status,
    reason:
      row.reason && isHarnessReceiptReason(row.reason) ? row.reason : null,
    payload: row.payload ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function rowToHarnessReceipt(row: ChatHarnessCommandRow): HarnessReceipt {
  return {
    commandId: row.commandId,
    kind: row.kind,
    status: row.status,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    updatedAt: row.updatedAt,
  };
}

export interface CreateChatHarnessCommandRepositoryOptions {
  onReceiptChanged?: OnReceiptChangedHook;
}

export function createChatHarnessCommandRepository(
  options?: CreateChatHarnessCommandRepositoryOptions,
): ChatHarnessCommandRepository & {
  setOnReceiptChanged: (hook: OnReceiptChangedHook | null) => void;
} {
  let receiptChangedHook: OnReceiptChangedHook | null =
    options?.onReceiptChanged ?? null;

  const findByCommandId = async (
    threadId: string,
    commandId: string,
  ): Promise<ChatHarnessCommandRow | null> => {
    const rows = await db
      .select()
      .from(chatThreadCommands)
      .where(
        and(
          eq(chatThreadCommands.threadId, threadId),
          eq(chatThreadCommands.commandId, commandId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? mapCommandRow(row) : null;
  };

  return {
    setOnReceiptChanged(hook: OnReceiptChangedHook | null): void {
      receiptChangedHook = hook;
    },

    async insertIfAbsent(input: InsertCommandInput): Promise<InsertCommandResult> {
      const safePayload = stripRawAttachmentsFromPayload(input.payload);
      const insertedRows = await db
        .insert(chatThreadCommands)
        .values({
          threadId: input.threadId,
          commandId: input.commandId,
          runId: input.runId ?? null,
          kind: input.kind,
          status: input.status,
          reason: input.reason ?? null,
          payload: safePayload,
        })
        .onConflictDoNothing({
          target: [chatThreadCommands.threadId, chatThreadCommands.commandId],
        })
        .returning();

      const inserted = insertedRows[0];
      if (inserted) {
        return { inserted: true, row: mapCommandRow(inserted) };
      }

      const existing = await findByCommandId(input.threadId, input.commandId);
      if (!existing) {
        throw new Error(
          `Command row disappeared after conflict for commandId=${input.commandId}`,
        );
      }
      return { inserted: false, row: existing };
    },

    findByCommandId,

    async updateReceipt(
      threadId: string,
      commandId: string,
      patch: UpdateCommandReceiptPatch,
    ): Promise<ChatHarnessCommandRow | null> {
      const setValues: Partial<typeof chatThreadCommands.$inferInsert> = {
        status: patch.status,
        updatedAt: new Date().toISOString(),
      };
      if ('reason' in patch) {
        setValues.reason = patch.reason ?? null;
      }
      if ('runId' in patch) {
        setValues.runId = patch.runId ?? null;
      }

      const conditions = [
        eq(chatThreadCommands.threadId, threadId),
        eq(chatThreadCommands.commandId, commandId),
      ];
      if (patch.expectedStatus) {
        conditions.push(eq(chatThreadCommands.status, patch.expectedStatus));
      }

      const updatedRows = await db
        .update(chatThreadCommands)
        .set(setValues)
        .where(and(...conditions))
        .returning();

      const updated = updatedRows[0];
      if (!updated) return null;

      const mapped = mapCommandRow(updated);
      if (receiptChangedHook) {
        try {
          await receiptChangedHook(threadId, rowToHarnessReceipt(mapped));
        } catch {
          // Notification failure must not break command persistence.
        }
      }
      return mapped;
    },

    async countActiveSteersForRun(
      threadId: string,
      runId: string,
    ): Promise<number> {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(chatThreadCommands)
        .where(
          and(
            eq(chatThreadCommands.threadId, threadId),
            eq(chatThreadCommands.runId, runId),
            eq(chatThreadCommands.kind, 'steer'),
            inArray(chatThreadCommands.status, ['accepted', 'applied']),
          ),
        );
      return Number(rows[0]?.count ?? 0);
    },

    async listPendingCommands(
      threadId: string,
    ): Promise<HarnessPendingCommand[]> {
      const rows = await db
        .select({
          commandId: chatThreadCommands.commandId,
          kind: chatThreadCommands.kind,
          status: chatThreadCommands.status,
          runId: chatThreadCommands.runId,
          runStatus: agentRuns.status,
        })
        .from(chatThreadCommands)
        .leftJoin(agentRuns, eq(agentRuns.id, chatThreadCommands.runId))
        .where(
          and(
            eq(chatThreadCommands.threadId, threadId),
            inArray(chatThreadCommands.status, ['accepted', 'queued']),
          ),
        )
        .orderBy(asc(chatThreadCommands.createdAt));

      const activeRunStatuses = new Set(['queued', 'dispatched', 'running']);
      return rows
        .filter((row): row is typeof row & { status: 'accepted' | 'queued' } => {
          if (row.status !== 'accepted' && row.status !== 'queued') {
            return false;
          }
          // Un-acked mid-turn steers remain pending until the actor acks them
          // or the maintenance scheduler reconciles them into follow-up turns.
          if (row.kind === 'steer' && row.status === 'accepted') {
            return true;
          }
          // Commands attached to a run are only pending while that run is active.
          if (row.runId && row.runStatus && !activeRunStatuses.has(row.runStatus)) {
            return false;
          }
          return true;
        })
        .map((row) => ({
          commandId: row.commandId,
          kind: row.kind,
          status: row.status,
        }));
    },

    async listPendingControlForRun(
      threadId: string,
      runId: string,
    ): Promise<HarnessPendingControl[]> {
      const rows = await db
        .select({
          commandId: chatThreadCommands.commandId,
          kind: chatThreadCommands.kind,
          payload: chatThreadCommands.payload,
        })
        .from(chatThreadCommands)
        .where(
          and(
            eq(chatThreadCommands.threadId, threadId),
            eq(chatThreadCommands.runId, runId),
            inArray(chatThreadCommands.kind, ['steer', 'cancel']),
            eq(chatThreadCommands.status, 'accepted'),
          ),
        )
        .orderBy(asc(chatThreadCommands.createdAt));

      const controls: HarnessPendingControl[] = [];
      for (const row of rows) {
        if (row.kind === 'steer') {
          const text =
            row.payload && typeof row.payload.text === 'string'
              ? row.payload.text
              : undefined;
          controls.push({
            commandId: row.commandId,
            kind: 'steer',
            ...(text !== undefined ? { text } : {}),
          });
        } else if (row.kind === 'cancel') {
          controls.push({
            commandId: row.commandId,
            kind: 'cancel',
          });
        }
      }
      return controls;
    },
  };
}

export const chatHarnessCommandRepository = createChatHarnessCommandRepository({
  onReceiptChanged: (threadId, receipt) =>
    notifyThreadCommand(threadId, receipt),
});

export function setCommandReceiptChangedHook(
  hook: OnReceiptChangedHook | null,
): void {
  chatHarnessCommandRepository.setOnReceiptChanged(hook);
}
