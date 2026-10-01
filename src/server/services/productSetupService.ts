import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { rfpRequests } from '../db/schema';
import { RFP_APPS_ADO_PROJECT } from '../../shared/types/rfpIntake';
import { AzureDevOpsService } from './azureDevOps';
import { PRODUCT_FOUNDATION_SKILL_PATH, SETUP_CHAT_MODEL } from './newProjectSkillSeedService';
import { listSkillConfigsForProject } from './projectSettingsService';
import { listProjectTeammateCandidates } from './projectTeammateService';
import { getUserProjectRoles } from './rbacService';

export interface ProductSetupStatus {
  active: boolean;
  skillPath: string;
  model: string;
  candidates: { userId: string; displayName: string; email: string }[];
  foundationAnswers: string[];
}

export class ProductFoundationError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'ProductFoundationError';
  }
}

function inactive(): ProductSetupStatus {
  return {
    active: false,
    skillPath: PRODUCT_FOUNDATION_SKILL_PATH,
    model: SETUP_CHAT_MODEL,
    candidates: [],
    foundationAnswers: [],
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
  if (!roles.includes('admin')) return inactive();

  const row = await db.query.rfpRequests.findFirst({
    where: and(
      eq(rfpRequests.apexProject, project),
      isNotNull(rfpRequests.approvedAt),
      ne(rfpRequests.status, 'archived'),
    ),
  });
  if (!row?.approvedRepoName) return inactive();

  try {
    const productFile = await new AzureDevOpsService(RFP_APPS_ADO_PROJECT).getRepositoryFile(
      RFP_APPS_ADO_PROJECT,
      row.approvedRepoName,
      'PRODUCT.md',
    );
    if (productFile !== null) return inactive();
  } catch {
    // A failed lookup does not prove the file exists, so the guide stays up.
  }

  const configs = await listSkillConfigsForProject(project);
  const pill = configs[0]?.quickSkillPills?.find((item) => item.skillPath.includes('product-foundation'));
  return {
    active: true,
    skillPath: pill?.skillPath ?? PRODUCT_FOUNDATION_SKILL_PATH,
    // Product setup is a short, fixed interview. Keep it on the fast model
    // even when the project's general chat default is Auto or a slower model.
    model: SETUP_CHAT_MODEL,
    candidates: await listProjectTeammateCandidates(project),
    foundationAnswers: foundationAnswersFromIntake(row),
  };
}

/** The approved repo for a project whose PRODUCT.md has not been written yet. */
export async function requireOpenProductSetup(project: string, userId: string): Promise<{ repoName: string }> {
  const roles = await getUserProjectRoles(userId, project);
  if (!roles.includes('admin')) {
    throw new ProductFoundationError('Only a project admin can set up this product.', 403, 'FORBIDDEN');
  }

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
