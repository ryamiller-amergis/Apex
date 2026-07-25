/**
 * VT-01 / TBI-006 DoD-2 / PBI-007 AC-0 — guided → k6 compile
 * VT-09 / BR-004 — client caps (schema)
 * VT-10 / BR-006 — plaintext secret rejection (schema)
 * TBI-006 DoD-3 — regenerate confirm helper
 */
import {
  compileGuidedFormToK6,
  needsConfirmBeforeRegenerate,
} from '../loadTestScriptCompile';
import {
  loadTestBuilderFormSchema,
  looksLikePlaintextSecret,
} from '../loadTestBuilderSchema';

describe('compileGuidedFormToK6 (VT-01, TBI-006 DoD-2, PBI-007 AC-0)', () => {
  it('compiles multi-step flow with JSONPath extraction into sequential requests', () => {
    const result = compileGuidedFormToK6({
      flowType: 'multi_step',
      steps: [
        {
          method: 'POST',
          path: '/api/login',
          body: '{"user":"synthetic"}',
          extractions: [{ name: 'token', source: 'json_path', expression: '$.accessToken' }],
          tag: 'login',
        },
        {
          method: 'GET',
          path: '/api/orders',
          tag: 'list_orders',
        },
      ],
      loadProfile: { vus: 25, durationMinutes: 10, rpsCap: 100 },
      clientThresholds: [
        { metric: 'http_req_duration', expression: 'p(95)<800' },
        { metric: 'http_req_failed', expression: 'rate<0.02' },
      ],
    });

    expect(result.script).toContain("http.post(`${__ENV.TARGET_URL}/api/login`");
    expect(result.script).toContain("http.get(`${__ENV.TARGET_URL}/api/orders`");
    expect(result.script).toContain("vars['token']");
    expect(result.script).toContain("json('$.accessToken')");
    expect(result.script).toContain("tags: { name: 'login' }");
    expect(result.script).toContain("tags: { name: 'list_orders' }");
    expect(result.script).toContain("'http_req_duration': ['p(95)<800']");
    expect(result.loadProfile).toEqual({ vus: 25, durationMinutes: 10, rpsCap: 100 });
    expect(result.clientThresholds).toHaveLength(2);
    expect(result.flowSteps).toHaveLength(2);
  });

  it('rejects empty steps', () => {
    expect(() =>
      compileGuidedFormToK6({
        flowType: 'single',
        steps: [],
        loadProfile: { vus: 1, durationMinutes: 1 },
        clientThresholds: [{ metric: 'http_req_failed', expression: 'rate<0.01' }],
      }),
    ).toThrow(/at least one step/i);
  });
});

describe('needsConfirmBeforeRegenerate (TBI-006 DoD-3, BR-010)', () => {
  it('requires confirm when script_source is raw', () => {
    expect(needsConfirmBeforeRegenerate('raw')).toBe(true);
  });

  it('does not require confirm for form_builder or ai_generated', () => {
    expect(needsConfirmBeforeRegenerate('form_builder')).toBe(false);
    expect(needsConfirmBeforeRegenerate('ai_generated')).toBe(false);
  });
});

describe('loadTestBuilderFormSchema (VT-09, VT-10)', () => {
  const validBase = {
    name: 'Checkout load',
    requirementId: '12345',
    targetId: 'target-1',
    flowType: 'single' as const,
    steps: [{ method: 'GET', path: '/health' }],
    loadProfile: { vus: 10, durationMinutes: 5 },
    clientThresholds: [{ metric: 'http_req_duration', expression: 'p(95)<500' }],
    mode: 'guided' as const,
  };

  it('VT-09: rejects VUs above platform cap', () => {
    const result = loadTestBuilderFormSchema.safeParse({
      ...validBase,
      loadProfile: { vus: 5001, durationMinutes: 5 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('vus'))).toBe(true);
    }
  });

  it('VT-10: rejects plaintext bearer token in secret ref', () => {
    expect(looksLikePlaintextSecret('Bearer sk-test-plaintext')).toBe(true);
    const result = loadTestBuilderFormSchema.safeParse({
      ...validBase,
      secretRefKey: 'auth',
      secretRefValue: 'Bearer sk-test-plaintext',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) =>
          String(i.message).toLowerCase().includes('key vault'),
        ),
      ).toBe(true);
    }
  });

  it('accepts Key Vault style secret refs', () => {
    const result = loadTestBuilderFormSchema.safeParse({
      ...validBase,
      secretRefKey: 'authHeader',
      secretRefValue: 'kv://my-vault/load-test-token',
    });
    expect(result.success).toBe(true);
  });
});
