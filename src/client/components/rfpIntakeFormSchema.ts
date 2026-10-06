import { z } from 'zod';
import {
  RFP_AI_INTENTS,
  RFP_AUDIENCES,
  RFP_DATA_SENSITIVITIES,
  RFP_EXPECTED_USER_SCALES,
  RFP_REQUEST_TYPES,
  type CreateRfpRequestDTO,
  type RfpAiIntent,
  type RfpAudience,
  type RfpDataSensitivity,
  type RfpExpectedUserScale,
  type RfpRequestType,
} from '../../shared/types/rfpIntake';

const optionalText = z.string().optional();

const intakeFields = z
  .object({
    title: z.string().trim().min(1, 'title is required'),
    stakeholder: z.string().trim().min(1, 'Sponsoring team is required'),
    request: z.string().trim().min(1, 'request is required'),
    problem: z.string().trim().min(1, 'problem is required'),
    audience: z.enum(RFP_AUDIENCES as unknown as [RfpAudience, ...RfpAudience[]]),
    dataSensitivity: z.enum(RFP_DATA_SENSITIVITIES as unknown as [RfpDataSensitivity, ...RfpDataSensitivity[]]),
    existingSolution: z.string().trim().min(1, 'existingSolution is required'),
    advantage: optionalText,
    constraints: optionalText,
    requestType: z.union([
      z.enum(RFP_REQUEST_TYPES as unknown as [RfpRequestType, ...RfpRequestType[]]),
      z.literal(''),
    ]).optional(),
    existingSystemStack: optionalText,
    expectedUsers: z.union([
      z.enum(RFP_EXPECTED_USER_SCALES as unknown as [RfpExpectedUserScale, ...RfpExpectedUserScale[]]),
      z.literal(''),
    ]),
    aiInApp: z.union([
      z.enum(RFP_AI_INTENTS as unknown as [RfpAiIntent, ...RfpAiIntent[]]),
      z.literal(''),
    ]),
  });

function requireExistingStack(values: z.infer<typeof intakeFields>, ctx: z.RefinementCtx) {
  if (values.requestType === 'change-existing' && !values.existingSystemStack?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['existingSystemStack'],
      message: 'existingSystemStack is required for change-existing requests',
    });
  }
}

/** Clarification keeps whatever scale/AI answers the request already has; older rows have none. */
export const rfpClarificationFormSchema = intakeFields.superRefine(requireExistingStack);

export const rfpIntakeFormSchema = intakeFields
  .superRefine((values, ctx) => {
    requireExistingStack(values, ctx);
    if (!values.expectedUsers) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expectedUsers'], message: 'Expected users is required' });
    }
    if (!values.aiInApp) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['aiInApp'], message: 'AI in the application is required' });
    }
  });

export type RfpIntakeFormValues = z.infer<typeof rfpIntakeFormSchema>;

/** Long free-text fields that offer talk-to-text. */
export const RFP_DICTATION_FIELDS = ['request', 'problem', 'existingSolution', 'advantage', 'constraints'] as const;
export type RfpDictationField = (typeof RFP_DICTATION_FIELDS)[number];

export const RFP_INTAKE_FORM_DEFAULTS: RfpIntakeFormValues = {
  title: '',
  stakeholder: '',
  request: '',
  problem: '',
  audience: 'internal',
  dataSensitivity: 'none',
  existingSolution: '',
  advantage: '',
  constraints: '',
  requestType: '',
  existingSystemStack: '',
  expectedUsers: '',
  aiInApp: '',
};

export function toRfpIntakePayload(values: RfpIntakeFormValues): CreateRfpRequestDTO {
  const requestType = values.requestType ? values.requestType : null;
  return {
    title: values.title.trim(),
    stakeholder: values.stakeholder.trim(),
    request: values.request.trim(),
    problem: values.problem.trim(),
    audience: values.audience,
    dataSensitivity: values.dataSensitivity,
    existingSolution: values.existingSolution.trim(),
    advantage: values.advantage?.trim() || null,
    constraints: values.constraints?.trim() || null,
    requestType,
    existingSystemStack:
      requestType === 'change-existing' ? (values.existingSystemStack?.trim() || null) : null,
    expectedUsers: values.expectedUsers || null,
    aiInApp: values.aiInApp || null,
  };
}
