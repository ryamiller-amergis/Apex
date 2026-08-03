import {
  NATIVE_READ_DENIAL_CATEGORIES,
  NATIVE_READ_TELEMETRY_EVENT_NAMES,
  type GroundingAgentRecreateEventProperties,
  type GroundingBindingWriteEventProperties,
  type NativeReadCapabilityResult,
  type NativeReadCapabilitySelfCheckEventProperties,
  type NativeReadDeniedEventProperties,
  type NativeReadEngagedEventProperties,
  type NativeReadFlagEvaluatedEventProperties,
} from '../../shared/types/groundingOperations';

describe('TBI-005 DoD-3 / VT-07 native-read shared contracts', () => {
  it('exports the exact event names and complete denial vocabulary', () => {
    expect(NATIVE_READ_TELEMETRY_EVENT_NAMES).toEqual({
      flagEvaluated: 'native-read.flag.evaluated',
      capabilitySelfCheck: 'native-read.capability.self-check',
      bindingWrite: 'grounding.binding.write',
      agentRecreate: 'grounding.agent.recreate',
      denied: 'native-read.denied',
      engaged: 'native-read.engaged',
    });
    expect(NATIVE_READ_DENIAL_CATEGORIES).toEqual([
      'shell',
      'write',
      'edit',
      'delete',
      'subagent',
      'unknown-tool',
      'traversal',
      'symlink',
      'host-absolute',
      'indirect-process',
      'out-of-root',
      'unapproved-egress',
      'policy-override',
    ]);
  });

  it('exports capability and content-free event property shapes', () => {
    const capability = {
      proven: false,
      reason: 'harness-not-run',
    } satisfies NativeReadCapabilityResult;
    const flagEvaluation = {
      caller: 'interview',
      project: 'Apex',
      flag: 'native-read',
      outcome: 'disabled',
      reason: 'default-off',
    } satisfies NativeReadFlagEvaluatedEventProperties;
    const selfCheck = {
      caller: 'interview',
      project: 'Apex',
      outcome: 'not-proven',
      selfCheckReason: 'harness-not-run',
    } satisfies NativeReadCapabilitySelfCheckEventProperties;
    const bindingWrite = {
      caller: 'interview',
      project: 'Apex',
      mode: 'remote',
      outcome: 'success',
    } satisfies GroundingBindingWriteEventProperties;
    const recreation = {
      caller: 'interview',
      project: 'Apex',
      recreateReason: 'grounding-mode-changed',
    } satisfies GroundingAgentRecreateEventProperties;
    const denial = {
      caller: 'interview',
      project: 'Apex',
      denialCategory: 'policy-override',
    } satisfies NativeReadDeniedEventProperties;
    const engagement = {
      caller: 'interview',
      project: 'Apex',
    } satisfies NativeReadEngagedEventProperties;

    expect({
      capability,
      flagEvaluation,
      selfCheck,
      bindingWrite,
      recreation,
      denial,
      engagement,
    }).toBeDefined();
  });
});
