/**
 * Incomplete-pipeline read model for the Agent Home dashboard (FEAT-001 / PBI-001).
 *
 * Every Postgres read stays inside the artifact services that already own it
 * (`interviewService`, `prdService`, `testCaseService`, `designPrototypeService`,
 * `designDocService`). This module is a thin merge layer that applies the stall
 * rules and shapes rows for the tile.
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
import { resolvePrototypeStageEnabled } from '../../shared/utils/prototypeStage';
import { listInterviews } from './interviewService';
import { listPrds } from './prdService';
import { listLatestTestCaseSummariesForPrds } from './testCaseService';
import { listPrototypes } from './designPrototypeService';
import { listDesignDocs } from './designDocService';
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
  input: { id: string; name: string; route: string; updatedAt: string; reason: string },
  now: number,
): PipelineGroupRow {
  return {
    id: input.id,
    name: input.name,
    route: input.route,
    updatedAt: input.updatedAt,
    ageDays: ageDays(input.updatedAt, now),
    reason: input.reason,
  };
}

/**
 * Row wording for the review statuses PRDs, Design Docs, and Prototypes share.
 * Phrased as the stage being waited on rather than echoing the artifact's badge,
 * so a row never reads "Complete" inside a tile titled Incomplete Pipeline.
 */
const REVIEW_STATUS_REASON: Record<string, string> = {
  generating: 'Generating',
  generation_failed: 'Generation failed',
  regenerating: 'Regenerating',
  validating: 'Validating',
  draft: 'Draft — not submitted for review',
  pending_review: 'Awaiting reviewers',
  reviewer_approved: 'Awaiting owner approval',
  revision_requested: 'Revision requested',
};

function reviewReason(status: string): string {
  return REVIEW_STATUS_REASON[status] ?? 'In progress';
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

/**
 * BR-002: a document still owes work until it reaches `approved`.
 *
 * The artifact's own status is the authority here, not a `document_owner_approvals`
 * row. That table logs the owner's decision and is not written on every path that
 * approves something: prototypes auto-approved for a skipped feature are inserted
 * straight at `approved`, and documents approved before the two-stage owner flow
 * shipped have no row at all. Keying off the row made those artifacts stall in the
 * tile forever while the Backlog showed them as Approved.
 */
function awaitingApproval<T extends { status: string }>(items: T[]): T[] {
  return items.filter((item) => item.status !== 'approved');
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
          // A complete Interview is listed only because it never produced a PRD,
          // which is the one case where the artifact badge and the tile disagree.
          reason: iv.status === 'complete' ? 'No PRD generated' : 'Interview in progress',
        },
        now,
      ),
    );

  const prdRows = awaitingApproval(prds).map((prd) =>
    toRow(
      {
        id: prd.id,
        name: prd.title,
        route: `/backlog/prd/${prd.id}`,
        updatedAt: prd.updatedAt,
        reason: reviewReason(prd.status),
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
          reason: !suite
            ? 'No test suite generated'
            : suite.status === 'failed'
              ? 'Generation failed'
              : 'Generating',
        },
        now,
      );
    });

  // BR-002 + BR-004: awaiting approval, or approved with no Design Doc yet.
  const prototypeRows = prototypes
    .filter(
      (proto) => proto.status !== 'approved' || !hasDesignDocForFeature(proto, designDocs),
    )
    .map((proto) =>
      toRow(
        {
          id: proto.id,
          name: proto.featureName,
          route: `/backlog/design-prototypes/${proto.prdId}`,
          updatedAt: proto.updatedAt,
          // BR-004: an approved Prototype is listed only for the missing Design Doc.
          reason:
            proto.status === 'approved' ? 'No design doc yet' : reviewReason(proto.status),
        },
        now,
      ),
    );

  const designDocRows = awaitingApproval(designDocs).map((doc) =>
    toRow(
      {
        id: doc.id,
        name: doc.title,
        route: `/backlog/design-doc/${doc.id}`,
        updatedAt: doc.updatedAt,
        reason: reviewReason(doc.status),
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
