import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  appRoles,
  appUserProjectRoles,
  appUsers,
  projectMenuSettings,
  projectSkillSettings,
  rfpProposalJobs,
  rfpRequestEvents,
  rfpRequests,
  userProjectAssignments,
} from '../db/schema';
import {
  RFP_APPS_ADO_PROJECT,
  RFP_CLOUD_RESOURCES,
  RFP_PROPOSAL_JOB_ACTIVE_STATUSES,
  isRfpProposalJobActive,
  parseRfpGeneratedDraft,
  rfpRepoNameFromTitle,
  rfpRequestorLink,
  rfpTriageLink,
  validateRfpArchitecture,
  validateRfpDraftForPublish,
  type RfpArchitecture,
  type RfpArchitectureInput,
  type RfpCloudResource,
  type RfpCostLine,
  type RfpDraftKind,
  type RfpGeneratedDraft,
  type RfpProposal,
  type RfpPublishProposalInput,
  type RfpRequest,
  type RfpVerdict,
  type SubmitRfpReviewInput,
} from '../../shared/types/rfpIntake';
import { AzureDevOpsService } from './azureDevOps';
import { createNotification } from './notificationService';
import { listProjectCatalog } from './projectCatalogService';
import { listSkillConfigsForProject, upsertSkillConfig } from './projectSettingsService';
import {
  PRODUCT_FOUNDATION_SKILL_PATH,
  SETUP_CHAT_MODEL,
  seedNewProjectSkills,
} from './newProjectSkillSeedService';
import {
  actorCanManageRfp,
  getRequestById,
  resolveRfpSubmissionRecipients,
  RfpIntakeError,
  toRequesterView,
} from './rfpIntakeService';
import {
  loadRfpReviewState,
  rfpReviewFingerprint,
  type RfpDbExecutor,
  type RfpRequestRow,
  type RfpReviewState,
} from './rfpProposalFingerprint';
import type { MenuItemKey } from '../../shared/types/menuSettings';

type ProposalJobRow = typeof rfpProposalJobs.$inferSelect;

/** Interview and Apex Backlog only, until intake projects get their own skill setup. */
const INTAKE_PROJECT_MENU_VIEWS: MenuItemKey[] = ['backlog', 'feature-requests'];
const INTAKE_PROJECT_ADMIN_ROLE = 'admin';

interface ManageOptions {
  isSuperAdmin?: boolean;
}

const ACTIVE = [...RFP_PROPOSAL_JOB_ACTIVE_STATUSES];

async function requireManage(actorId: string, options?: ManageOptions): Promise<void> {
  if (options?.isSuperAdmin) return;
  if (!(await actorCanManageRfp(actorId))) {
    throw new RfpIntakeError('Forbidden', 403, 'FORBIDDEN');
  }
}

function requireNotApproved(row: RfpRequestRow): void {
  if (row.approvedAt) {
    throw new RfpIntakeError('The requester already approved this proposal', 409, 'ALREADY_APPROVED');
  }
}

/** In-app plus Teams. createNotification sends both. The actor is skipped. */
async function notifyPlatformAdmins(
  rfpId: string,
  actorId: string,
  payload: { title: string; body: string },
  extraUserIds: string[] = [],
): Promise<void> {
  let admins: string[] = [];
  try {
    admins = await resolveRfpSubmissionRecipients();
  } catch {
    admins = [];
  }
  const recipients = [...new Set([...admins, ...extraUserIds])].filter((userId) => userId && userId !== actorId);
  await Promise.all(recipients.map(async (userId) => {
    try {
      await createNotification(userId, {
        type: 'user-action',
        title: payload.title,
        body: payload.body,
        link: rfpTriageLink(rfpId),
      });
    } catch {
      // One recipient failing must not block the others or the recorded decision.
    }
  }));
}

async function loadLockedState(tx: RfpDbExecutor, rfpId: string): Promise<RfpReviewState> {
  const state = await loadRfpReviewState(tx, rfpId, { lock: true });
  if (!state) throw new RfpIntakeError('RFP not found', 404, 'NOT_FOUND');
  requireNotApproved(state.row);
  return state;
}

async function loadCurrentJob(tx: RfpDbExecutor, row: RfpRequestRow): Promise<ProposalJobRow | null> {
  if (!row.currentProposalJobId) return null;
  return (await tx.query.rfpProposalJobs.findFirst({ where: eq(rfpProposalJobs.id, row.currentProposalJobId) })) ?? null;
}

async function loadUpdatedRequest(rfpId: string): Promise<RfpRequest> {
  const updated = await getRequestById(rfpId);
  if (!updated) throw new RfpIntakeError('RFP not found', 404, 'NOT_FOUND');
  return updated;
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } } | null);
  return code?.code === '23505' || code?.cause?.code === '23505';
}

function orderedResources(resources: RfpCloudResource[]): RfpCloudResource[] {
  const selected = new Set(resources);
  return RFP_CLOUD_RESOURCES.filter((resource) => selected.has(resource));
}

function normalizeArchitecture(input: RfpArchitectureInput, actorId: string, now: string): RfpArchitecture {
  const errors = validateRfpArchitecture(input);
  if (errors.length > 0) throw new RfpIntakeError(errors.join('; '), 400, 'VALIDATION');
  return {
    appType: input.appType,
    resources: orderedResources(input.resources),
    requiresAi: input.requiresAi,
    domainName: input.appType === 'web' ? (input.domainName?.trim() || null) : null,
    sizing: {
      ...input.sizing,
      aiUsage: input.requiresAi ? input.sizing.aiUsage : null,
    },
    updatedBy: actorId,
    updatedAt: now,
  };
}

async function supersedeActiveJobs(tx: RfpDbExecutor, rfpId: string, now: string): Promise<void> {
  await tx.update(rfpProposalJobs)
    .set({
      status: 'superseded',
      completedAt: now,
      updatedAt: now,
      ownerInstance: null,
      heartbeatAt: null,
      lockExpiresAt: null,
    })
    .where(and(eq(rfpProposalJobs.rfpRequestId, rfpId), inArray(rfpProposalJobs.status, ACTIVE)));
}

async function queueJob(
  tx: RfpDbExecutor,
  rfpId: string,
  kind: RfpDraftKind,
  verdict: RfpVerdict,
  fingerprint: string,
  actorId: string,
): Promise<string> {
  const [job] = await tx.insert(rfpProposalJobs)
    .values({ rfpRequestId: rfpId, kind, verdict, inputFingerprint: fingerprint, requestedBy: actorId })
    .returning({ id: rfpProposalJobs.id });
  if (!job) throw new RfpIntakeError('Could not queue proposal generation', 500, 'QUEUE_FAILED');
  return job.id;
}

async function withJobConflictMapping<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new RfpIntakeError('Proposal generation is already running', 409, 'GENERATION_ACTIVE');
    }
    throw err;
  }
}

/**
 * Saves the admin review and, for build/rent/buy/decline verdicts, queues the proposal or
 * decision summary. Resubmitting an unchanged review reuses the running or finished job.
 */
export async function submitReview(
  rfpId: string,
  actorId: string,
  input: SubmitRfpReviewInput,
  options?: ManageOptions,
): Promise<RfpRequest> {
  await requireManage(actorId, options);
  await withJobConflictMapping(() => db.transaction(async (tx) => {
    const now = new Date().toISOString();
    const state = await loadLockedState(tx, rfpId);
    const { row, verdict, kind } = state;
    if (row.aiStatus === 'evaluating') {
      throw new RfpIntakeError('Wait for the evaluation to finish before submitting the review', 409, 'EVALUATING');
    }
    if (!verdict) {
      throw new RfpIntakeError('The request needs a verdict before the review can be submitted', 409, 'VERDICT_REQUIRED');
    }

    let architecture = row.architecture;
    if (input.architecture) {
      architecture = normalizeArchitecture(input.architecture, actorId, now);
    } else if (kind !== 'decision-summary') {
      throw new RfpIntakeError('architecture is required', 400, 'VALIDATION');
    }

    if (!kind) {
      await supersedeActiveJobs(tx, rfpId, now);
      await tx.update(rfpRequests)
        .set({
          architecture,
          reviewSubmittedAt: null,
          reviewSubmittedBy: null,
          currentProposalJobId: null,
          proposalDraft: null,
          updatedAt: now,
        })
        .where(eq(rfpRequests.id, rfpId));
      await tx.insert(rfpRequestEvents).values({
        rfpRequestId: rfpId,
        eventType: 'review-submitted',
        actorId,
        payload: { verdict, kind: null },
      });
      return;
    }

    const fingerprint = rfpReviewFingerprint(kind, verdict, kind === 'proposal' ? architecture : null);
    const currentJob = await loadCurrentJob(tx, row);
    const reusable = currentJob
      && currentJob.inputFingerprint === fingerprint
      && (isRfpProposalJobActive(currentJob.status) || currentJob.status === 'ready');

    if (reusable) {
      await tx.update(rfpRequests)
        .set({
          reviewSubmittedAt: row.reviewSubmittedAt ?? now,
          reviewSubmittedBy: row.reviewSubmittedBy ?? actorId,
          updatedAt: now,
        })
        .where(eq(rfpRequests.id, rfpId));
      await tx.insert(rfpRequestEvents).values({
        rfpRequestId: rfpId,
        eventType: 'review-submitted',
        actorId,
        payload: { verdict, kind, jobId: currentJob.id, reused: true },
      });
      return;
    }

    await supersedeActiveJobs(tx, rfpId, now);
    const jobId = await queueJob(tx, rfpId, kind, verdict, fingerprint, actorId);
    const publishedStale = Boolean(row.proposal && mapPublishedFingerprint(row.proposal) !== fingerprint);
    await tx.update(rfpRequests)
      .set({
        architecture,
        reviewSubmittedAt: now,
        reviewSubmittedBy: actorId,
        currentProposalJobId: jobId,
        proposalDraft: null,
        ...(publishedStale ? { proposal: null } : {}),
        updatedAt: now,
      })
      .where(eq(rfpRequests.id, rfpId));
    await tx.insert(rfpRequestEvents).values({
      rfpRequestId: rfpId,
      eventType: 'review-submitted',
      actorId,
      payload: {
        verdict,
        kind,
        jobId,
        resources: architecture?.resources ?? [],
        proposalCleared: publishedStale,
      },
    });
  }));
  return loadUpdatedRequest(rfpId);
}

function mapPublishedFingerprint(proposal: RfpProposal): string | null {
  return proposal && typeof proposal === 'object' && 'document' in proposal
    ? proposal.document.inputFingerprint
    : null;
}

/** Queues a fresh draft after a failure or when the admin wants a new version. */
export async function regenerateProposal(rfpId: string, actorId: string, options?: ManageOptions): Promise<RfpRequest> {
  await requireManage(actorId, options);
  await withJobConflictMapping(() => db.transaction(async (tx) => {
    const now = new Date().toISOString();
    const state = await loadLockedState(tx, rfpId);
    const { row, verdict, kind, fingerprint } = state;
    if (!row.reviewSubmittedAt) {
      throw new RfpIntakeError('Submit the review before generating a proposal', 409, 'REVIEW_NOT_SUBMITTED');
    }
    if (!verdict || !kind || !fingerprint) {
      throw new RfpIntakeError('This verdict does not produce a proposal', 409, 'NO_DRAFT_FOR_VERDICT');
    }
    if (kind === 'proposal' && !row.architecture) {
      throw new RfpIntakeError('Save the architecture before generating a proposal', 409, 'ARCHITECTURE_REQUIRED');
    }
    const currentJob = await loadCurrentJob(tx, row);
    if (currentJob && isRfpProposalJobActive(currentJob.status)) {
      throw new RfpIntakeError('Proposal generation is already running', 409, 'GENERATION_ACTIVE');
    }
    const jobId = await queueJob(tx, rfpId, kind, verdict, fingerprint, actorId);
    await tx.update(rfpRequests)
      .set({ currentProposalJobId: jobId, proposalDraft: null, updatedAt: now })
      .where(eq(rfpRequests.id, rfpId));
  }));
  return loadUpdatedRequest(rfpId);
}

async function requireCurrentReadyJob(tx: RfpDbExecutor, state: RfpReviewState): Promise<ProposalJobRow> {
  const job = await loadCurrentJob(tx, state.row);
  if (!job || job.status !== 'ready') {
    throw new RfpIntakeError('There is no finished draft to work with yet', 409, 'DRAFT_NOT_READY');
  }
  if (state.fingerprint !== job.inputFingerprint) {
    throw new RfpIntakeError(
      'The review changed after this draft was generated. Regenerate the proposal.',
      409,
      'STALE_DRAFT',
    );
  }
  return job;
}

/** Admin edits keep the generated evidence; only amounts, labels, quantities, assumptions, and confirmation change. */
function mergeCostLines(stored: RfpCostLine[], edited: RfpCostLine[]): RfpCostLine[] {
  const storedById = new Map(stored.map((line) => [line.id, line]));
  if (edited.length !== stored.length || edited.some((line) => !storedById.has(line.id))) {
    throw new RfpIntakeError('costLines must match the generated draft', 400, 'VALIDATION');
  }
  return edited.map((line) => {
    const original = storedById.get(line.id)!;
    const amountsChanged = JSON.stringify(line.amounts) !== JSON.stringify(original.amounts);
    return {
      ...original,
      label: line.label,
      quantity: line.quantity,
      amounts: line.amounts,
      assumptions: line.assumptions,
      adminConfirmed: line.adminConfirmed,
      priceStatus: amountsChanged && original.priceStatus !== 'estimate' ? 'estimate' : original.priceStatus,
    };
  });
}

export async function saveProposalDraft(
  rfpId: string,
  actorId: string,
  raw: unknown,
  options?: ManageOptions,
): Promise<RfpRequest> {
  await requireManage(actorId, options);
  const edited = parseRfpGeneratedDraft(raw);
  if (!edited) throw new RfpIntakeError('draft is invalid', 400, 'VALIDATION');

  await db.transaction(async (tx) => {
    const now = new Date().toISOString();
    const state = await loadLockedState(tx, rfpId);
    const job = await requireCurrentReadyJob(tx, state);
    const stored = state.row.proposalDraft;
    if (!stored || edited.jobId !== job.id || edited.inputFingerprint !== job.inputFingerprint) {
      throw new RfpIntakeError('This draft is out of date. Reload the request.', 409, 'STALE_DRAFT');
    }
    if (edited.kind !== stored.kind) {
      throw new RfpIntakeError('draft kind cannot change', 400, 'VALIDATION');
    }
    const audit = {
      version: stored.version,
      jobId: stored.jobId,
      inputFingerprint: stored.inputFingerprint,
      verdict: stored.verdict,
      generatedAt: stored.generatedAt,
      editedBy: actorId,
      editedAt: now,
    };
    const candidate: unknown = edited.kind === 'proposal' && stored.kind === 'proposal'
      ? { ...edited, ...audit, costLines: mergeCostLines(stored.costLines, edited.costLines) }
      : { ...edited, ...audit };
    const next = parseRfpGeneratedDraft(candidate);
    if (!next) throw new RfpIntakeError('draft is invalid', 400, 'VALIDATION');

    await tx.update(rfpRequests)
      .set({ proposalDraft: next, updatedAt: now })
      .where(eq(rfpRequests.id, rfpId));
    await tx.insert(rfpRequestEvents).values({
      rfpRequestId: rfpId,
      eventType: 'proposal-draft-edited',
      actorId,
      payload: { jobId: job.id, kind: next.kind },
    });
  });
  return loadUpdatedRequest(rfpId);
}

export async function publishProposal(
  rfpId: string,
  actorId: string,
  input: RfpPublishProposalInput,
  options?: ManageOptions,
): Promise<RfpRequest> {
  await requireManage(actorId, options);
  const published = await db.transaction(async (tx) => {
    const now = new Date().toISOString();
    const state = await loadLockedState(tx, rfpId);
    const job = await requireCurrentReadyJob(tx, state);
    const draft: RfpGeneratedDraft | null = state.row.proposalDraft;
    if (!draft || draft.jobId !== job.id || draft.inputFingerprint !== job.inputFingerprint) {
      throw new RfpIntakeError('This draft is out of date. Reload the request.', 409, 'STALE_DRAFT');
    }

    let productOwnerId: string | null = null;
    let productOwnerName: string | null = null;
    if (draft.kind === 'proposal') {
      productOwnerId = input.productOwnerId?.trim() || null;
      if (!productOwnerId) throw new RfpIntakeError('productOwnerId is required', 400, 'VALIDATION');
      const owner = await tx.query.appUsers.findFirst({ where: eq(appUsers.oid, productOwnerId) });
      if (!owner) throw new RfpIntakeError('productOwnerId is not an Apex user', 400, 'VALIDATION');
      productOwnerName = owner.displayName || owner.email || owner.oid;
      const errors = validateRfpDraftForPublish(draft);
      if (errors.length > 0) throw new RfpIntakeError(errors.join('; '), 400, 'VALIDATION');
    }

    const proposal: RfpProposal = {
      document: draft,
      productOwnerId,
      productOwnerName,
      publishedBy: actorId,
      publishedAt: now,
    };
    await tx.update(rfpRequests)
      .set({ proposal, updatedAt: now })
      .where(eq(rfpRequests.id, rfpId));
    await tx.insert(rfpRequestEvents).values({
      rfpRequestId: rfpId,
      eventType: 'proposal-published',
      actorId,
      payload: { kind: draft.kind, jobId: job.id, productOwnerId },
    });
    return { ownerId: state.row.ownerId, title: state.row.title, kind: draft.kind };
  });

  try {
    await createNotification(published.ownerId, {
      type: 'user-action',
      title: published.kind === 'proposal'
        ? 'Your product proposal is ready to review'
        : 'Apex triage made a decision on your request',
      body: published.title,
      link: rfpRequestorLink(rfpId),
    });
  } catch {
    // Delivery is best-effort and must not roll back the published proposal.
  }

  return loadUpdatedRequest(rfpId);
}

async function reserveRepository(row: RfpRequestRow): Promise<{ repoName: string; apexProject: string }> {
  if (row.approvedRepoName && row.apexProject) {
    return { repoName: row.approvedRepoName, apexProject: row.apexProject };
  }

  const apexProject = row.title.trim();
  const catalog = await listProjectCatalog();
  const taken = catalog.some((project) => project.name.trim().toLowerCase() === apexProject.toLowerCase());
  if (taken) {
    throw new RfpIntakeError(
      `An Apex project named "${apexProject}" already exists. Ask Apex triage to rename the request.`,
      409,
      'PROJECT_NAME_TAKEN',
    );
  }

  const repoName = rfpRepoNameFromTitle(row.title);
  let repo: { name: string; webUrl: string };
  try {
    repo = await new AzureDevOpsService(RFP_APPS_ADO_PROJECT).createGitRepository(RFP_APPS_ADO_PROJECT, repoName);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RfpIntakeError(
      `Azure DevOps could not create the repository: ${reason}`,
      502,
      'REPO_CREATE_FAILED',
    );
  }

  await db.update(rfpRequests)
    .set({
      approvedRepoName: repo.name,
      approvedRepoUrl: repo.webUrl,
      apexProject,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(rfpRequests.id, row.id));
  return { repoName: repo.name, apexProject };
}

async function seedIntakeRepository(repoName: string): Promise<void> {
  const ado = new AzureDevOpsService(RFP_APPS_ADO_PROJECT);
  try {
    await seedNewProjectSkills({
      alreadySeeded: async () => (
        await ado.getRepositoryFile(RFP_APPS_ADO_PROJECT, repoName, PRODUCT_FOUNDATION_SKILL_PATH)
      ) !== null,
      push: (changes) => ado.pushRepositoryFiles(
        RFP_APPS_ADO_PROJECT,
        repoName,
        'main',
        'Add new-project skills',
        changes,
      ),
    });
  } catch (err) {
    if (err instanceof RfpIntakeError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new RfpIntakeError(
      `The new-project skills could not be added to the repository: ${reason}`,
      502,
      'SKILL_SEED_FAILED',
    );
  }
}

export async function approveProposal(rfpId: string, ownerId: string): Promise<RfpRequest> {
  const row = await db.query.rfpRequests.findFirst({ where: eq(rfpRequests.id, rfpId) });
  if (!row || row.ownerId !== ownerId) {
    throw new RfpIntakeError('RFP not found', 404, 'NOT_FOUND');
  }
  requireNotApproved(row);
  const document = row.proposal && 'document' in row.proposal ? row.proposal.document : null;
  if (!document) {
    throw new RfpIntakeError('No proposal has been published yet', 409, 'PROPOSAL_NOT_PUBLISHED');
  }
  if (document.kind !== 'proposal') {
    throw new RfpIntakeError('A decision summary cannot be approved', 409, 'NOT_APPROVABLE');
  }
  if (row.proposal?.rejection) {
    throw new RfpIntakeError('This proposal was rejected. Wait for a revised version.', 409, 'PROPOSAL_REJECTED');
  }

  const { repoName, apexProject } = await reserveRepository(row);
  await seedIntakeRepository(repoName);

  const existingConfigs = await listSkillConfigsForProject(apexProject);
  if (existingConfigs.length === 0) {
    await upsertSkillConfig({
      project: apexProject,
      friendlyName: apexProject,
      skillProvider: 'ado',
      skillRepo: `${RFP_APPS_ADO_PROJECT}/${repoName}`,
      skillBranch: 'main',
      isDefault: true,
      updatedBy: ownerId,
      defaultModel: SETUP_CHAT_MODEL,
      quickSkillPills: [{
        label: 'Product foundation',
        skillPath: PRODUCT_FOUNDATION_SKILL_PATH,
        model: SETUP_CHAT_MODEL,
        description: 'Who the product is for, what the first release includes, and how you would know it worked.',
      }],
    });
  }

  const productOwnerId = row.proposal?.productOwnerId ?? null;
  const adminRole = productOwnerId
    ? await db.query.appRoles.findFirst({ where: eq(appRoles.name, INTAKE_PROJECT_ADMIN_ROLE) })
    : null;
  if (productOwnerId && !adminRole) {
    throw new RfpIntakeError('The admin role is missing, so the product owner cannot manage the project', 500, 'ADMIN_ROLE_MISSING');
  }

  const approvedAt = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.insert(userProjectAssignments)
      .values({ userId: ownerId, project: apexProject, assignedBy: ownerId, assignedAt: approvedAt })
      .onConflictDoNothing();
    if (productOwnerId && adminRole) {
      if (productOwnerId !== ownerId) {
        await tx.insert(userProjectAssignments)
          .values({ userId: productOwnerId, project: apexProject, assignedBy: ownerId, assignedAt: approvedAt })
          .onConflictDoNothing();
      }
      await tx.insert(appUserProjectRoles)
        .values({ userId: productOwnerId, project: apexProject, roleId: adminRole.id, assignedBy: ownerId, assignedAt: approvedAt })
        .onConflictDoNothing();
    }
    await tx.insert(projectMenuSettings)
      .values({ project: apexProject, enabledViews: INTAKE_PROJECT_MENU_VIEWS, updatedBy: ownerId })
      .onConflictDoUpdate({
        target: projectMenuSettings.project,
        set: { enabledViews: INTAKE_PROJECT_MENU_VIEWS, updatedBy: ownerId, updatedAt: approvedAt },
      });
    await tx.update(rfpRequests)
      .set({ approvedAt, updatedAt: approvedAt })
      .where(eq(rfpRequests.id, rfpId));
    await tx.insert(rfpRequestEvents).values({
      rfpRequestId: rfpId,
      eventType: 'proposal-approved',
      actorId: ownerId,
      payload: { repoName, apexProject },
    });
  });

  await notifyPlatformAdmins(rfpId, ownerId, {
    title: 'A requester approved the proposal',
    body: row.title,
  });

  if (productOwnerId) {
    try {
      await createNotification(productOwnerId, {
        type: 'user-action',
        title: 'You are the admin of a new Apex project',
        body: `${apexProject} is ready. Pick it from project selection to start managing it.`,
        link: '/',
      });
    } catch {
      // Delivery is best-effort; the project and role are already in place.
    }
  }

  return toRequesterView(await loadUpdatedRequest(rfpId));
}

export async function rejectProposal(rfpId: string, ownerId: string, reason: string): Promise<RfpRequest> {
  const trimmed = reason.trim();
  if (!trimmed || trimmed.length > 2000) {
    throw new RfpIntakeError('A rejection reason is required', 400, 'VALIDATION');
  }
  const row = await db.query.rfpRequests.findFirst({ where: eq(rfpRequests.id, rfpId) });
  if (!row || row.ownerId !== ownerId) {
    throw new RfpIntakeError('RFP not found', 404, 'NOT_FOUND');
  }
  requireNotApproved(row);
  const proposal = row.proposal && 'document' in row.proposal ? row.proposal : null;
  if (!proposal) {
    throw new RfpIntakeError('No proposal has been published yet', 409, 'PROPOSAL_NOT_PUBLISHED');
  }
  if (proposal.document.kind !== 'proposal') {
    throw new RfpIntakeError('A decision summary cannot be rejected', 409, 'NOT_REJECTABLE');
  }
  if (proposal.rejection) {
    throw new RfpIntakeError('This proposal was already rejected', 409, 'ALREADY_REJECTED');
  }

  const rejectedAt = new Date().toISOString();
  const nextProposal: RfpProposal = {
    ...proposal,
    rejection: { rejectedAt, rejectedBy: ownerId, reason: trimmed },
  };
  await db.transaction(async (tx) => {
    await tx.update(rfpRequests)
      .set({ proposal: nextProposal, updatedAt: rejectedAt })
      .where(eq(rfpRequests.id, rfpId));
    await tx.insert(rfpRequestEvents).values({
      rfpRequestId: rfpId,
      eventType: 'proposal-rejected',
      actorId: ownerId,
      payload: { reason: trimmed },
    });
  });

  await notifyPlatformAdmins(rfpId, ownerId, {
    title: 'A requester rejected the proposal',
    body: `${row.title}: ${trimmed}`,
  }, [proposal.publishedBy]);

  return toRequesterView(await loadUpdatedRequest(rfpId));
}

export async function deleteIntakeProject(
  rfpId: string,
  actorId: string,
  options?: ManageOptions,
): Promise<RfpRequest> {
  await requireManage(actorId, options);
  const row = await db.query.rfpRequests.findFirst({ where: eq(rfpRequests.id, rfpId) });
  if (!row) throw new RfpIntakeError('RFP not found', 404, 'NOT_FOUND');
  if (!row.apexProject || !row.approvedAt) {
    throw new RfpIntakeError('This request has no project to delete', 409, 'PROJECT_NOT_CREATED');
  }

  if (row.status === 'archived') {
    throw new RfpIntakeError('This request is already archived', 409, 'ALREADY_ARCHIVED');
  }

  const projectName = row.apexProject;
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.delete(projectSkillSettings).where(eq(projectSkillSettings.project, projectName));
    await tx.delete(userProjectAssignments).where(eq(userProjectAssignments.project, projectName));
    await tx.delete(appUserProjectRoles).where(eq(appUserProjectRoles.project, projectName));
    await tx.delete(projectMenuSettings).where(eq(projectMenuSettings.project, projectName));
    await tx.update(rfpRequests)
      .set({
        status: 'archived',
        updatedAt: now,
      })
      .where(eq(rfpRequests.id, rfpId));
    await tx.insert(rfpRequestEvents).values({
      rfpRequestId: rfpId,
      eventType: 'proposal-project-deleted',
      actorId,
      payload: { apexProject: projectName, repoName: row.approvedRepoName, status: 'archived' },
    });
  });

  try {
    await createNotification(row.ownerId, {
      type: 'user-action',
      title: 'Your Apex project was archived',
      body: `${row.title} is archived and hidden from project selection.`,
      link: rfpRequestorLink(rfpId),
    });
  } catch {
    // Delivery is best-effort and must not undo the archive.
  }

  return loadUpdatedRequest(rfpId);
}

/** Intake projects a platform admin archived. Hidden from project selection. */
export async function listArchivedIntakeProjectNames(): Promise<string[]> {
  const rows = await db.query.rfpRequests.findMany({
    where: and(eq(rfpRequests.status, 'archived'), isNotNull(rfpRequests.apexProject)),
    columns: { apexProject: true },
  });
  return rows
    .map((row) => row.apexProject?.trim() ?? '')
    .filter(Boolean);
}

/** Projects created from approved proposals; kept out of the request-access catalog. */
export async function listIntakePrivateProjectNames(): Promise<string[]> {
  const rows = await db.query.rfpRequests.findMany({
    where: isNotNull(rfpRequests.apexProject),
    columns: { apexProject: true },
  });
  return rows
    .map((row) => row.apexProject?.trim() ?? '')
    .filter(Boolean);
}
