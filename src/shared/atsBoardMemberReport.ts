import { z } from 'zod';

export const ATS_BOARD_MEMBER_ROLES = [
  'operations',
  'recruiting',
  'client',
  'compliance',
  'data',
  'product',
  'market',
] as const;

export const ATS_BOARD_MEMBER_RECOMMENDATION_TYPES = [
  'recommend',
  'conditional',
  'insufficient_evidence',
] as const;

export const ATS_BOARD_EVIDENCE_CORROBORATION = [
  'one source',
  'multiple sources',
  'charter only',
] as const;

const evidenceRegisterEntrySchema = z.object({
  id: z.string().min(1),
  claim: z.string().min(1),
  source: z.string().min(1),
  date: z.string().optional(),
  corroboration: z.enum(ATS_BOARD_EVIDENCE_CORROBORATION),
});

const CORROBORATION_ALIASES: Record<string, (typeof ATS_BOARD_EVIDENCE_CORROBORATION)[number]> =
  {
    'one source': 'one source',
    'multiple sources': 'multiple sources',
    'charter only': 'charter only',
    'charter': 'charter only',
    single: 'one source',
  };

function normalizeCorroborationLabel(
  value: string,
): (typeof ATS_BOARD_EVIDENCE_CORROBORATION)[number] | null {
  const trimmed = value.trim();
  const canonical = CORROBORATION_ALIASES[trimmed.toLowerCase()];
  if (canonical) return canonical;
  if (
    (ATS_BOARD_EVIDENCE_CORROBORATION as readonly string[]).includes(trimmed)
  ) {
    return trimmed as (typeof ATS_BOARD_EVIDENCE_CORROBORATION)[number];
  }
  return null;
}

/**
 * Models often put URLs or CFR citations in `corroboration` instead of `source`. Move them before
 * v3 validation so deliberation can start without discarding otherwise good specialist work.
 */
const STRING_LIST_FIELDS = [
  'missingInputs',
  'dependencies',
  'outOfScope',
  'assumptions',
  'risks',
] as const;

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const row = item as Record<string, unknown>;
        for (const key of ['text', 'description', 'risk', 'assumption', 'note']) {
          if (typeof row[key] === 'string') return String(row[key]).trim();
        }
        return JSON.stringify(row);
      }
      return String(item).trim();
    })
    .filter((item) => item.length > 0);
}

function normalizeChecklistStatus(
  value: string,
): (typeof ATS_BOARD_CHECKLIST_STATUSES)[number] {
  const trimmed = value.trim();
  const alias = CHECKLIST_STATUS_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  if ((ATS_BOARD_CHECKLIST_STATUSES as readonly string[]).includes(trimmed)) {
    return trimmed as (typeof ATS_BOARD_CHECKLIST_STATUSES)[number];
  }
  return 'partial';
}

export function normalizeAtsBoardMemberReportPayload(
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  let next = { ...parsed };
  for (const field of STRING_LIST_FIELDS) {
    if (field in next) {
      const normalized = normalizeStringList(next[field]);
      if (normalized) next = { ...next, [field]: normalized };
    }
  }
  const checklist = next.checklist;
  if (Array.isArray(checklist)) {
    next = {
      ...next,
      checklist: checklist.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return entry;
        }
        const row = { ...(entry as Record<string, unknown>) };
        if (typeof row.status === 'string') {
          row.status = normalizeChecklistStatus(row.status);
        }
        return row;
      }),
    };
  }

  const register = next.evidenceRegister;
  if (!Array.isArray(register)) return next;

  const evidenceRegister = register.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const row = { ...(entry as Record<string, unknown>) };
    const corroboration =
      typeof row.corroboration === 'string' ? row.corroboration : '';
    const source = typeof row.source === 'string' ? row.source.trim() : '';
    const canonical = normalizeCorroborationLabel(corroboration);
    if (canonical) {
      row.corroboration = canonical;
      if (!source && typeof row.claim === 'string') {
        row.source = row.claim.slice(0, 240);
      }
      return row;
    }
    const misplaced = corroboration.trim();
    if (misplaced) {
      if (!source) row.source = misplaced;
      row.corroboration = 'one source';
      return row;
    }
    row.corroboration = 'one source';
    if (!source && typeof row.claim === 'string') {
      row.source = row.claim.slice(0, 240);
    }
    return row;
  });

  return { ...next, evidenceRegister };
}

const ATS_BOARD_CHECKLIST_STATUSES = [
  'met',
  'partial',
  'blocked',
  'not_applicable',
] as const;

const checklistEntrySchema = z.object({
  id: z.string().min(1),
  status: z.enum(ATS_BOARD_CHECKLIST_STATUSES),
  note: z.string().optional(),
});

const CHECKLIST_STATUS_ALIASES: Record<
  string,
  (typeof ATS_BOARD_CHECKLIST_STATUSES)[number]
> = {
  met: 'met',
  partial: 'partial',
  blocked: 'blocked',
  'not_applicable': 'not_applicable',
  'not applicable': 'not_applicable',
  n_a: 'not_applicable',
  na: 'not_applicable',
  recommend: 'met',
  approved: 'met',
  complete: 'met',
  completed: 'met',
  yes: 'met',
  incomplete: 'partial',
  in_progress: 'partial',
  'in progress': 'partial',
  block: 'blocked',
};

export const atsBoardMemberReportV3Schema = z.object({
  role: z.enum([
    'operations',
    'recruiting',
    'client',
    'compliance',
    'data',
    'product',
    'market',
  ]),
  recommendationType: z.enum(ATS_BOARD_MEMBER_RECOMMENDATION_TYPES),
  recommendation: z.string(),
  benefit: z.string().optional(),
  measurableOutcome: z.string().optional(),
  checklist: z.array(checklistEntrySchema).optional(),
  evidenceRegister: z.array(evidenceRegisterEntrySchema).optional(),
  missingInputs: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).optional(),
  outOfScope: z.array(z.string()).optional(),
  assumptions: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1),
  dissent: z.string().optional(),
  humanDecisionRequired: z.boolean().optional(),
  status: z.string().optional(),
});

export type AtsBoardMemberReportV3 = z.infer<typeof atsBoardMemberReportV3Schema>;

/** Role-specific checklist ids specialists must score in v3 opening reports. */
export const ATS_BOARD_ROLE_CHECKLIST_IDS: Readonly<Record<string, readonly string[]>> = {
  operations: [
    'ownership-handoffs',
    'exceptions-slAs',
    'placement-lifecycle',
    'cost-drivers',
  ],
  recruiting: [
    'sourcing',
    'screening',
    'credentialing',
    'submission',
    'redeployment',
  ],
  client: [
    'intake',
    'approvals',
    'visibility',
    'communication',
    'account-controls',
    'adoption',
  ],
  compliance: [
    'payroll',
    'tax',
    'invoicing',
    'privacy',
    'regulatory-authority',
  ],
  data: [
    'day1-data',
    'integrations',
    'security',
    'migration',
    'separation',
    'delivery-feasibility',
  ],
  product: [
    'personas',
    'complete-workflow',
    'failure-paths',
    'accessibility',
    'adoption',
  ],
  market: [
    'primary-vendor-evidence',
    'differentiation',
    'economics',
    'comparable-patterns',
  ],
};

function parseMemberJson(report: string): Record<string, unknown> | null {
  try {
    const fenced = report.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const source = (fenced?.[1] ?? report).trim();
    const parsed = JSON.parse(source) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * When a v3 opening report includes `recommendationType`, validate the richer contract.
 * Legacy reports without that field remain accepted for pinned runs.
 */
export function validateAtsBoardMemberReport(
  role: string,
  report: string,
): void {
  const parsed = parseMemberJson(report);
  if (!parsed) return;
  if (!('recommendationType' in parsed)) return;

  const normalized = normalizeAtsBoardMemberReportPayload(parsed);
  const result = atsBoardMemberReportV3Schema.safeParse(normalized);
  if (!result.success) {
    throw new Error(
      `ATS board ${role} report failed v3 validation: ${result.error.issues[0]?.message ?? 'invalid shape'}.`,
    );
  }
  if (result.data.role !== role) {
    throw new Error(
      `ATS board ${role} step returned role "${result.data.role}"; expected "${role}".`,
    );
  }

  const requiredIds = ATS_BOARD_ROLE_CHECKLIST_IDS[role] ?? [];
  const checklist = result.data.checklist ?? [];
  const covered = new Set(checklist.map((item) => item.id));
  const missing = requiredIds.filter((id) => !covered.has(id));
  if (missing.length > 0) {
    throw new Error(
      `ATS board ${role} report is missing checklist items: ${missing.join(', ')}.`,
    );
  }

  if (result.data.recommendationType === 'insufficient_evidence') {
    if (!result.data.missingInputs?.length) {
      throw new Error(
        `ATS board ${role} insufficient_evidence report must list missingInputs.`,
      );
    }
  }

  const register = result.data.evidenceRegister ?? [];
  const ids = new Set<string>();
  for (const entry of register) {
    if (ids.has(entry.id)) {
      throw new Error(
        `ATS board ${role} evidence register has duplicate id "${entry.id}".`,
      );
    }
    ids.add(entry.id);
  }
}

export function assertAtsBoardMemberReports(
  reports: Record<string, string>,
): void {
  for (const role of ATS_BOARD_MEMBER_ROLES) {
    const report = reports[role];
    if (!report?.trim()) continue;
    validateAtsBoardMemberReport(role, report);
  }
}
