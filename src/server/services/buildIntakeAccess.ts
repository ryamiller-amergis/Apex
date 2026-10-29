/**
 * The build-intake rule: only the requester (interview author), a Project Admin of the
 * interview's project, or a Platform Admin may answer, draft, edit or approve. No group applies.
 * Callers pass the interview row they already loaded, so the rule adds no query of its own.
 */
import { BUILD_INTAKE_OPTION_KEY } from '../../shared/types/buildPreflight';
import { isPlatformAdmin, isProjectAdmin } from '../utils/rbacHelpers';

export interface BuildIntakeInterviewRow {
  authorId: string | null;
  project: string | null;
  playbookProfileKey?: string | null;
}

export function isBuildIntakeInterview(
  row: { playbookProfileKey?: string | null } | null | undefined,
): boolean {
  return row?.playbookProfileKey === BUILD_INTAKE_OPTION_KEY;
}

export async function canActOnBuildIntakeInterview(
  userId: string,
  interview: Pick<BuildIntakeInterviewRow, 'authorId' | 'project'>,
): Promise<boolean> {
  if (interview.authorId && interview.authorId === userId) return true;
  if (await isPlatformAdmin(userId)) return true;
  return Boolean(interview.project) && isProjectAdmin(userId, interview.project as string);
}
