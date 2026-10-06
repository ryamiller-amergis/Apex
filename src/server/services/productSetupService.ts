import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { rfpRequests } from '../db/schema';
import { RFP_APPS_ADO_PROJECT } from '../../shared/types/rfpIntake';
import { AzureDevOpsService } from './azureDevOps';
import { PRODUCT_FOUNDATION_SKILL_PATH, SETUP_CHAT_MODEL } from './newProjectSkillSeedService';
import { getProductBuildSetup, type ProductBuildSetupStatus } from './productBuildService';
import { listSkillConfigsForProject } from './projectSettingsService';
import { listProjectTeammateCandidates } from './projectTeammateService';
import { getUserProjectRoles } from './rbacService';

export interface ProductSetupFoundationStatus {
  active: boolean;
  phase: 'foundation';
  skillPath: string;
  model: string;
  candidates: { userId: string; displayName: string; email: string }[];
  /** Adding teammates needs `admin:roles`; the approved requester may not have it. */
  canInviteTeammates: boolean;
  foundationAnswers: string[];
  build: null;
  chatThreadId: null;
  thread: null;
  design: null;
}

export type ProductSetupStatus = ProductSetupFoundationStatus | ProductBuildSetupStatus;

export class ProductFoundationError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'ProductFoundationError';
  }
}

function inactive(): ProductSetupFoundationStatus {
  return {
    active: false,
    phase: 'foundation',
    skillPath: PRODUCT_FOUNDATION_SKILL_PATH,
    model: SETUP_CHAT_MODEL,
    candidates: [],
    canInviteTeammates: false,
    foundationAnswers: [],
    build: null,
    chatThreadId: null,
    thread: null,
    design: null,
  };
}

async function foundationStatus(
  project: string,
  row: typeof rfpRequests.$inferSelect,
  isAdmin: boolean,
): Promise<ProductSetupFoundationStatus> {
  const configs = await listSkillConfigsForProject(project);
  const pill = configs[0]?.quickSkillPills?.find((item) => item.skillPath.includes('product-foundation'));
  return {
    active: true,
    phase: 'foundation',
    skillPath: pill?.skillPath ?? PRODUCT_FOUNDATION_SKILL_PATH,
    model: SETUP_CHAT_MODEL,
    candidates: isAdmin ? await listProjectTeammateCandidates(project) : [],
    canInviteTeammates: isAdmin,
    foundationAnswers: foundationAnswersFromIntake(row),
    build: null,
    chatThreadId: null,
    thread: null,
    design: null,
  };
}

function foundationAnswersFromIntake(row: typeof rfpRequests.$inferSelect): string[] {
  const proposal = row.proposal?.document;
  const sections = proposal?.kind === 'proposal' ? proposal.sections : null;
  const audience = row.audience === 'mixed' ? 'internal and external users' : `${row.audience} users`;
  const product = `${row.title}. ${row.request} Intended for ${audience}.`;
  const firstRelease = sections?.scope?.length
    ? sections.scope.map((item) => `- ${item}`).join('\n')
    : row.request;
  return [
    product,
    row.problem,
    firstRelease,
    '',
  ];
}

export async function getProductSetup(project: string, userId: string): Promise<ProductSetupStatus> {
  const roles = await getUserProjectRoles(userId, project);
  const isAdmin = roles.includes('admin');

  const row = await db.query.rfpRequests.findFirst({
    where: and(
      eq(rfpRequests.apexProject, project),
      isNotNull(rfpRequests.approvedAt),
      ne(rfpRequests.status, 'archived'),
    ),
  });
  if (!row?.approvedRepoName) return inactive();
  if (!isAdmin && row.ownerId !== userId) return inactive();

  let productFile: string | null;
  try {
    productFile = await new AzureDevOpsService(RFP_APPS_ADO_PROJECT).getRepositoryFile(
      RFP_APPS_ADO_PROJECT,
      row.approvedRepoName,
      'PRODUCT.md',
    );
  } catch {
    // A failed lookup does not prove the file exists, so the foundation guide stays up.
    return foundationStatus(project, row, isAdmin);
  }

  if (productFile === null) return foundationStatus(project, row, isAdmin);

  return getProductBuildSetup(project, userId);
}

/** The approved repo for a project whose PRODUCT.md has not been written yet. */
export async function requireOpenProductSetup(project: string, userId: string): Promise<{ repoName: string }> {
  const row = await db.query.rfpRequests.findFirst({
    where: and(
      eq(rfpRequests.apexProject, project),
      isNotNull(rfpRequests.approvedAt),
      ne(rfpRequests.status, 'archived'),
    ),
  });
  if (!row?.approvedRepoName) {
    throw new ProductFoundationError('This project is not waiting on a product foundation.', 404, 'SETUP_INACTIVE');
  }

  if (row.ownerId !== userId) {
    const roles = await getUserProjectRoles(userId, project);
    if (!roles.includes('admin')) {
      throw new ProductFoundationError(
        'Only the approved requester or a project admin can set up this product.',
        403,
        'FORBIDDEN',
      );
    }
  }

  let existing: string | null;
  try {
    existing = await new AzureDevOpsService(RFP_APPS_ADO_PROJECT).getRepositoryFile(
      RFP_APPS_ADO_PROJECT,
      row.approvedRepoName,
      'PRODUCT.md',
    );
  } catch {
    throw new ProductFoundationError('The repository could not be read.', 502, 'REPO_UNAVAILABLE');
  }
  if (existing !== null) {
    throw new ProductFoundationError('PRODUCT.md is already in the repository.', 409, 'SETUP_CLOSED');
  }
  return { repoName: row.approvedRepoName };
}
