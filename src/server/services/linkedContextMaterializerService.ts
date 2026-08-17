/**
 * Linked Context Materializer (FEAT-003) — resolves live Interview ADR / Design Module
 * links into one deterministic workspace Markdown document immediately before an agent turn.
 *
 * Failure policy (confirmed): fail-open — omit any stale document, emit diagnostics, and
 * let the turn proceed on repository grounding.
 */

import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { chatThreads, designDocs, interviews, prds } from '../db/schema';
import { getAdr } from './adrService';
import { getModuleById } from './designModuleService';
import {
  getLinkedContext,
  type ActorContext,
} from './interviewLinkService';
import { trackEvent } from './telemetry';
import { LINKED_CONTEXT_DOCUMENT_RELATIVE_PATH } from '../../shared/types/interviewLinks';
import type { RunRef } from '../../shared/types/runGrounding';

export { LINKED_CONTEXT_DOCUMENT_RELATIVE_PATH };

export type MaterializeOutcome = 'written' | 'omitted' | 'failed';

export interface MaterializeResult {
  outcome: MaterializeOutcome;
  documentPath?: string;
  adrCount: number;
  designModuleCount: number;
  staleAdrExcluded: number;
  durationMs: number;
}

export interface MaterializeOptions {
  workspaceDir: string;
  actor: ActorContext;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export interface PipelineHandoffMaterializeOptions {
  materialize?: typeof materializeLinkedContext;
}

type PipelineHandoffSurface = 'prd' | 'design';

interface ResolvedPipelineHandoff {
  surface: PipelineHandoffSurface;
  interviewId: string;
  workspaceDir: string;
}

export interface RenderAdrSection {
  id: string;
  title: string;
  content: string;
}

export interface RenderDesignModuleSection {
  id: string;
  name: string;
  description: string | null;
  documentation: string | null;
  sourceGlobs: string[];
}

export interface RenderLinkedContextInput {
  interviewId: string;
  materializedAt: string;
  adrs: RenderAdrSection[];
  designModules: RenderDesignModuleSection[];
}

function resolveDocumentPath(workspaceDir: string): string {
  return path.join(workspaceDir, ...LINKED_CONTEXT_DOCUMENT_RELATIVE_PATH.split('/'));
}

function compareById(a: { id: string }, b: { id: string }): number {
  return a.id.localeCompare(b.id);
}

/**
 * Pure deterministic Markdown renderer for the linked-context grounding document.
 */
export function renderLinkedContextDocument(input: RenderLinkedContextInput): string {
  const adrs = [...input.adrs].sort(compareById);
  const modules = [...input.designModules].sort(compareById);

  const lines: string[] = [
    '# Linked Interview Grounding Context',
    '',
    '<!-- provenance -->',
    `Interview-Id: ${input.interviewId}`,
    `Materialized-At: ${input.materializedAt}`,
    `Accepted-Adr-Count: ${adrs.length}`,
    `Design-Module-Count: ${modules.length}`,
    '',
    '## Linked ADRs (accepted)',
    '',
  ];

  if (adrs.length === 0) {
    lines.push('_No accepted ADRs linked._', '');
  } else {
    for (const adr of adrs) {
      lines.push(`### ${adr.title} (\`${adr.id}\`)`, '', adr.content.trim(), '');
    }
  }

  lines.push('## Linked Design Modules', '');

  if (modules.length === 0) {
    lines.push('_No Design Modules linked._', '');
  } else {
    for (const mod of modules) {
      lines.push(`### ${mod.name} (\`${mod.id}\`)`, '');
      lines.push('**Description:**', '', mod.description?.trim() || '_None._', '');
      lines.push('**Source-glob manifest:**', '');
      if (mod.sourceGlobs.length === 0) {
        lines.push('- _(empty)_', '');
      } else {
        for (const glob of [...mod.sourceGlobs].sort((a, b) => a.localeCompare(b))) {
          lines.push(`- \`${glob}\``);
        }
        lines.push('');
      }
      lines.push('**Generated documentation:**', '', mod.documentation?.trim() || '_None._', '');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function ensureNoDocument(documentPath: string): void {
  try {
    if (fs.existsSync(documentPath)) {
      fs.unlinkSync(documentPath);
    }
  } catch (err) {
    console.warn(
      '[linked-context] failed to remove document after materialization failure:',
      (err as Error).message,
    );
  }
}

function emitTelemetry(
  interviewId: string,
  result: MaterializeResult,
  extra?: Record<string, string>,
): void {
  trackEvent(
    'interview.linked_context.materialize',
    {
      interviewId,
      outcome: result.outcome,
      ...(extra ?? {}),
    },
    {
      adrCount: result.adrCount,
      designModuleCount: result.designModuleCount,
      staleAdrExcluded: result.staleAdrExcluded,
      durationMs: result.durationMs,
    },
  );
}

/**
 * Atomically write Markdown to the workspace document path via temp file + rename.
 */
export function atomicWriteDocument(documentPath: string, contents: string): void {
  const dir = path.dirname(documentPath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(documentPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, contents, 'utf8');
    fs.renameSync(tempPath, documentPath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

export interface InterviewTurnMaterializeOptions {
  threadId: string;
  workspaceDir: string;
  userId: string;
  /** When false, skips materialization (non-interview chat threads). */
  isInterviewThread: boolean;
}

/**
 * Pre-turn hook for interview chat threads: resolve the Interview row for the
 * thread and materialize linked context into its workspace. Returns null when
 * the thread is not backed by an `interviews` row (e.g. ADR threads).
 */
export async function materializeLinkedContextForInterviewThread(
  options: InterviewTurnMaterializeOptions,
): Promise<MaterializeResult | null> {
  if (!options.isInterviewThread) return null;

  const interviewRow = await db.query.interviews.findFirst({
    where: eq(interviews.chatThreadId, options.threadId),
    columns: { id: true },
  });
  if (!interviewRow) return null;

  return materializeLinkedContext(interviewRow.id, {
    workspaceDir: options.workspaceDir,
    actor: { userId: options.userId },
  });
}

/**
 * Resolve current Interview links and materialize (or omit) `.ai-pilot/linked-context.md`.
 */
export async function materializeLinkedContext(
  interviewId: string,
  options: MaterializeOptions,
): Promise<MaterializeResult> {
  const started = Date.now();
  const documentPath = resolveDocumentPath(options.workspaceDir);
  const now = options.now ?? (() => new Date());

  try {
    const readModel = await getLinkedContext(interviewId, options.actor);

    const acceptedAdrLinks = readModel.adrLinks.filter((link) => link.isAccepted);
    const staleAdrExcluded = readModel.adrLinks.length - acceptedAdrLinks.length;

    const adrs: RenderAdrSection[] = [];
    for (const link of acceptedAdrLinks) {
      const adr = await getAdr(link.adrId);
      if (!adr || adr.status !== 'accepted') {
        // Live re-check: treat as stale if status drifted since the read model.
        continue;
      }
      adrs.push({
        id: adr.id,
        title: adr.title,
        content: adr.content ?? '',
      });
    }
    // Recount stale when live status drifted past the read-model flag.
    const liveStaleExcluded =
      staleAdrExcluded + (acceptedAdrLinks.length - adrs.length);

    const designModules: RenderDesignModuleSection[] = [];
    for (const link of readModel.designModuleLinks) {
      const mod = await getModuleById(link.designModuleId);
      if (!mod) continue;
      designModules.push({
        id: mod.id,
        name: mod.label,
        description: mod.description,
        documentation: mod.content,
        // Manifest strings only — never resolve or inline raw file contents (BR-010).
        sourceGlobs: Array.isArray(mod.sourceGlobs) ? [...mod.sourceGlobs] : [],
      });
    }

    if (adrs.length === 0 && designModules.length === 0) {
      ensureNoDocument(documentPath);
      const result: MaterializeResult = {
        outcome: 'omitted',
        adrCount: 0,
        designModuleCount: 0,
        staleAdrExcluded: liveStaleExcluded,
        durationMs: Date.now() - started,
      };
      emitTelemetry(interviewId, result);
      return result;
    }

    const markdown = renderLinkedContextDocument({
      interviewId,
      materializedAt: now().toISOString(),
      adrs,
      designModules,
    });

    atomicWriteDocument(documentPath, markdown);

    const result: MaterializeResult = {
      outcome: 'written',
      documentPath,
      adrCount: adrs.length,
      designModuleCount: designModules.length,
      staleAdrExcluded: liveStaleExcluded,
      durationMs: Date.now() - started,
    };
    emitTelemetry(interviewId, result);
    return result;
  } catch (err) {
    ensureNoDocument(documentPath);
    const result: MaterializeResult = {
      outcome: 'failed',
      adrCount: 0,
      designModuleCount: 0,
      staleAdrExcluded: 0,
      durationMs: Date.now() - started,
    };
    const errorName = err instanceof Error ? err.name : 'Error';
    console.warn(
      `[linked-context] materialization failed interviewId=${interviewId} error=${errorName}`,
    );
    // Diagnostics: ids / outcome / error name only — never artifact bodies (TBI-004 NFR).
    emitTelemetry(interviewId, result, {
      errorName,
    });
    return result;
  }
}

function emitPipelineHandoffTelemetry(
  surface: PipelineHandoffSurface,
  outcome: 'materialized' | 'empty' | 'unavailable',
  started: number,
): void {
  trackEvent(
    'grounding.linked-context.propagate',
    { surface, outcome },
    { durationMs: Date.now() - started },
  );
}

async function resolvePipelineHandoff(
  from: RunRef,
  to: RunRef,
): Promise<ResolvedPipelineHandoff | null> {
  if (from.runType !== 'chat' || to.runType !== 'chat') return null;

  const sourceInterview = await db.query.interviews.findFirst({
    where: eq(interviews.chatThreadId, from.runId),
    columns: { id: true, project: true },
  });

  let surface: PipelineHandoffSurface;
  let interviewId: string;
  let sourceProject: string;
  let destinationProject: string;

  if (sourceInterview) {
    const destinationPrd = await db.query.prds.findFirst({
      where: eq(prds.chatThreadId, to.runId),
      columns: { id: true, interviewId: true, project: true },
    });
    if (
      !destinationPrd ||
      destinationPrd.interviewId !== sourceInterview.id
    ) {
      return null;
    }
    surface = 'prd';
    interviewId = sourceInterview.id;
    sourceProject = sourceInterview.project;
    destinationProject = destinationPrd.project;
  } else {
    const sourcePrd = await db.query.prds.findFirst({
      where: eq(prds.chatThreadId, from.runId),
      columns: { id: true, interviewId: true, project: true },
    });
    if (!sourcePrd?.interviewId) return null;

    const destinationDesignDoc = await db.query.designDocs.findFirst({
      where: eq(designDocs.chatThreadId, to.runId),
      columns: { id: true, prdId: true, project: true },
    });
    if (!destinationDesignDoc || destinationDesignDoc.prdId !== sourcePrd.id) {
      return null;
    }
    surface = 'design';
    interviewId = sourcePrd.interviewId;
    sourceProject = sourcePrd.project;
    destinationProject = destinationDesignDoc.project;
  }

  if (
    sourceProject !== destinationProject ||
    from.project !== sourceProject ||
    to.project !== destinationProject
  ) {
    return null;
  }

  const destinationThread = await db.query.chatThreads.findFirst({
    where: eq(chatThreads.id, to.runId),
    columns: { workspaceDir: true },
  });
  if (!destinationThread?.workspaceDir?.trim()) return null;

  return {
    surface,
    interviewId,
    workspaceDir: destinationThread.workspaceDir,
  };
}

/**
 * Resolve an applicable Interview→PRD or PRD→design handoff from persisted
 * rows and regenerate the originating Interview's current linked context in
 * the destination chat workspace. All unavailable paths fail open.
 */
export async function materializeLinkedContextForPipelineHandoff(
  from: RunRef,
  to: RunRef,
  userId: string,
  options: PipelineHandoffMaterializeOptions = {},
): Promise<MaterializeResult | null> {
  const started = Date.now();
  let surface: PipelineHandoffSurface | null = null;

  try {
    const handoff = await resolvePipelineHandoff(from, to);
    if (!handoff) return null;
    surface = handoff.surface;

    const result = await (options.materialize ?? materializeLinkedContext)(
      handoff.interviewId,
      {
        workspaceDir: handoff.workspaceDir,
        actor: { userId },
      },
    );
    emitPipelineHandoffTelemetry(
      handoff.surface,
      result.outcome === 'written'
        ? 'materialized'
        : result.outcome === 'omitted'
          ? 'empty'
          : 'unavailable',
      started,
    );
    return result;
  } catch (error) {
    if (surface) {
      emitPipelineHandoffTelemetry(surface, 'unavailable', started);
    }
    const errorName = error instanceof Error ? error.name : 'Error';
    console.warn(
      `[linked-context] pipeline materialization unavailable error=${errorName}`,
    );
    return null;
  }
}
