import {
  rfpClarificationFormSchema,
  rfpIntakeFormSchema,
  toRfpIntakePayload,
  type RfpIntakeFormValues,
} from '../rfpIntakeFormSchema';
import { RFP_ATTACHMENT_MAX_BYTES, validateRfpAttachments } from '../../../shared/types/rfpIntake';

describe('rfpIntakeFormSchema VT-03 PBI-003 AC-2/AC-3', () => {
  const required: RfpIntakeFormValues = {
    title: 'Tracker',
    stakeholder: 'BA',
    request: 'Need intake',
    problem: 'Fragmented',
    audience: 'internal',
    dataSensitivity: 'internal-only',
    existingSolution: 'none',
    advantage: '',
    constraints: '',
    requestType: '',
    existingSystemStack: '',
    expectedUsers: 'small',
    aiInApp: 'no',
  };

  it('FF-0 FF-1 requires expected users and AI intent', () => {
    const result = rfpIntakeFormSchema.safeParse({ ...required, expectedUsers: '', aiInApp: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.flatten().fieldErrors;
      expect(fields.expectedUsers?.[0]).toBe('Expected users is required');
      expect(fields.aiInApp?.[0]).toBe('AI in the application is required');
    }
  });

  it('FF-5 clarification accepts older requests that never answered scale or AI', () => {
    const result = rfpClarificationFormSchema.safeParse({ ...required, expectedUsers: '', aiInApp: '' });
    expect(result.success).toBe(true);
  });

  it('FF-0 FF-1 maps the new answers into the payload', () => {
    const payload = toRfpIntakePayload({ ...required, expectedUsers: 'large', aiInApp: 'not-sure' });
    expect(payload.expectedUsers).toBe('large');
    expect(payload.aiInApp).toBe('not-sure');
  });

  it('FF-2 labels the stakeholder error as sponsoring team', () => {
    const result = rfpIntakeFormSchema.safeParse({ ...required, stakeholder: ' ' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.stakeholder?.[0]).toBe('Sponsoring team is required');
    }
  });

  it('VT-03 AC-2 requires existingSystemStack only for change-existing', () => {
    const missing = rfpIntakeFormSchema.safeParse({
      ...required,
      requestType: 'change-existing',
      existingSystemStack: '',
    });
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(missing.error.flatten().fieldErrors.existingSystemStack?.[0]).toMatch(/required/);
    }

    const present = rfpIntakeFormSchema.safeParse({
      ...required,
      requestType: 'change-existing',
      existingSystemStack: 'Salesforce + Apex',
    });
    expect(present.success).toBe(true);
  });

  it('VT-03 AC-2 excludes existingSystemStack when request type is not change-existing', () => {
    const payload = toRfpIntakePayload({
      ...required,
      requestType: 'new-app',
      existingSystemStack: 'should-not-ship',
    });
    expect(payload.existingSystemStack).toBeNull();
    expect(payload.requestType).toBe('new-app');
  });

  it('VT-04 AC-3 blocks blank required fields', () => {
    const result = rfpIntakeFormSchema.safeParse({ ...required, title: '  ' });
    expect(result.success).toBe(false);
  });

  it('VT-04 AC-3 blocks invalid enum values', () => {
    const result = rfpIntakeFormSchema.safeParse({ ...required, dataSensitivity: 'top-secret' });
    expect(result.success).toBe(false);
  });

  it('VT-04 AC-3 blocks oversized attachments via shared validator', () => {
    const errors = validateRfpAttachments([
      { filename: 'huge.pdf', contentType: 'application/pdf', sizeBytes: RFP_ATTACHMENT_MAX_BYTES + 1 },
    ]);
    expect(errors[0]).toMatch(/exceeds 10 MB/);
  });
});
