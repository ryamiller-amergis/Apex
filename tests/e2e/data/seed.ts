/**
 * E2E data seed helpers.
 *
 * All helpers call the /e2e/* endpoints that are mounted only in E2E_MODE.
 * Records are prefixed with "[E2E]" and cleaned up by calling SeedApi.reset().
 */
import type { APIRequestContext } from '@playwright/test';

const E2E_API = 'http://127.0.0.1:3001/e2e';

async function post<T>(request: APIRequestContext, path: string, data?: unknown): Promise<T> {
  const res = await request.post(`${E2E_API}${path}`, data !== undefined ? { data } : undefined);
  if (!res.ok()) {
    const body = await res.text().catch(() => '');
    throw new Error(`[E2E seed] POST ${path} → ${res.status()}: ${body}`);
  }
  return res.json() as Promise<T>;
}

async function patch<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const res = await request.patch(`${E2E_API}${path}`, { data });
  if (!res.ok()) {
    const body = await res.text().catch(() => '');
    throw new Error(`[E2E seed] PATCH ${path} → ${res.status()}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export type PrdStatus =
  | 'generating'
  | 'draft'
  | 'validating'
  | 'pending_review'
  | 'reviewer_approved'
  | 'approved'
  | 'revision_requested';

export type DesignDocStatus =
  | 'generating'
  | 'generation_failed'
  | 'validating'
  | 'draft'
  | 'pending_review'
  | 'reviewer_approved'
  | 'approved'
  | 'revision_requested';

export type DesignPrototypeStatus =
  | 'generating'
  | 'pending_review'
  | 'reviewer_approved'
  | 'approved'
  | 'revision_requested'
  | 'regenerating'
  | 'generation_failed';

export interface SeededInterview {
  id: string;
  title: string;
  status: string;
  authorId: string;
  project: string;
  chatThreadId: string;
  prdOwnerId: string | null;
  designDocOwnerId: string | null;
  designPrototypeOwnerId: string | null;
}

export interface SeededPrd {
  id: string;
  title: string;
  status: string;
  authorId: string;
  project: string;
  reviewerId: string | null;
  interviewId: string | null;
  validationScore: number | null;
  testCase?: { id: string; status: string } | null;
}

export interface SeededDesignPrototype {
  id: string;
  prdId: string;
  featureName: string;
  status: string;
  authorId: string;
}

export interface SeededDesignDoc {
  id: string;
  prdId: string;
  title: string;
  status: string;
  authorId: string;
  project: string;
  validationScore: number | null;
}

export interface SeededComment {
  id: string;
  status: string;
  documentId: string;
  documentType: string;
}

export interface SeededNotification {
  id: string;
  userId: string;
  title: string;
  read: boolean;
}

export interface SeededApproverAssignment {
  id: string;
  documentId: string;
  documentType: string;
  approverUserId: string;
  status: string;
}

export interface SeededProjectSettings {
  id: string;
  project: string;
  friendlyName: string;
  approvalMode: string;
  prototypeStageEnabled: boolean;
  prdValidationScoreThreshold: number | null;
  designDocValidationScoreThreshold: number | null;
  prdValidationSkillPath: string | null;
  designDocValidationSkillPath: string | null;
}

export const SeedApi = {
  /**
   * Delete all records created by E2E tests in this run.
   * Call this in afterEach to keep the database clean between tests.
   */
  async reset(request: APIRequestContext): Promise<void> {
    await post(request, '/reset');
  },

  async seedInterview(
    request: APIRequestContext,
    opts: {
      authorId: string;
      project: string;
      title: string;
      status?: 'in_progress' | 'complete' | 'archived';
      repo?: string;
      prdOwnerId?: string;
      designDocOwnerId?: string;
      designPrototypeOwnerId?: string;
      testCaseOwnerId?: string;
      prdApproverIds?: string[];
      designDocApproverIds?: string[];
      designPrototypeApproverIds?: string[];
      testCaseApproverIds?: string[];
      prototypeStageEnabled?: boolean;
      testCasesEnabled?: boolean;
      skillSettingsId?: string;
    },
  ): Promise<SeededInterview> {
    return post<SeededInterview>(request, '/seed/interview', opts);
  },

  /**
   * Create a PRD suitable for testing approval / validation flows.
   * Automatically prefixes the title with "[E2E]".
   * Pass `withReadyTestCases: true` to satisfy the PRD readiness gate.
   */
  async seedPrd(
    request: APIRequestContext,
    opts: {
      authorId: string;
      project: string;
      title: string;
      status?: PrdStatus | 'rejected';
      reviewerId?: string;
      interviewId?: string;
      content?: string;
      backlogJson?: unknown;
      validationScore?: number | null;
      validationScorecard?: unknown;
      validationPhase?: string | null;
      readinessOverride?: unknown;
      withReadyTestCases?: boolean;
      designDocApproverIds?: string[];
      designPrototypeApproverIds?: string[];
    },
  ): Promise<SeededPrd> {
    return post<SeededPrd>(request, '/seed/prd', opts);
  },

  /** Update a seeded PRD's status or reviewer (safe: only affects E2E records). */
  async updatePrd(
    request: APIRequestContext,
    prdId: string,
    patch_: {
      status?: string;
      reviewerId?: string;
      reviewedAt?: string;
      reviewComment?: string;
      validationScore?: number | null;
      validationScorecard?: unknown;
      validationPhase?: string | null;
      readinessOverride?: unknown;
      proposedContent?: string | null;
    },
  ): Promise<SeededPrd> {
    return patch<SeededPrd>(request, `/seed/prd/${prdId}`, patch_);
  },

  async seedDesignPrototype(
    request: APIRequestContext,
    opts: {
      prdId: string;
      authorId: string;
      featureName?: string;
      featureIndex?: number;
      status?: DesignPrototypeStatus;
      mockHtml?: string;
      reviewerId?: string;
    },
  ): Promise<SeededDesignPrototype> {
    return post<SeededDesignPrototype>(request, '/seed/design-prototype', opts);
  },

  async seedDesignDoc(
    request: APIRequestContext,
    opts: {
      prdId: string;
      authorId: string;
      project: string;
      title: string;
      status?: DesignDocStatus;
      designPrototypeId?: string;
      featureIndex?: number;
      validationScore?: number | null;
      validationScorecard?: unknown;
      validationPhase?: string | null;
      validationOverride?: unknown;
      designContent?: string;
      techSpecContent?: string;
      assumptionsContent?: string;
      reviewerId?: string;
      proposedDesignContent?: string | null;
    },
  ): Promise<SeededDesignDoc> {
    return post<SeededDesignDoc>(request, '/seed/design-doc', opts);
  },

  /**
   * Add a review comment to any document type.
   * Prefer this over seedPrdComment for new specs.
   */
  async seedReviewComment(
    request: APIRequestContext,
    opts: {
      documentId: string;
      documentType: 'prd' | 'design_doc' | 'design_prototype';
      authorUserId: string;
      body: string;
      status?: 'open' | 'resolved';
      sectionKey?: string;
      selectorExact?: string;
    },
  ): Promise<SeededComment> {
    return post<SeededComment>(request, '/seed/review-comment', opts);
  },

  /**
   * Add a review comment to a PRD.
   * status defaults to 'open'.
   */
  async seedPrdComment(
    request: APIRequestContext,
    opts: {
      prdId: string;
      authorUserId: string;
      body: string;
      status?: 'open' | 'resolved';
    },
  ): Promise<SeededComment> {
    return post<SeededComment>(request, '/seed/prd-comment', opts);
  },

  async seedApproverAssignments(
    request: APIRequestContext,
    opts: {
      documentId: string;
      documentType: 'prd' | 'design_doc' | 'design_prototype' | 'test_case';
      approverUserIds: string[];
      assignedBy: string;
      status?: 'pending' | 'approved' | 'rejected';
    },
  ): Promise<SeededApproverAssignment[]> {
    return post<SeededApproverAssignment[]>(request, '/seed/approver-assignments', opts);
  },

  async seedProjectSettings(
    request: APIRequestContext,
    opts: {
      project: string;
      friendlyName?: string;
      skillRepo?: string;
      skillBranch?: string;
      isDefault?: boolean;
      approvalMode?: 'any_one' | 'all_required';
      prototypeStageEnabled?: boolean;
      prdValidationSkillPath?: string | null;
      designDocValidationSkillPath?: string | null;
      prdValidationScoreThreshold?: number | null;
      designDocValidationScoreThreshold?: number | null;
      interviewSkillPath?: string | null;
      prdSkillPath?: string | null;
      designDocSkillPath?: string | null;
      designPrototypeSkillPath?: string | null;
      testCaseSkillPath?: string | null;
      updatedBy?: string;
      designDocApprovers?: string[];
      prdApprovers?: string[];
      designPrototypeApprovers?: string[];
      testCaseApprovers?: string[];
    },
  ): Promise<SeededProjectSettings> {
    return post<SeededProjectSettings>(request, '/seed/project-settings', opts);
  },

  /**
   * Create an unread in-app notification for a user.
   */
  async seedNotification(
    request: APIRequestContext,
    opts: {
      userId: string;
      type?: string;
      title: string;
      body?: string;
      link?: string;
    },
  ): Promise<SeededNotification> {
    return post<SeededNotification>(request, '/seed/notification', opts);
  },

  /**
   * Override project menu visibility for the E2E test project.
   * Use in access-control tests to hide or show specific nav items.
   */
  async setMenuSettings(
    request: APIRequestContext,
    project: string,
    enabledViews: string[],
  ): Promise<void> {
    await post(request, '/seed/menu-settings', { project, enabledViews });
  },
};
