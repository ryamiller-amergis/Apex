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

export interface SeededPrd {
  id: string;
  title: string;
  status: string;
  authorId: string;
  project: string;
  reviewerId: string | null;
}

export interface SeededComment {
  id: string;
  status: string;
  documentId: string;
}

export interface SeededNotification {
  id: string;
  userId: string;
  title: string;
  read: boolean;
}

export const SeedApi = {
  /**
   * Delete all records created by E2E tests in this run.
   * Call this in afterEach to keep the database clean between tests.
   */
  async reset(request: APIRequestContext): Promise<void> {
    await post(request, '/reset');
  },

  /**
   * Create a PRD suitable for testing approval flows.
   * Automatically prefixes the title with "[E2E]".
   */
  async seedPrd(
    request: APIRequestContext,
    opts: {
      authorId: string;
      project: string;
      title: string;
      status?: 'draft' | 'pending_review' | 'approved' | 'rejected';
      reviewerId?: string;
    },
  ): Promise<SeededPrd> {
    return post<SeededPrd>(request, '/seed/prd', opts);
  },

  /** Update a seeded PRD's status or reviewer (safe: only affects E2E records). */
  async updatePrd(
    request: APIRequestContext,
    prdId: string,
    patch_: { status?: string; reviewerId?: string; reviewedAt?: string; reviewComment?: string },
  ): Promise<SeededPrd> {
    return patch<SeededPrd>(request, `/seed/prd/${prdId}`, patch_);
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
