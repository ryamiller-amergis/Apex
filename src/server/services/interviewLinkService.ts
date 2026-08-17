/**
 * Interview Link Service (FEAT-001) — deep module owning typed ADR / Design Module
 * grounding links: project scope, accepted-only ADR eligibility, Interview lifecycle,
 * combined-cap, deduplication, and the current-link read model with live stale flags.
 */

import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  adrs,
  designModules,
  interviewAdrLinks,
  interviewDesignModuleLinks,
  interviews,
} from '../db/schema';
import { getAssignmentsForUser } from './userProjectAssignmentService';
import {
  InterviewLinkError,
  LINK_CANDIDATE_DEFAULT_PAGE_SIZE,
  LINKED_CONTEXT_CAPACITY,
  type AddAdrLinkRequest,
  type AddDesignModuleLinkRequest,
  type LinkCandidate,
  type LinkCandidateType,
  type LinkMutationResult,
  type LinkedAdr,
  type LinkedContextReadModel,
  type LinkedDesignModule,
  type PaginatedCandidates,
} from '../../shared/types/interviewLinks';
import type { InterviewStatus } from '../../shared/types/interview';

export type ActorContext = {
  userId: string;
  /** When true, project-assignment checks are skipped. */
  isSuperAdmin?: boolean;
};

type InterviewRow = typeof interviews.$inferSelect;

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

async function assertProjectAccess(actor: ActorContext, project: string): Promise<void> {
  if (actor.isSuperAdmin) return;
  const assigned = await getAssignmentsForUser(actor.userId);
  if (!assigned.includes(project)) {
    throw new InterviewLinkError(
      'PROJECT_FORBIDDEN',
      'You do not have access to this Interview\'s project',
    );
  }
}

async function loadInterviewOrThrow(interviewId: string): Promise<InterviewRow> {
  const row = await db.query.interviews.findFirst({
    where: eq(interviews.id, interviewId),
  });
  if (!row) {
    throw new InterviewLinkError('INTERVIEW_NOT_FOUND', 'Interview not found');
  }
  return row;
}

function assertInProgress(interview: InterviewRow): void {
  if ((interview.status as InterviewStatus) !== 'in_progress') {
    throw new InterviewLinkError(
      'INTERVIEW_NOT_IN_PROGRESS',
      'Links can only be changed while the Interview is in progress',
    );
  }
}

function toLinkedAdr(row: {
  adrId: string;
  linkedBy: string;
  linkedAt: string;
  adr: { title: string; status: string } | null;
}): LinkedAdr {
  const isAccepted = row.adr?.status === 'accepted';
  return {
    adrId: row.adrId,
    title: row.adr?.title ?? 'Unknown ADR',
    isAccepted,
    ...(isAccepted ? {} : { staleReason: 'no_longer_accepted' as const }),
    linkedBy: row.linkedBy,
    linkedAt: row.linkedAt,
  };
}

function toLinkedDesignModule(row: {
  designModuleId: string;
  linkedBy: string;
  linkedAt: string;
  designModule: { label: string } | null;
}): LinkedDesignModule {
  return {
    designModuleId: row.designModuleId,
    name: row.designModule?.label ?? 'Unknown Design Module',
    linkedBy: row.linkedBy,
    linkedAt: row.linkedAt,
  };
}

async function buildReadModel(interviewId: string): Promise<LinkedContextReadModel> {
  const adrRows = await db.query.interviewAdrLinks.findMany({
    where: eq(interviewAdrLinks.interviewId, interviewId),
    with: { adr: true },
    orderBy: [desc(interviewAdrLinks.linkedAt)],
  });
  const moduleRows = await db.query.interviewDesignModuleLinks.findMany({
    where: eq(interviewDesignModuleLinks.interviewId, interviewId),
    with: { designModule: true },
    orderBy: [desc(interviewDesignModuleLinks.linkedAt)],
  });

  const adrLinks = adrRows.map(toLinkedAdr);
  const designModuleLinks = moduleRows.map(toLinkedDesignModule);

  return {
    interviewId,
    adrLinks,
    designModuleLinks,
    count: adrLinks.length + designModuleLinks.length,
    capacity: LINKED_CONTEXT_CAPACITY,
  };
}

async function countCombinedLinks(
  interviewId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any = db,
): Promise<number> {
  const [adrCount] = await tx
    .select({ value: count() })
    .from(interviewAdrLinks)
    .where(eq(interviewAdrLinks.interviewId, interviewId));
  const [modCount] = await tx
    .select({ value: count() })
    .from(interviewDesignModuleLinks)
    .where(eq(interviewDesignModuleLinks.interviewId, interviewId));
  return Number(adrCount?.value ?? 0) + Number(modCount?.value ?? 0);
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

/**
 * Current linked-context read model with live stale-ADR flags.
 * Requires interviews:view at the route layer; enforces project assignment here.
 */
export async function getLinkedContext(
  interviewId: string,
  actor: ActorContext,
): Promise<LinkedContextReadModel> {
  const interview = await loadInterviewOrThrow(interviewId);
  await assertProjectAccess(actor, interview.project);
  return buildReadModel(interviewId);
}

export type ListCandidatesQuery = {
  type: LinkCandidateType;
  search?: string;
  offset?: number;
  limit?: number;
};

async function queryCandidatesForProject(
  project: string,
  query: ListCandidatesQuery,
): Promise<PaginatedCandidates> {
  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.min(
    Math.max(1, query.limit ?? LINK_CANDIDATE_DEFAULT_PAGE_SIZE),
    LINK_CANDIDATE_DEFAULT_PAGE_SIZE,
  );
  const search = query.search?.trim();

  if (query.type === 'adr') {
    const conditions = [
      eq(adrs.project, project),
      eq(adrs.status, 'accepted'),
    ];
    if (search) {
      conditions.push(ilike(adrs.title, `%${search}%`));
    }
    const where = and(...conditions);
    const [totalRow] = await db.select({ value: count() }).from(adrs).where(where);
    const rows = await db
      .select({ id: adrs.id, title: adrs.title })
      .from(adrs)
      .where(where)
      .orderBy(desc(adrs.updatedAt))
      .limit(limit)
      .offset(offset);

    const items: LinkCandidate[] = rows.map((r) => ({
      type: 'adr' as const,
      id: r.id,
      title: r.title,
      status: 'accepted' as const,
    }));

    return {
      items,
      total: Number(totalRow?.value ?? 0),
      offset,
      limit,
    };
  }

  const conditions = [eq(designModules.project, project)];
  if (search) {
    conditions.push(
      or(
        ilike(designModules.label, `%${search}%`),
        ilike(designModules.slug, `%${search}%`),
      )!,
    );
  }
  const where = and(...conditions);
  const [totalRow] = await db.select({ value: count() }).from(designModules).where(where);
  const rows = await db
    .select({ id: designModules.id, label: designModules.label })
    .from(designModules)
    .where(where)
    .orderBy(desc(designModules.updatedAt))
    .limit(limit)
    .offset(offset);

  const items: LinkCandidate[] = rows.map((r) => ({
    type: 'design-module' as const,
    id: r.id,
    name: r.label,
  }));

  return {
    items,
    total: Number(totalRow?.value ?? 0),
    offset,
    limit,
  };
}

/**
 * Paginated accepted-ADR or Design Module candidates scoped to the Interview's project.
 */
export async function listCandidates(
  interviewId: string,
  actor: ActorContext,
  query: ListCandidatesQuery,
): Promise<PaginatedCandidates> {
  const interview = await loadInterviewOrThrow(interviewId);
  await assertProjectAccess(actor, interview.project);
  return queryCandidatesForProject(interview.project, query);
}

/**
 * Kickoff candidate read used before an Interview id exists. The client-supplied
 * project is accepted only after validating the actor's server-side assignment.
 */
export async function listProjectCandidates(
  project: string,
  actor: ActorContext,
  query: ListCandidatesQuery,
): Promise<PaginatedCandidates> {
  await assertProjectAccess(actor, project);
  return queryCandidatesForProject(project, query);
}

async function lockInterviewAndValidate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  interviewId: string,
  actor: ActorContext,
): Promise<InterviewRow> {
  const locked = await tx.execute(
    sql`SELECT id, project, status FROM interviews WHERE id = ${interviewId} FOR UPDATE`,
  );
  const interview = resultRows<InterviewRow>(locked)[0];
  if (!interview) {
    throw new InterviewLinkError('INTERVIEW_NOT_FOUND', 'Interview not found');
  }
  await assertProjectAccess(actor, interview.project);
  assertInProgress(interview);
  return interview;
}

/**
 * Link an accepted same-project ADR. Enforces combined cap atomically.
 */
export async function addAdrLink(
  interviewId: string,
  actor: ActorContext,
  body: AddAdrLinkRequest,
): Promise<LinkMutationResult> {
  const adrId = body.adrId?.trim();
  if (!adrId) {
    throw new InterviewLinkError('ARTIFACT_NOT_FOUND', 'ADR id is required');
  }

  await db.transaction(async (tx) => {
    const interview = await lockInterviewAndValidate(tx, interviewId, actor);

    const adr = await tx.query.adrs.findFirst({ where: eq(adrs.id, adrId) });
    if (!adr) {
      throw new InterviewLinkError('ARTIFACT_NOT_FOUND', 'ADR not found');
    }
    if (adr.project !== interview.project) {
      throw new InterviewLinkError(
        'ARTIFACT_CROSS_PROJECT',
        'Linked artifacts must belong to the same project as the Interview',
      );
    }
    if (adr.status !== 'accepted') {
      throw new InterviewLinkError(
        'ADR_NOT_ACCEPTED',
        'Only accepted ADRs can be newly linked',
      );
    }

    const currentCount = await countCombinedLinks(interviewId, tx);
    if (currentCount >= LINKED_CONTEXT_CAPACITY) {
      throw new InterviewLinkError(
        'LINK_CAP_EXCEEDED',
        `An Interview may have at most ${LINKED_CONTEXT_CAPACITY} linked artifacts`,
      );
    }

    try {
      await tx.insert(interviewAdrLinks).values({
        interviewId,
        adrId,
        linkedBy: actor.userId,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new InterviewLinkError(
          'LINK_DUPLICATE',
          'This artifact is already linked to the Interview',
        );
      }
      throw err;
    }
  });

  return { linkedContext: await buildReadModel(interviewId) };
}

/**
 * Link a same-project Design Module. Enforces combined cap atomically.
 */
export async function addDesignModuleLink(
  interviewId: string,
  actor: ActorContext,
  body: AddDesignModuleLinkRequest,
): Promise<LinkMutationResult> {
  const designModuleId = body.designModuleId?.trim();
  if (!designModuleId) {
    throw new InterviewLinkError('ARTIFACT_NOT_FOUND', 'Design Module id is required');
  }

  await db.transaction(async (tx) => {
    const interview = await lockInterviewAndValidate(tx, interviewId, actor);

    const mod = await tx.query.designModules.findFirst({
      where: eq(designModules.id, designModuleId),
    });
    if (!mod) {
      throw new InterviewLinkError('ARTIFACT_NOT_FOUND', 'Design Module not found');
    }
    if (mod.project !== interview.project) {
      throw new InterviewLinkError(
        'ARTIFACT_CROSS_PROJECT',
        'Linked artifacts must belong to the same project as the Interview',
      );
    }

    const currentCount = await countCombinedLinks(interviewId, tx);
    if (currentCount >= LINKED_CONTEXT_CAPACITY) {
      throw new InterviewLinkError(
        'LINK_CAP_EXCEEDED',
        `An Interview may have at most ${LINKED_CONTEXT_CAPACITY} linked artifacts`,
      );
    }

    try {
      await tx.insert(interviewDesignModuleLinks).values({
        interviewId,
        designModuleId,
        linkedBy: actor.userId,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new InterviewLinkError(
          'LINK_DUPLICATE',
          'This artifact is already linked to the Interview',
        );
      }
      throw err;
    }
  });

  return { linkedContext: await buildReadModel(interviewId) };
}

export async function removeAdrLink(
  interviewId: string,
  actor: ActorContext,
  adrId: string,
): Promise<LinkMutationResult> {
  await db.transaction(async (tx) => {
    await lockInterviewAndValidate(tx, interviewId, actor);

    const deleted = await tx
      .delete(interviewAdrLinks)
      .where(
        and(
          eq(interviewAdrLinks.interviewId, interviewId),
          eq(interviewAdrLinks.adrId, adrId),
        ),
      )
      .returning({ id: interviewAdrLinks.id });

    if (deleted.length === 0) {
      throw new InterviewLinkError('ARTIFACT_NOT_FOUND', 'ADR link not found');
    }
  });

  return { linkedContext: await buildReadModel(interviewId) };
}

export async function removeDesignModuleLink(
  interviewId: string,
  actor: ActorContext,
  designModuleId: string,
): Promise<LinkMutationResult> {
  await db.transaction(async (tx) => {
    await lockInterviewAndValidate(tx, interviewId, actor);

    const deleted = await tx
      .delete(interviewDesignModuleLinks)
      .where(
        and(
          eq(interviewDesignModuleLinks.interviewId, interviewId),
          eq(interviewDesignModuleLinks.designModuleId, designModuleId),
        ),
      )
      .returning({ id: interviewDesignModuleLinks.id });

    if (deleted.length === 0) {
      throw new InterviewLinkError('ARTIFACT_NOT_FOUND', 'Design Module link not found');
    }
  });

  return { linkedContext: await buildReadModel(interviewId) };
}
