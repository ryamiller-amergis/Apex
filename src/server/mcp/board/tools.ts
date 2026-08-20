import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  listApexWorkItems,
  updateApexWorkItem,
  moveApexWorkItem,
  addComment,
  listReleases,
  getApexWorkItem,
} from '../../services/apexWorkItemService';
import { getThread } from '../../services/chatAgentService';
import type {
  ApexWorkItemStatus,
  UpdateApexWorkItemDTO,
} from '../../../shared/types/apexWorkItem';
import { APEX_WORK_ITEM_STATUSES } from '../../../shared/types/apexWorkItem';

function jsonResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return jsonResult({ error: message });
}

async function actorFromThread(threadId: string): Promise<string> {
  const thread = await getThread(threadId);
  if (!thread?.userId) {
    throw new Error('Thread not found or missing userId');
  }
  return thread.userId;
}

/**
 * Register Work Board MCP tools on an existing MCP server (typically ado-skills).
 * Safe to call always — tools operate on Postgres board items, not ADO.
 */
export function registerBoardMcpTools(server: McpServer): void {
  server.tool(
    'query_board_items',
    'Query Apex Work Board items for a project. Optionally filter by owner OID, status, or release ID.',
    {
      project: z.string().describe('Apex project name (e.g. Apex)'),
      ownerId: z.string().optional().describe('Owner user OID'),
      status: z
        .enum(['idea', 'ready', 'in-progress', 'review', 'done'])
        .optional()
        .describe('Board status filter'),
      releaseId: z.string().optional().describe('Release UUID filter'),
      search: z.string().optional().describe('Title / APX number search'),
    },
    async ({ project, ownerId, status, releaseId, search }) => {
      try {
        let items = await listApexWorkItems({
          project,
          ownerId,
          releaseId,
          search,
        });
        if (status) {
          items = items.filter((i) => i.status === status);
        }
        return jsonResult({
          count: items.length,
          items: items.map((i) => ({
            id: i.id,
            apx: `APX-${i.itemNumber}`,
            title: i.title,
            type: i.type,
            status: i.status,
            owner: i.owner,
            dueDate: i.dueDate,
            releaseId: i.releaseId,
            release: i.release ?? null,
          })),
        });
      } catch (err) {
        console.error('[MCP] query_board_items FAILED:', err);
        return errorResult(err);
      }
    },
  );

  server.tool(
    'update_board_item',
    'Update an Apex Work Board item. Use status to move columns; other fields update metadata. ' +
      'Requires threadId so writes are attributed to the standup participant.',
    {
      threadId: z.string().describe('Current chat thread ID'),
      project: z.string().describe('Apex project name'),
      id: z.string().describe('Work item UUID'),
      fields: z
        .object({
          title: z.string().optional(),
          outcome: z.string().optional(),
          ownerId: z.string().optional(),
          dueDate: z.string().nullable().optional(),
          releaseId: z.string().nullable().optional(),
          branch: z.string().nullable().optional(),
          prUrl: z.string().nullable().optional(),
          status: z
            .enum(['idea', 'ready', 'in-progress', 'review', 'done'])
            .optional()
            .describe('Move item to this board status'),
        })
        .describe('Fields to update'),
    },
    async ({ threadId, project, id, fields }) => {
      try {
        const actorId = await actorFromThread(threadId);
        const { status, ...rest } = fields;
        let item = await getApexWorkItem(id, project);

        const dto: UpdateApexWorkItemDTO = {};
        if (rest.title !== undefined) dto.title = rest.title;
        if (rest.outcome !== undefined) dto.outcome = rest.outcome;
        if (rest.ownerId !== undefined) dto.ownerId = rest.ownerId;
        if (rest.dueDate !== undefined) dto.dueDate = rest.dueDate;
        if (rest.releaseId !== undefined) dto.releaseId = rest.releaseId;
        if (rest.branch !== undefined) dto.branch = rest.branch;
        if (rest.prUrl !== undefined) dto.prUrl = rest.prUrl;

        if (Object.keys(dto).length > 0) {
          item = await updateApexWorkItem(id, actorId, dto, project);
        }
        if (status && APEX_WORK_ITEM_STATUSES.includes(status as ApexWorkItemStatus)) {
          item = await moveApexWorkItem(id, actorId, { targetStatus: status }, project);
        }

        console.log(`[MCP] update_board_item: updated ${id}`);
        return jsonResult({
          ok: true,
          id: item.id,
          apx: `APX-${item.itemNumber}`,
          status: item.status,
          title: item.title,
        });
      } catch (err) {
        console.error(`[MCP] update_board_item FAILED ${id}:`, err);
        return errorResult(err);
      }
    },
  );

  server.tool(
    'add_board_item_comment',
    'Add a comment to an Apex Work Board item as the standup participant.',
    {
      threadId: z.string().describe('Current chat thread ID'),
      project: z.string().describe('Apex project name'),
      id: z.string().describe('Work item UUID'),
      body: z.string().describe('Comment body'),
    },
    async ({ threadId, project, id, body }) => {
      try {
        const actorId = await actorFromThread(threadId);
        const comment = await addComment(id, actorId, project, body);
        console.log(`[MCP] add_board_item_comment: added ${comment.id} on ${id}`);
        return jsonResult({ ok: true, commentId: comment.id, workItemId: id });
      } catch (err) {
        console.error(`[MCP] add_board_item_comment FAILED ${id}:`, err);
        return errorResult(err);
      }
    },
  );

  server.tool(
    'list_board_releases',
    'List Work Board releases for a project (name, version, target date, progress).',
    {
      project: z.string().describe('Apex project name'),
    },
    async ({ project }) => {
      try {
        const releases = await listReleases(project);
        return jsonResult({ count: releases.length, releases });
      } catch (err) {
        console.error('[MCP] list_board_releases FAILED:', err);
        return errorResult(err);
      }
    },
  );
}

/** Alias for callers that expect a getter factory. */
export function getBoardMcpTools(): { register: typeof registerBoardMcpTools } {
  return { register: registerBoardMcpTools };
}
