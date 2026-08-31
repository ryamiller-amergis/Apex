/**
 * Incomplete-pipeline read model for the Agent Home dashboard (FEAT-001 / PBI-001).
 *
 * Every Postgres read stays inside the artifact services that already own it
 * (`interviewService`, `prdService`, `testCaseService`, `designPrototypeService`,
 * `designDocService`, `ownerApprovalService`). This module is a thin merge layer
 * that applies the stall rules and shapes rows for the tile.
 *
 * Source errors are not caught here — the composing dashboard service turns a
 * rejection into a per-tile error result so one bad source cannot blank the page.
 */

import type {
  IncompletePipelineData,
  PipelineGroup,
  PipelineGroupRow,
} from '../../shared/types/homeDashboard';
import type { DesignDocSummary, InterviewSummary } from '../../shared/types/interview';
import type { DesignPrototypeSummary } from '../../shared/types/designPrototype';
import type { OwnerApprovalDocumentType } from '../../shared/types/approvals';
import { resolvePrototypeStageEnabled } from '../../shared/utils/prototypeStage';
import { listInterviews } from './interviewService';
import { listPrds } from './prdService';
import { listLatestTestCaseSummariesForPrds } from './testCaseService';
import { listPrototypes } from './designPrototypeService';
import { listDesignDocs } from './designDocService';
import { getOwnerApproval } from './ownerApprovalService';
import { getSkillConfig } from './projectSettingsService';

/** BR-006: a group reports the full project count but ships at most this many rows. */
const ROW_CAP = 20;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function ageDays(updatedAt: string, now: number): number {
  const updated = Date.parse(updatedAt);
  if (Number.isNaN(updated)) return 0;
  return Math.max(0, Math.floor((now - updated) / MS_PER_DAY));
}

function toRow(
  input: { id: string; name: string; route: string; updatedAt: string },
  now: number,
): PipelineGroupRow {
  return {
    id: input.id,
    name: input.name,
    route: input.route,
    updatedAt: input.updatedAt,
    ageDays: ageDays(input.updatedAt, now),
  };
}

/** BR-006: stalest first, count everything, cap the rows. */
function toGroup(
  key: PipelineGroup['key'],
  label: string,
  viewAllHref: string,
  rows: PipelineGroupRow[],
): PipelineGroup {
  const stalestFirst = [...rows].sort(
    (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt),
  );
  return {
    key,
    label,
    count: stalestFirst.length,
    rows: stalestFirst.slice(0, ROW_CAP),
    viewAllHref,
  };
}

/** BR-002: only the owner's final approval completes a document. */
async function isOwnerApproved(
  documentId: string,
  documentType: OwnerApprovalDocumentType,
): Promise<boolean> {
  const approval = await getOwnerApproval(documentId, documentType);
  return approval?.status === 'approved';
}

async function filterAwaitingOwner<T extends { id: string }>(
  items: T[],
  documentType: OwnerApprovalDocumentType,
): Promise<T[]> {
  const approved = await Promise.all(
    items.map((item) => isOwnerApproved(item.id, documentType)),
  );
  return items.filter((_, i) => !approved[i]);
}

/** BR-004: a Design Doc for the same PRD feature retires the Prototype row. */
function hasDesignDocForFeature(
  proto: DesignPrototypeSummary,
  docs: DesignDocSummary[],
): boolean {
  return docs.some((doc) => {
    if (doc.designPrototypeId && doc.designPrototypeId === proto.id) return true;
    if (doc.prdId !== proto.prdId) return false;
    return doc.featureIndex != null && doc.featureIndex === proto.featureIndex;
  });
}

/**
 * BR-005: Prototypes are enabled when any project Interview resolves true,
 * including Interviews that have not produced a PRD. With no Interviews,
 * fall back to the project skill config so an empty tile still shows the group.
 */
async function isPrototypeStageEnabledForProject(
  project: string,
  interviews: InterviewSummary[],
): Promise<boolean> {
  const skillConfig = await getSkillConfig(project);
  if (interviews.length === 0) {
    return resolvePrototypeStageEnabled(undefined, skillConfig);
  }
  return interviews.some((iv) =>
    resolvePrototypeStageEnabled(iv.prototypeStageEnabled, skillConfig),
  );
}

/**
 * The project-scoped read for the Incomplete Pipeline tile: one row per artifact
 * still owing work, grouped by artifact type.
 */
export async function getIncompletePipeline(
  project: string,
): Promise<IncompletePipelineData> {
  const now = Date.now();

  const [interviews, prds, prototypes, designDocs] = await Promise.all([
    listInterviews({ project }),
    listPrds({ project }),
    listPrototypes({ project }),
    listDesignDocs({ project }),
  ]);

  // BR-001: an Interview stalls while in progress, or once complete with no PRD.
  const interviewRows = interviews
    .filter((iv) => iv.status === 'in_progress' || (iv.status === 'complete' && iv.prdCount === 0))
    .map((iv) =>
      toRow(
        {
          id: iv.id,
          name: iv.title,
          route: `/backlog/interview/${iv.id}`,
          updatedAt: iv.updatedAt,
        },
        now,
      ),
    );

  const prdRows = (await filterAwaitingOwner(prds, 'prd')).map((prd) =>
    toRow(
      {
        id: prd.id,
        name: prd.title,
        route: `/backlog/prd/${prd.id}`,
        updatedAt: prd.updatedAt,
      },
      now,
    ),
  );

  // BR-003: only PRDs that require tests, and only while the latest suite is
  // missing, generating, or failed. Rows open the parent PRD.
  const prdsRequiringTests = prds.filter((prd) => prd.testCasesRequired !== false);
  const latestSuites = await listLatestTestCaseSummariesForPrds(
    prdsRequiringTests.map((prd) => prd.id),
  );
  const testCaseRows = prdsRequiringTests
    .filter((prd) => latestSuites.get(prd.id)?.status !== 'ready')
    .map((prd) => {
      const suite = latestSuites.get(prd.id);
      return toRow(
        {
          id: suite?.id ?? prd.id,
          name: prd.title,
          route: `/backlog/prd/${prd.id}`,
          updatedAt: suite?.updatedAt ?? prd.updatedAt,
        },
        now,
      );
    });

  // BR-002 + BR-004: awaiting owner approval, or approved with no Design Doc yet.
  const prototypesAwaitingOwner = await filterAwaitingOwner(prototypes, 'design_prototype');
  const awaitingOwnerIds = new Set(prototypesAwaitingOwner.map((proto) => proto.id));
  const prototypeRows = prototypes
    .filter(
      (proto) => awaitingOwnerIds.has(proto.id) || !hasDesignDocForFeature(proto, designDocs),
    )
    .map((proto) =>
      toRow(
        {
          id: proto.id,
          name: proto.featureName,
          route: `/backlog/design-prototypes/${proto.prdId}`,
          updatedAt: proto.updatedAt,
        },
        now,
      ),
    );

  const designDocRows = (await filterAwaitingOwner(designDocs, 'design_doc')).map((doc) =>
    toRow(
      {
        id: doc.id,
        name: doc.title,
        route: `/backlog/design-doc/${doc.id}`,
        updatedAt: doc.updatedAt,
      },
      now,
    ),
  );

  const groups: PipelineGroup[] = [
    toGroup('interview', 'Interviews', '/backlog?tab=interviews', interviewRows),
    toGroup('prd', 'PRDs', '/backlog?tab=prds', prdRows),
    toGroup('testCase', 'Test Cases', '/backlog?tab=prds', testCaseRows),
  ];

  if (await isPrototypeStageEnabledForProject(project, interviews)) {
    groups.push(
      toGroup('prototype', 'Design Prototypes', '/backlog?tab=design-prototypes', prototypeRows),
    );
  }

  groups.push(toGroup('designDoc', 'Design Docs', '/backlog?tab=design-docs', designDocRows));

  return { groups, updatedAt: new Date(now).toISOString() };
}
