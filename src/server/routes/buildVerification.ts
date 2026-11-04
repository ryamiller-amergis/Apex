/**
 * Build verification matrix (`GET /api/builds/:id/verification`) and
 * Blob evidence streaming (`GET /api/builds/:id/evidence/:rowId/:slot`) routes (TBI-021, PBI-023, S7).
 *
 * Read routes remain open when `build-from-prompt` is turned off so past builds stay viewable.
 */
import { asc, desc, eq } from 'drizzle-orm';
import express, { type NextFunction, type Request, type Response } from 'express';
import type {
  BuildRequirement,
  BuildRiskDecision,
  BuildTestEvidence,
  BuildTestRef,
  BuildVerificationKind,
  BuildVerificationRow,
} from '../../shared/types/build';
import type {
  BuildEvidenceSlot,
  BuildEvidenceSummary,
  BuildVerificationMatrixResponse,
  BuildVerificationRowView,
  BuildVerificationSummary,
} from '../../shared/types/buildView';
import { db } from '../db/drizzle';
import { buildRevisions, buildVerificationRows } from '../db/schema';
import { requirePermission, resolveRequestProject } from '../middleware/rbac';
import { redactText } from '../services/buildRedactionService';
import { REDACTION_PLACEHOLDER } from '../services/buildRunProjectionService';
import { streamEvidence } from '../services/builds/buildEvidenceStore';
import {
  assertBuildReadAccess,
  BuildVerificationError,
  isValidUuid,
  loadBuildRunById,
} from '../services/builds/buildReadAccess';
import { getUserPermissions } from '../services/rbacService';
import { getAssignmentsForUser } from '../services/userProjectAssignmentService';
import { getUserId } from '../utils/requestUser';
import { isSuperAdminRequest } from '../utils/superAdmin';

const router = express.Router();

const KIND_ORDER: Record<BuildVerificationKind, number> = {
  ac: 0,
  dod: 1,
  br: 2,
  nfr: 3,
  risk_decision: 4,
};

function parseNaturalRequirementNumber(requirementId: string): number {
  const match = /-(\d+)$/.exec(requirementId);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function compareVerificationRows(
  left: BuildVerificationRowView,
  right: BuildVerificationRowView,
): number {
  const leftRetired = left.status === 'retired' ? 1 : 0;
  const rightRetired = right.status === 'retired' ? 1 : 0;
  if (leftRetired !== rightRetired) {
    return leftRetired - rightRetired;
  }

  const leftKindOrder = KIND_ORDER[left.kind] ?? 99;
  const rightKindOrder = KIND_ORDER[right.kind] ?? 99;
  if (leftKindOrder !== rightKindOrder) {
    return leftKindOrder - rightKindOrder;
  }

  const leftNum = parseNaturalRequirementNumber(left.requirementId);
  const rightNum = parseNaturalRequirementNumber(right.requirementId);
  if (leftNum !== rightNum) {
    return leftNum - rightNum;
  }

  return left.requirementId.localeCompare(right.requirementId);
}

function safeRedact(text: string): string {
  try {
    return redactText(text);
  } catch {
    return REDACTION_PLACEHOLDER;
  }
}

function mapEvidenceSummary(evidence: BuildTestEvidence | null | undefined): BuildEvidenceSummary | null {
  if (!evidence) {
    return null;
  }
  return {
    commit: evidence.commit,
    command: safeRedact(evidence.command),
    exitCode: evidence.exitCode,
    recordedAt: evidence.recordedAt,
  };
}

function resolveRequirementText(
  requirementId: string,
  requirements: BuildRequirement[] | null | undefined,
  riskDecisions: BuildRiskDecision[] | null | undefined,
): string {
  if (Array.isArray(requirements)) {
    const foundReq = requirements.find((item) => item.id === requirementId);
    if (foundReq && typeof foundReq.text === 'string') {
      return safeRedact(foundReq.text);
    }
  }
  if (Array.isArray(riskDecisions)) {
    const foundRisk = riskDecisions.find((item) => item.id === requirementId);
    if (foundRisk && typeof foundRisk.decision === 'string') {
      return safeRedact(foundRisk.decision);
    }
  }
  return '';
}

function mapVerificationRowView(
  row: Pick<
    BuildVerificationRow,
    | 'id'
    | 'requirementId'
    | 'kind'
    | 'testTier'
    | 'testRefs'
    | 'redEvidence'
    | 'greenEvidence'
    | 'status'
    | 'deferralReason'
  >,
  requirements: BuildRequirement[] | null | undefined,
  riskDecisions: BuildRiskDecision[] | null | undefined,
): BuildVerificationRowView {
  const rawRefs = Array.isArray(row.testRefs) ? row.testRefs : [];
  const testReferences = rawRefs.map((ref: BuildTestRef & { file?: string }) => {
    const rawFile =
      typeof ref.file === 'string'
        ? ref.file
        : typeof ref.path === 'string'
          ? ref.path
          : '';
    return {
      file: rawFile,
      name: safeRedact(typeof ref.name === 'string' ? ref.name : ''),
    };
  });

  return {
    id: row.id,
    requirementId: row.requirementId,
    kind: row.kind,
    requirementText: resolveRequirementText(row.requirementId, requirements, riskDecisions),
    tier: row.testTier ?? null,
    status: row.status,
    testReferences,
    red: mapEvidenceSummary(row.redEvidence),
    green: mapEvidenceSummary(row.greenEvidence),
    deferralReason:
      typeof row.deferralReason === 'string' ? safeRedact(row.deferralReason) : null,
  };
}

function computeVerificationSummary(rows: BuildVerificationRowView[]): BuildVerificationSummary {
  const summary: BuildVerificationSummary = {
    total: rows.length,
    pass: 0,
    fail: 0,
    deferred: 0,
    retired: 0,
  };
  for (const row of rows) {
    if (
      row.status === 'pass' ||
      row.status === 'fail' ||
      row.status === 'deferred' ||
      row.status === 'retired'
    ) {
      summary[row.status] += 1;
    }
  }
  return summary;
}

interface RevisionRow {
  id: string;
  buildRunId: string;
  revisionNumber: number;
  requirements: BuildRequirement[];
  riskDecisions: BuildRiskDecision[];
}

async function loadRevisionsForBuild(buildRunId: string): Promise<RevisionRow[]> {
  if (typeof db.query?.buildRevisions?.findMany === 'function') {
    const rows = await db.query.buildRevisions.findMany({
      where: eq(buildRevisions.buildRunId, buildRunId),
      orderBy: desc(buildRevisions.revisionNumber),
    });
    return (rows as RevisionRow[]) ?? [];
  }
  if (typeof db.select === 'function') {
    const rows = await db
      .select()
      .from(buildRevisions)
      .where(eq(buildRevisions.buildRunId, buildRunId))
      .orderBy(desc(buildRevisions.revisionNumber));
    return (rows as RevisionRow[]) ?? [];
  }
  return [];
}

async function loadRevisionById(revisionId: string): Promise<RevisionRow | null> {
  if (typeof db.query?.buildRevisions?.findFirst === 'function') {
    const row = await db.query.buildRevisions.findFirst({
      where: eq(buildRevisions.id, revisionId),
    });
    return (row as RevisionRow | undefined) ?? null;
  }
  if (typeof db.select === 'function') {
    const rows = await db
      .select()
      .from(buildRevisions)
      .where(eq(buildRevisions.id, revisionId))
      .limit(1);
    return (rows[0] as RevisionRow | undefined) ?? null;
  }
  return null;
}

async function loadVerificationRowsForRevision(revisionId: string): Promise<BuildVerificationRow[]> {
  if (typeof db.query?.buildVerificationRows?.findMany === 'function') {
    const rows = await db.query.buildVerificationRows.findMany({
      where: eq(buildVerificationRows.buildRevisionId, revisionId),
      orderBy: asc(buildVerificationRows.requirementId),
    });
    return (rows as BuildVerificationRow[]) ?? [];
  }
  if (typeof db.select === 'function') {
    const rows = await db
      .select()
      .from(buildVerificationRows)
      .where(eq(buildVerificationRows.buildRevisionId, revisionId))
      .orderBy(asc(buildVerificationRows.requirementId));
    return (rows as BuildVerificationRow[]) ?? [];
  }
  return [];
}

type VerificationRowWithRevision = BuildVerificationRow & {
  revision?: { id: string; buildRunId: string; revisionNumber?: number } | null;
};

async function loadVerificationRowById(rowId: string): Promise<VerificationRowWithRevision | null> {
  if (!isValidUuid(rowId)) {
    return null;
  }
  if (typeof db.query?.buildVerificationRows?.findFirst === 'function') {
    const row = await db.query.buildVerificationRows.findFirst({
      where: eq(buildVerificationRows.id, rowId),
      with: { revision: true },
    });
    return (row as VerificationRowWithRevision | undefined) ?? null;
  }
  if (typeof db.select === 'function') {
    const rows = await db
      .select()
      .from(buildVerificationRows)
      .where(eq(buildVerificationRows.id, rowId))
      .limit(1);
    return (rows[0] as VerificationRowWithRevision | undefined) ?? null;
  }
  return null;
}

/**
 * When a caller requests `/api/builds/:id/verification` or `/api/builds/:id/evidence/:rowId/:slot`
 * without naming a project in query/header/body, `requirePermission('builds:view')` would
 * otherwise call `getUserPermissions(userId, undefined)`. Pre-populating `req._permissions`
 * from the build's project (or assigned projects if the build is unknown) lets
 * `requirePermission('builds:view')` evaluate the caller's project-scoped role before
 * `assertBuildReadAccess` enforces project membership and build ownership.
 */
async function preloadBuildPermissionsWhenProjectOmitted(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = getUserId(req);
    if (!req.user || !userId || userId === 'anonymous') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (isSuperAdminRequest(req) || req._permissions || resolveRequestProject(req)) {
      next();
      return;
    }

    const build = await loadBuildRunById(req.params.id);
    if (build) {
      req._permissions = await getUserPermissions(userId, build.project);
      next();
      return;
    }

    const globalPerms = await getUserPermissions(userId, undefined);
    if (globalPerms.has('builds:view')) {
      req._permissions = globalPerms;
      next();
      return;
    }

    const assignedProjects = await getAssignmentsForUser(userId);
    for (const project of assignedProjects) {
      const projectPerms = await getUserPermissions(userId, project);
      if (projectPerms.has('builds:view')) {
        req._permissions = projectPerms;
        next();
        return;
      }
    }

    req._permissions = globalPerms;
    next();
  } catch (error) {
    next(error);
  }
}

function handleBuildVerificationError(error: unknown, res: Response): boolean {
  if (error instanceof BuildVerificationError) {
    if (error.code === 'BUILD_FORBIDDEN') {
      res.status(403).json({ error: 'Forbidden' });
      return true;
    }
    if (error.code === 'BUILD_UNAUTHORIZED') {
      res.status(401).json({ error: 'Unauthorized' });
      return true;
    }
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

router.get(
  '/:id/verification',
  preloadBuildPermissionsWhenProjectOmitted,
  requirePermission('builds:view'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { build } = await assertBuildReadAccess(req, req.params.id);

      let targetRevisionNumber = build.currentRevisionNumber;
      const rawRevision = req.query.revision;
      if (rawRevision !== undefined && rawRevision !== '') {
        if (typeof rawRevision !== 'string' || !/^[1-9]\d*$/.test(rawRevision)) {
          res.status(400).json({ error: 'Invalid revision number.', code: 'BAD_REQUEST' });
          return;
        }
        targetRevisionNumber = Number(rawRevision);
      }

      const revisions = await loadRevisionsForBuild(build.id);
      const sortedRevisions = [...revisions].sort(
        (left, right) => right.revisionNumber - left.revisionNumber,
      );
      const revisionNumbers = sortedRevisions.map((rev) => rev.revisionNumber);

      const targetRevision = sortedRevisions.find(
        (rev) => rev.revisionNumber === targetRevisionNumber,
      );
      if (!targetRevision) {
        res.status(404).json({ error: 'Revision not found.', code: 'NOT_FOUND' });
        return;
      }

      const rawRows = await loadVerificationRowsForRevision(targetRevision.id);
      const rows = rawRows
        .map((row) =>
          mapVerificationRowView(
            row,
            targetRevision.requirements,
            targetRevision.riskDecisions,
          ),
        )
        .sort(compareVerificationRows);

      const summary = computeVerificationSummary(rows);

      const response: BuildVerificationMatrixResponse = {
        buildId: build.id,
        revisionNumber: targetRevision.revisionNumber,
        revisionNumbers,
        summary,
        rows,
      };

      res.json(response);
    } catch (error) {
      if (!handleBuildVerificationError(error, res)) {
        next(error);
      }
    }
  },
);

router.get(
  '/:id/evidence/:rowId/:slot',
  preloadBuildPermissionsWhenProjectOmitted,
  requirePermission('builds:view'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { build } = await assertBuildReadAccess(req, req.params.id);

      const rawSlot = req.params.slot;
      if (rawSlot !== 'red' && rawSlot !== 'green') {
        res.status(400).json({ error: 'Invalid evidence slot.', code: 'BAD_REQUEST' });
        return;
      }
      const slot: BuildEvidenceSlot = rawSlot;

      const row = await loadVerificationRowById(req.params.rowId);
      if (!row) {
        res.status(404).json({ error: 'Verification row not found.', code: 'NOT_FOUND' });
        return;
      }

      let rowBuildRunId = row.revision?.buildRunId;
      if (!rowBuildRunId) {
        const revision = await loadRevisionById(row.buildRevisionId);
        rowBuildRunId = revision?.buildRunId;
      }

      if (!rowBuildRunId || rowBuildRunId !== build.id) {
        res.status(404).json({ error: 'Verification row not found.', code: 'NOT_FOUND' });
        return;
      }

      if (!row.evidenceBlobRef || !row.evidenceBlobRef.container || !row.evidenceBlobRef.key) {
        res.status(404).json({
          error: 'This evidence is no longer available.',
          code: 'BUILD_EVIDENCE_NOT_AVAILABLE',
        });
        return;
      }

      const stream = await streamEvidence(row.evidenceBlobRef, slot);
      if (!stream) {
        res.status(404).json({
          error: 'This evidence is no longer available.',
          code: 'BUILD_EVIDENCE_NOT_AVAILABLE',
        });
        return;
      }

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200);

      const destroyStream = () => {
        if (
          'destroy' in stream &&
          typeof (stream as { destroy?: () => void }).destroy === 'function'
        ) {
          (stream as { destroy: () => void }).destroy();
        }
      };

      req.on('close', () => {
        if (!res.writableEnded) {
          destroyStream();
        }
      });

      stream.on('error', (err) => {
        destroyStream();
        if (!res.headersSent) {
          next(err);
        } else {
          res.end();
        }
      });

      stream.pipe(res);
    } catch (error) {
      if (!handleBuildVerificationError(error, res)) {
        next(error);
      }
    }
  },
);

export default router;
