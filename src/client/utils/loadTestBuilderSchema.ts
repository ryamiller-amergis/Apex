import { z } from 'zod';

/** Platform defaults mirrored from loadTestService.LOAD_TEST_CAPS (client advisory). */
export const LOAD_TEST_CLIENT_CAPS = {
  maxVus: 5_000,
  maxDurationMinutes: 60,
  maxRpsCap: 10_000,
} as const;

const PLAINTEXT_SECRET_PATTERNS = [
  /bearer\s+[a-zA-Z0-9\-._~+/]+=*/i,
  /^[Aa]uthorization:\s*\S/m,
  /api[_-]?key\s*[:=]\s*\S/i,
  /password\s*[:=]\s*\S/i,
  /secret\s*[:=]\s*(?!kv:|vault:)\S/i,
];

export function looksLikePlaintextSecret(value: string): boolean {
  return PLAINTEXT_SECRET_PATTERNS.some((p) => p.test(value));
}

const secretRefValueSchema = z
  .string()
  .trim()
  .min(1, 'Secret reference is required')
  .refine((v) => !looksLikePlaintextSecret(v), {
    message: 'Use a Key Vault reference identifier (e.g. kv://vault/secret), not a plaintext token',
  });

const extractionSchema = z.object({
  name: z.string().trim().min(1, 'Variable name is required'),
  source: z.enum(['json_path', 'regex']),
  expression: z.string().trim().min(1, 'Expression is required'),
});

const stepSchema = z.object({
  method: z.string().trim().min(1, 'Method is required'),
  path: z.string().trim().min(1, 'Path is required'),
  headersText: z.string().optional(),
  body: z.string().optional(),
  tag: z.string().optional(),
  extractions: z.array(extractionSchema).optional(),
});

const thresholdSchema = z.object({
  metric: z.string().trim().min(1, 'Metric is required'),
  expression: z.string().trim().min(1, 'Expression is required'),
});

const loadProfileSchema = z.object({
  vus: z
    .number({ message: 'VUs must be a number' })
    .int('VUs must be an integer')
    .positive('VUs must be positive')
    .max(LOAD_TEST_CLIENT_CAPS.maxVus, `VUs cannot exceed ${LOAD_TEST_CLIENT_CAPS.maxVus}`),
  durationMinutes: z
    .number({ message: 'Duration must be a number' })
    .positive('Duration must be positive')
    .max(
      LOAD_TEST_CLIENT_CAPS.maxDurationMinutes,
      `Duration cannot exceed ${LOAD_TEST_CLIENT_CAPS.maxDurationMinutes} minutes`,
    ),
  rpsCap: z
    .number()
    .positive()
    .max(LOAD_TEST_CLIENT_CAPS.maxRpsCap, `RPS cannot exceed ${LOAD_TEST_CLIENT_CAPS.maxRpsCap}`)
    .optional(),
});

export const loadTestBuilderFormSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required'),
    description: z.string().optional(),
    requirementId: z.string().trim().min(1, 'Requirement is required'),
    requirementLabel: z.string().optional(),
    targetId: z.string().trim().min(1, 'Allowlisted target is required'),
    flowType: z.enum(['single', 'multi_step']),
    steps: z.array(stepSchema).min(1, 'Add at least one step'),
    loadProfile: loadProfileSchema,
    clientThresholds: z.array(thresholdSchema).min(1, 'Add at least one threshold'),
    secretRefKey: z.string().optional(),
    secretRefValue: z.string().optional(),
    script: z.string().optional(),
    mode: z.enum(['guided', 'raw', 'ai']),
  })
  .superRefine((values, ctx) => {
    if (values.mode === 'raw' && !values.script?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Raw k6 script is required',
        path: ['script'],
      });
    }
    if (values.secretRefValue?.trim()) {
      const result = secretRefValueSchema.safeParse(values.secretRefValue);
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: result.error.issues[0]?.message ?? 'Invalid secret reference',
          path: ['secretRefValue'],
        });
      }
    }
    if (values.secretRefKey?.trim() && looksLikePlaintextSecret(values.secretRefKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Secret key must be an identifier, not a credential',
        path: ['secretRefKey'],
      });
    }
  });

export type LoadTestBuilderFormValues = z.infer<typeof loadTestBuilderFormSchema>;

export const defaultLoadTestBuilderValues: LoadTestBuilderFormValues = {
  name: '',
  description: '',
  requirementId: '',
  requirementLabel: '',
  targetId: '',
  flowType: 'single',
  steps: [{ method: 'GET', path: '/health', extractions: [] }],
  loadProfile: { vus: 10, durationMinutes: 5 },
  clientThresholds: [
    { metric: 'http_req_duration', expression: 'p(95)<500' },
    { metric: 'http_req_failed', expression: 'rate<0.01' },
  ],
  secretRefKey: '',
  secretRefValue: '',
  script: '',
  mode: 'guided',
};
