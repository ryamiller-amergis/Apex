import {
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
  };

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
