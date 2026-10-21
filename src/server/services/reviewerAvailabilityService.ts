import { getApproverPoolForProject } from './projectSettingsService';
import type {
  ReviewerAvailability,
  ReviewerAvailabilityResponse,
  ReviewerDocumentType,
} from '../../shared/types/approvals';

/**
 * Resolves, per reviewer module, whether the project's configured approver pool
 * currently has at least one selectable candidate.
 *
 * Shared by the kickoff and ADR start flows so both see the same signal.
 * Individuals and current group members are flattened into a unique user-id set,
 * which makes `candidateCount` a count of people rather than pool entries.
 * Deliberately uncached — group membership changes must take effect immediately,
 * so every call re-reads the live configured pool. Modules are resolved
 * concurrently to keep the whole request within the existing latency budget, and
 * the returned list follows the requested order.
 */
export async function resolveReviewerAvailability(
  project: string,
  documentTypes: readonly ReviewerDocumentType[],
): Promise<ReviewerAvailabilityResponse> {
  const modules: ReviewerAvailability[] = await Promise.all(
    documentTypes.map(async (documentType) => {
      const pool = await getApproverPoolForProject(project, documentType);

      const candidateUserIds = new Set<string>();
      for (const individual of pool.individuals) {
        candidateUserIds.add(individual.userId);
      }
      for (const group of pool.groups) {
        for (const member of group.members) {
          candidateUserIds.add(member.userId);
        }
      }

      return {
        documentType,
        available: candidateUserIds.size > 0,
        candidateCount: candidateUserIds.size,
      };
    }),
  );

  return { project, modules };
}
