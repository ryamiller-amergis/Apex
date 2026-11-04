/**
 * Pure pull request body composer with redaction, 4,000-character tiered fit,
 * and overflow comment generation (FEAT-015, PBI-034, TBI-027 / S3).
 */
import type {
  BuildRequirementKind,
  BuildRiskDecision,
  BuildSupportContact,
  BuildVerificationStatus,
} from '../../../shared/types/build';
import { formatSupportContacts } from '../../../shared/buildPlanCopy';
import { redactText } from '../buildRedactionService';

export const ADO_PR_DESCRIPTION_MAX_CHARS = 4000;

export interface PullRequestRequirementEntry {
  id: string;
  kind: BuildRequirementKind;
  text: string;
  retired: boolean;
  verificationStatus: BuildVerificationStatus;
  deferralReason?: string | null;
}

export interface ComposePullRequestBodyInput {
  buildId: string;
  briefTitle: string;
  revisionNumber: number;
  requesterDisplayName: string;
  acceptedAtIso: string;
  riskDecisions: readonly BuildRiskDecision[];
  requirements: readonly PullRequestRequirementEntry[];
  supportContacts: readonly BuildSupportContact[];
  syncCommitSha: string | null;
}

export interface ComposedPullRequestBody {
  title: string;
  description: string;
  overflowComment: string | null;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function formatRequirementLine(
  req: PullRequestRequirementEntry,
  maxTextLen: number | null
): string {
  const safeText = redactText(req.text);
  const text = maxTextLen ? truncateText(safeText, maxTextLen) : safeText;
  if (req.retired || req.verificationStatus === 'retired') {
    return `- ${req.id}: ${text} (retired)`;
  }
  if (req.verificationStatus === 'deferred') {
    const reason = req.deferralReason
      ? redactText(req.deferralReason)
      : 'deferred';
    const truncReason = maxTextLen ? truncateText(reason, maxTextLen) : reason;
    return `- ${req.id}: ${text} — deferred: ${truncReason}`;
  }
  return `- ${req.id}: ${text} — ${req.verificationStatus}`;
}

function formatRiskDecisionLine(
  rd: BuildRiskDecision,
  maxRationaleLen: number | null
): string {
  const safeDecision = redactText(rd.decision);
  const safeRationale = redactText(rd.rationale);
  const decision = maxRationaleLen
    ? truncateText(safeDecision, maxRationaleLen)
    : safeDecision;
  const rationale = maxRationaleLen
    ? truncateText(safeRationale, maxRationaleLen)
    : safeRationale;
  return `- ${rd.id} [${rd.rating}] ${decision} — ${rationale}`;
}

function renderBody(
  input: ComposePullRequestBodyInput,
  opts: {
    rationaleMax: number | null;
    reqTextMax: number | null;
    collapseRequirements: boolean;
  }
): string {
  const safeTitle = redactText(input.briefTitle);
  const safeRequester = redactText(input.requesterDisplayName);
  const contactLabels = input.supportContacts.map((c) =>
    redactText(c.displayName)
  );
  const reviewerNames = formatSupportContacts(contactLabels);

  const lines: string[] = [
    `# ${safeTitle} (Revision ${input.revisionNumber})`,
    '',
    `- Requester: ${safeRequester}`,
    `- Accepted at: ${input.acceptedAtIso}`,
    `- Apex Build Run: /builds/${encodeURIComponent(input.buildId)}`,
    '',
    `## Risk decisions (${input.riskDecisions.length})`,
  ];

  if (input.riskDecisions.length === 0) {
    lines.push('- None recorded.');
  } else {
    for (const rd of input.riskDecisions) {
      lines.push(formatRiskDecisionLine(rd, opts.rationaleMax));
    }
  }

  lines.push('', `## Requirements verified (${input.requirements.length})`);
  if (input.requirements.length === 0) {
    lines.push('- None recorded.');
  } else if (opts.collapseRequirements) {
    const ids = input.requirements.map((r) => r.id).join(', ');
    lines.push(
      `- ${input.requirements.length} requirements verified (${ids}). See full comment thread for details.`
    );
  } else {
    for (const req of input.requirements) {
      lines.push(formatRequirementLine(req, opts.reqTextMax));
    }
  }

  if (input.syncCommitSha) {
    const shortSha = redactText(input.syncCommitSha).slice(0, 7);
    lines.push(
      '',
      '## Sync commit',
      `- A sync commit was added after the accepted preview (${shortSha}). No new preview was made for it.`
    );
  }

  lines.push(
    '',
    '## Review',
    `- Reviewers: ${reviewerNames}`,
    '- Branch policies apply as usual. Apex does not complete the pull request.'
  );

  return lines.join('\n');
}

export function composePullRequestBody(
  input: ComposePullRequestBodyInput
): ComposedPullRequestBody {
  const safeTitle = redactText(
    `${input.briefTitle} (Build revision ${input.revisionNumber})`
  ).slice(0, 200);

  const fullBody = renderBody(input, {
    rationaleMax: null,
    reqTextMax: null,
    collapseRequirements: false,
  });

  if (fullBody.length <= ADO_PR_DESCRIPTION_MAX_CHARS) {
    return {
      title: safeTitle,
      description: fullBody,
      overflowComment: null,
    };
  }

  // Tier 1: shorten rationales to 160 chars and requirement text to 80 chars
  const tier1 = renderBody(input, {
    rationaleMax: 160,
    reqTextMax: 80,
    collapseRequirements: false,
  });
  if (tier1.length <= ADO_PR_DESCRIPTION_MAX_CHARS) {
    return {
      title: safeTitle,
      description: tier1,
      overflowComment: fullBody,
    };
  }

  // Tier 2: collapse requirement list to counts and IDs
  const tier2 = renderBody(input, {
    rationaleMax: 160,
    reqTextMax: 80,
    collapseRequirements: true,
  });
  if (tier2.length <= ADO_PR_DESCRIPTION_MAX_CHARS) {
    return {
      title: safeTitle,
      description: tier2,
      overflowComment: fullBody,
    };
  }

  // Tier 3: shorten rationales to 30 chars (preserving all RD IDs and ratings)
  const tier3 = renderBody(input, {
    rationaleMax: 30,
    reqTextMax: 40,
    collapseRequirements: true,
  });

  return {
    title: safeTitle,
    description: tier3.slice(0, ADO_PR_DESCRIPTION_MAX_CHARS),
    overflowComment: fullBody,
  };
}
