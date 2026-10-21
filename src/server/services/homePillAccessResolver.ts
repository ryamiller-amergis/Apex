import type { QuickMcpPill, QuickSkillPill } from '../../shared/types/projectSettings';

/**
 * Pure resolver for Home pill access (FEAT-002 / TBI-003).
 *
 * Every input arrives as a plain argument — callers resolve the caller's identity,
 * live group IDs, and super-admin status before calling in, so this module makes no
 * HTTP or database calls of its own.
 */

export interface HomePillAccessInput {
  skillPills?: QuickSkillPill[] | null;
  mcpPills?: QuickMcpPill[] | null;
  callerId?: string | null;
  /** The caller's *current* group IDs. A deleted group never appears here. */
  callerGroupIds?: string[] | null;
  isSuperAdmin?: boolean | null;
}

export interface HomePillAccess {
  allowedSkillPills: QuickSkillPill[];
  allowedMcpPills: QuickMcpPill[];
  canStartPillessChat: boolean;
}

export type ThreadCreationDenialReason =
  | 'skill_pill_not_allowed'
  | 'mcp_pill_not_allowed'
  | 'pilless_chat_not_allowed';

export type ThreadCreationAdmission =
  | { admitted: true; reason?: undefined }
  | { admitted: false; reason: ThreadCreationDenialReason };

export interface ThreadCreationAdmissionInput extends HomePillAccessInput {
  /** Kickoff `skillPath`, matched against a configured skill pill by exact equality. */
  skillPath?: string | null;
  /** Kickoff `mcpPill.mcpServerName`, matched against a configured MCP pill by exact equality. */
  mcpServerName?: string | null;
}

const asArray = <T>(value: T[] | null | undefined): T[] => value ?? [];

/**
 * An empty or omitted allow-list means everyone. Otherwise the caller must be named
 * directly or be a live member of an allow-listed group.
 */
function isPillAllowed(
  pill: { allowedUserIds?: string[] | null; allowedGroupIds?: string[] | null },
  callerId: string | null | undefined,
  callerGroupIds: string[],
): boolean {
  const allowedUserIds = asArray(pill.allowedUserIds);
  const allowedGroupIds = asArray(pill.allowedGroupIds);

  if (allowedUserIds.length === 0 && allowedGroupIds.length === 0) return true;
  if (callerId && allowedUserIds.includes(callerId)) return true;
  return allowedGroupIds.some((groupId) => callerGroupIds.includes(groupId));
}

export function resolveHomePillAccess(input: HomePillAccessInput): HomePillAccess {
  const skillPills = asArray(input.skillPills);
  const mcpPills = asArray(input.mcpPills);
  const callerGroupIds = asArray(input.callerGroupIds);

  const allowed = (pill: { allowedUserIds?: string[] | null; allowedGroupIds?: string[] | null }) =>
    input.isSuperAdmin === true || isPillAllowed(pill, input.callerId, callerGroupIds);

  const allowedSkillPills = skillPills.filter(allowed);
  const allowedMcpPills = mcpPills.filter(allowed);

  const canStartPillessChat =
    (skillPills.length === 0 && mcpPills.length === 0) ||
    allowedSkillPills.length + allowedMcpPills.length > 0;

  return { allowedSkillPills, allowedMcpPills, canStartPillessChat };
}

/**
 * Admission check for Home thread creation (TBI-005). A kickoff matches a configured
 * pill only on exact `skillPath` / `mcpServerName` equality; anything else — including
 * an unmatched `skillPath` — is evaluated as a pill-less start.
 */
export function resolveThreadCreationAdmission(
  input: ThreadCreationAdmissionInput,
): ThreadCreationAdmission {
  const access = resolveHomePillAccess(input);

  const matchedMcp = input.mcpServerName
    ? asArray(input.mcpPills).find((pill) => pill.mcpServerName === input.mcpServerName)
    : undefined;
  if (matchedMcp && !access.allowedMcpPills.includes(matchedMcp)) {
    return { admitted: false, reason: 'mcp_pill_not_allowed' };
  }

  const matchedSkill = input.skillPath
    ? asArray(input.skillPills).find((pill) => pill.skillPath === input.skillPath)
    : undefined;
  if (matchedSkill && !access.allowedSkillPills.includes(matchedSkill)) {
    return { admitted: false, reason: 'skill_pill_not_allowed' };
  }

  if (matchedMcp || matchedSkill) return { admitted: true };

  return access.canStartPillessChat
    ? { admitted: true }
    : { admitted: false, reason: 'pilless_chat_not_allowed' };
}
