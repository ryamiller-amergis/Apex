/**
 * Calendar Work-Item Assistant MCP server.
 *
 * Exposes exactly ONE tool: `propose_work_item_changes`.
 * The tool stages proposals for human review — it never writes to ADO.
 *
 * The server is bound to a specific session at mount time so the model
 * cannot target arbitrary sessions or threads.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { handleProposeWorkItemChanges } from '../../services/calendarWorkItemAssistantService';
import { ProposeWorkItemChangesSchema } from '../../../shared/types/calendarWorkItemAssistant';

export function createCalendarAssistantMcpServer(boundSessionId: string): McpServer {
  const server = new McpServer({
    name: 'calendar-assistant',
    version: '1.0.0',
  });

  server.tool(
    'propose_work_item_changes',
    'Stage Description and/or Acceptance Criteria proposals for selected ADO work items. ' +
    'This tool stores your proposals for human diff-review — it does NOT write to Azure DevOps. ' +
    'The user will see a per-item diff panel and must explicitly approve changes before they are applied.',
    {
      threadId: z.string().uuid().describe('The current chat thread ID'),
      sessionId: z.string().uuid().describe('The calendar assistant session ID'),
      changes: z
        .array(
          z.object({
            workItemId: z.number().int().positive().describe('ADO work item ID to propose changes for'),
            fields: z
              .array(
                z.object({
                  field: z
                    .enum(['description', 'acceptanceCriteria'])
                    .describe("Field to change: 'description' or 'acceptanceCriteria'"),
                  after: z
                    .string()
                    .describe('Full replacement text in Markdown. Will be converted to ADO HTML on apply.'),
                }),
              )
              .min(1)
              .max(2)
              .describe('Fields to change for this work item (max 2: description and/or acceptanceCriteria)'),
          }),
        )
        .min(1)
        .describe('Array of work items with their proposed field changes'),
    },
    async ({ threadId, sessionId, changes }) => {
      // Enforce session binding: reject calls targeting a different session
      if (sessionId !== boundSessionId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `Session ID mismatch. This MCP server is bound to session ${boundSessionId}.` }),
          }],
        };
      }

      // Validate using the shared schema
      const parseResult = ProposeWorkItemChangesSchema.safeParse({ threadId, sessionId, changes });
      if (!parseResult.success) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: parseResult.error.issues.map(i => i.message).join('; ') }),
          }],
        };
      }

      return handleProposeWorkItemChanges(parseResult.data);
    },
  );

  return server;
}
