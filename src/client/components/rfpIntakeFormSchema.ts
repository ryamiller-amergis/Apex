import { z } from 'zod';
import {
  RFP_AUDIENCES,
  RFP_DATA_SENSITIVITIES,
  RFP_REQUEST_TYPES,
  type CreateRfpRequestDTO,
  type RfpAudience,
  type RfpDataSensitivity,
  type RfpRequestType,
} from '../../shared/types/rfpIntake';

const optionalText = z.string().optional();

export const rfpIntakeFormSchema = z
  .object({
    title: z.string().trim().min(1, 'title is required'),
    stakeholder: z.string().trim().min(1, 'stakeholder is required'),
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
  })
  .superRefine((values, ctx) => {
    if (values.requestType === 'change-existing') {
      if (!values.existingSystemStack?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['existingSystemStack'],
          message: 'existingSystemStack is required for change-existing requests',
        });
      }
    }
  });

export type RfpIntakeFormValues = z.infer<typeof rfpIntakeFormSchema>;

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
  };
}
