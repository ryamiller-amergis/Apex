import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { sanitizePlainText } from '../../../shared/utils/sanitizePlainText';
import { db } from '../../db/drizzle';
import { brainstormCitations, brainstormMessages } from '../../db/schema';
import type { BrainstormCitationDto, BrainstormSourceKind } from '../../../shared/types/brainstormSources';
import { mcpCallsFor } from './mcpReadGateway';
import { sourceWorkspacePath, type SourceRecord, type SourceWorkspaceStore } from './sourceWorkspaceStore';

export interface CitationFiles {
  lstat(filePath: string): Promise<{ isFile: boolean; isSymbolicLink: boolean } | null>;
}

export interface StoredCitation {
  id: string;
  messageId: string | null;
  sourceKind: BrainstormSourceKind | null;
  sourceName: string | null;
  path: string | null;
  mcpServerName: string | null;
  mcpToolId: string | null;
  pinnedRevision: string | null;
  claimText: string;
  createdAt: string;
}

export interface CitationPersistence {
  insert(row: {
    sessionId: string;
    project: string;
    messageId: string;
    sourceId: string;
    pathOrTool: string;
    pinnedRevision: string | null;
    claimText: string;
    sourceKind: BrainstormSourceKind;
    sourceName: string;
    path: string | null;
    mcpServerName: string | null;
    mcpToolId: string | null;
  }): Promise<StoredCitation>;
  list(sessionId: string, project: string, messageId?: string): Promise<StoredCitation[]>;
  messageStatus(messageId: string): Promise<string | null>;
}

export interface CitationDeps {
  store: SourceWorkspaceStore;
  files: CitationFiles;
  dataRoot: string;
  persistence: CitationPersistence;
}

export type CitationRejection = 'bad-path' | 'no-call-record' | 'source-not-ready';

function toDto(row: StoredCitation): BrainstormCitationDto | null {
  if (!row.messageId || !row.sourceKind || !row.sourceName) return null;
  return {
    id: row.id,
    messageId: row.messageId,
    sourceKind: row.sourceKind,
    sourceName: row.sourceName,
    path: row.path,
    mcpServerName: row.mcpServerName,
    mcpToolId: row.mcpToolId,
    revision: row.pinnedRevision,
    claim: row.claimText,
    createdAt: row.createdAt,
  };
}

export function resolveCitationPath(workspace: string, requested: string): string | null {
  if (!requested || requested.includes('\0') || requested.split(/[/\\]/).includes('..')) return null;
  const normalized = requested.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized === '.git' || normalized.startsWith('.git/')) return null;
  const target = path.resolve(workspace, ...normalized.split('/'));
  const relative = path.relative(workspace, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return target;
}

export function createCitationService(deps: CitationDeps) {
  return {
    async recordRepository(input: {
      sessionId: string;
      project: string;
      messageId: string;
      sourceId: string;
      requestedPath: string;
      claim: string;
    }): Promise<{ ok: true; citation: BrainstormCitationDto } | { ok: false; reason: CitationRejection }> {
      const source = await deps.store.findById(input.sourceId, input.sessionId, input.project);
      if (!source || source.state !== 'ready' || !source.commitSha || source.kind === 'mcp-server') {
        return { ok: false, reason: 'source-not-ready' };
      }
      const workspace = sourceWorkspacePath(deps.dataRoot, input.sessionId, input.sourceId);
      const target = resolveCitationPath(workspace, input.requestedPath);
      if (!target) return { ok: false, reason: 'bad-path' };
      const stat = await deps.files.lstat(target);
      if (!stat || !stat.isFile || stat.isSymbolicLink) return { ok: false, reason: 'bad-path' };
      const relative = path.relative(workspace, target).replace(/\\/g, '/');
      const claim = sanitizePlainText(input.claim);
      const inserted = await deps.persistence.insert({
        sessionId: input.sessionId,
        project: input.project,
        messageId: input.messageId,
        sourceId: input.sourceId,
        pathOrTool: relative,
        pinnedRevision: source.commitSha,
        claimText: claim,
        sourceKind: source.kind,
        sourceName: source.displayName,
        path: relative,
        mcpServerName: null,
        mcpToolId: null,
      });
      const dto = toDto(inserted);
      if (!dto) return { ok: false, reason: 'bad-path' };
      return { ok: true, citation: dto };
    },

    async recordMcp(input: {
      sessionId: string;
      project: string;
      messageId: string;
      runId: string;
      connectionId: string;
      toolId: string;
      claim: string;
    }): Promise<{ ok: true; citation: BrainstormCitationDto } | { ok: false; reason: CitationRejection }> {
      const called = mcpCallsFor(input.sessionId, input.runId).some((call) =>
        call.connectionId === input.connectionId && call.toolId === input.toolId);
      if (!called) return { ok: false, reason: 'no-call-record' };
      const sources = await deps.store.listSession(input.sessionId, input.project);
      const source = sources.find((row) => row.kind === 'mcp-server' && row.refId === input.connectionId && row.state === 'ready');
      if (!source) return { ok: false, reason: 'source-not-ready' };
      const claim = sanitizePlainText(input.claim);
      const inserted = await deps.persistence.insert({
        sessionId: input.sessionId,
        project: input.project,
        messageId: input.messageId,
        sourceId: source.id,
        pathOrTool: input.toolId,
        pinnedRevision: null,
        claimText: claim,
        sourceKind: 'mcp-server',
        sourceName: source.displayName,
        path: null,
        mcpServerName: source.displayName,
        mcpToolId: input.toolId,
      });
      const dto = toDto(inserted);
      if (!dto) return { ok: false, reason: 'no-call-record' };
      return { ok: true, citation: dto };
    },

    async list(sessionId: string, project: string, messageId?: string): Promise<BrainstormCitationDto[]> {
      const rows = await deps.persistence.list(sessionId, project, messageId);
      const visible: BrainstormCitationDto[] = [];
      for (const row of rows) {
        if (!row.messageId) continue;
        const status = await deps.persistence.messageStatus(row.messageId);
        if (status && status !== 'completed') continue;
        const dto = toDto(row);
        if (dto) visible.push(dto);
      }
      return visible;
    },
  };
}

export type CitationService = ReturnType<typeof createCitationService>;

export function createDrizzleCitationPersistence(): CitationPersistence {
  return {
    async insert(row) {
      const inserted = await db.insert(brainstormCitations).values(row).returning();
      return inserted[0];
    },
    async list(sessionId, project, messageId) {
      const filters = [
        eq(brainstormCitations.sessionId, sessionId),
        eq(brainstormCitations.project, project),
      ];
      if (messageId) filters.push(eq(brainstormCitations.messageId, messageId));
      return db.select().from(brainstormCitations).where(and(...filters));
    },
    async messageStatus(messageId) {
      const rows = await db.select({ status: brainstormMessages.status }).from(brainstormMessages).where(
        eq(brainstormMessages.id, messageId),
      ).limit(1);
      return rows[0]?.status ?? null;
    },
  };
}

export function citationSourceReady(source: SourceRecord | null): source is SourceRecord {
  return Boolean(source && source.state === 'ready');
}
