/**
 * The step-type registry contract.
 *
 * TBI-016 (Phase 0) owns the first four groups: VT-01 (a suspendable type with no deadline is
 * rejected), VT-02 (the three production types register with their deadlines), the Skill allow-list
 * and VT-04 (the registry is the only declaration site). VT-03 — that a malformed descriptor fails
 * at *startup* rather than first use — needs a booting app, so it lives in the integration suite.
 *
 * TBI-032 and TBI-033 (FEAT-008) own the groups after those: every step type declares Zod input and
 * output schemas and a non-empty `requiredPermissions` list, `none` is gone from the side-effect
 * vocabulary, and a step type nobody edited the registry to add still registers.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { PLAYBOOK_STEP_SIDE_EFFECTS } from '../../shared/types/playbook';
import type {
  PlaybookGuardViolationKind,
  PlaybookStepTypeDescriptor,
} from '../../shared/types/playbook';
import {
  APPROVAL_GATE_DEADLINE_MS,
  CURSOR_AGENT_DEADLINE_MS,
  PHASE_0_ALLOWED_AGENT_SKILLS,
  PRODUCTION_STEP_TYPES,
  PlaybookStepTypeError,
  UnknownPlaybookStepTypeError,
  assertSkillAllowed,
  createStepTypeRegistry,
  getStepTypeDescriptor,
  isRegisteredStepType,
  listStepTypeDescriptors,
  requiresInitiatorPermissionRecheck,
  resolveDeadlineMs,
  sideEffectOfStepType,
  validateStepTypeDescriptor,
  validateStepTypeRegistry,
} from '../services/playbookSteps/registry';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_SOURCE = path.join(REPO_ROOT, 'src/server/services/playbookSteps/registry.ts');

/**
 * A descriptor that satisfies the whole contract, so each test can break exactly one rule.
 *
 * Overrides are loosely typed and the result is cast, because most of these tests are about what
 * the runtime check catches when the compiler's version of the rule has already been escaped.
 */
function descriptor(overrides: Record<string, unknown> = {}): PlaybookStepTypeDescriptor {
  return {
    stepType: 'fake-step',
    canSuspend: false,
    isAgentStep: false,
    sideEffect: 'read',
    requiredPermissions: ['playbooks:view'],
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    ...overrides,
  } as unknown as PlaybookStepTypeDescriptor;
}

/*
 * The descriptor union makes this combination fail to compile, which is the point: the type stops a
 * literal, and this asserts the runtime check that catches everything else.
 */
const SUSPENDS_WITHOUT_DEADLINE = descriptor({
  stepType: 'forgot-the-deadline',
  canSuspend: true,
});

describe('TBI-016 VT-01 — a suspendable step type must declare a deadline', () => {
  it('refuses to build a registry containing one', () => {
    expect(() => createStepTypeRegistry([SUSPENDS_WITHOUT_DEADLINE])).toThrow(
      PlaybookStepTypeError
    );
  });

  it('says why, naming the step type and the consequence', () => {
    expect(() => validateStepTypeDescriptor(SUSPENDS_WITHOUT_DEADLINE)).toThrow(
      /forgot-the-deadline.*defaultDeadlineMs/s
    );
    // The reason matters more than the rule: a reader needs to know what breaks, not just that
    // something is disallowed.
    expect(() => validateStepTypeDescriptor(SUSPENDS_WITHOUT_DEADLINE)).toThrow(/waits forever/);
  });

  it('refuses a deadline that could never expire', () => {
    for (const defaultDeadlineMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const bad = descriptor({
        stepType: 'bad-deadline',
        canSuspend: true,
        defaultDeadlineMs,
        deadlineOverridable: false,
      });
      expect(() => validateStepTypeDescriptor(bad)).toThrow(PlaybookStepTypeError);
    }
  });

  it('accepts a non-suspending type with no deadline', () => {
    expect(() =>
      validateStepTypeDescriptor(descriptor({ stepType: 'fire-and-forget' }))
    ).not.toThrow();
  });

  it('refuses a deadline on a type that cannot suspend', () => {
    expect(() =>
      validateStepTypeDescriptor(
        descriptor({ stepType: 'pointless-deadline', defaultDeadlineMs: 1000 })
      )
    ).toThrow(/would never be read/);
  });

  it('refuses two descriptors for one step type', () => {
    const twice = [descriptor({ stepType: 'notify' }), descriptor({ stepType: 'notify' })];

    expect(() => createStepTypeRegistry(twice)).toThrow(/declared twice/);
  });
});

describe('TBI-016 VT-02 — the three production step types', () => {
  it('registers exactly cursor-agent, approval-gate and notify', () => {
    expect(listStepTypeDescriptors().map((d) => d.stepType).sort()).toEqual([
      'approval-gate',
      'cursor-agent',
      'notify',
    ]);
  });

  it('gives cursor-agent a 60-minute deadline that a definition cannot override', () => {
    const cursorAgent = getStepTypeDescriptor('cursor-agent');

    expect(cursorAgent.canSuspend).toBe(true);
    expect(CURSOR_AGENT_DEADLINE_MS).toBe(60 * 60 * 1000);
    expect(cursorAgent.defaultDeadlineMs).toBe(CURSOR_AGENT_DEADLINE_MS);
    expect(resolveDeadlineMs('cursor-agent')).toBe(CURSOR_AGENT_DEADLINE_MS);
    expect(() => resolveDeadlineMs('cursor-agent', 5000)).toThrow(/does not allow/);
  });

  it('gives approval-gate a 48-hour deadline a definition may override', () => {
    const approvalGate = getStepTypeDescriptor('approval-gate');

    expect(approvalGate.canSuspend).toBe(true);
    expect(APPROVAL_GATE_DEADLINE_MS).toBe(48 * 60 * 60 * 1000);
    expect(resolveDeadlineMs('approval-gate')).toBe(APPROVAL_GATE_DEADLINE_MS);
    expect(resolveDeadlineMs('approval-gate', 90 * 60 * 1000)).toBe(90 * 60 * 1000);
    expect(() => resolveDeadlineMs('approval-gate', 0)).toThrow(/positive number/);
  });

  it('gives notify no deadline, because it never waits', () => {
    const notify = getStepTypeDescriptor('notify');

    expect(notify.canSuspend).toBe(false);
    expect(notify.defaultDeadlineMs).toBeUndefined();
    expect(() => resolveDeadlineMs('notify')).toThrow(/cannot suspend/);
  });

  it('refuses an unknown step type rather than returning undefined', () => {
    expect(isRegisteredStepType('teleport')).toBe(false);
    expect(() => getStepTypeDescriptor('teleport')).toThrow(UnknownPlaybookStepTypeError);
    // The error lists what does exist, so a typo is self-diagnosing.
    expect(() => getStepTypeDescriptor('teleport')).toThrow(/cursor-agent/);
  });

  it('passes the startup validation it will be given at boot', () => {
    expect(() => validateStepTypeRegistry()).not.toThrow();
  });
});

describe('the Skill allow-list', () => {
  it('permits a Skill on the list and refuses everything else', () => {
    expect(() =>
      assertSkillAllowed('cursor-agent', PHASE_0_ALLOWED_AGENT_SKILLS[0])
    ).not.toThrow();

    expect(() => assertSkillAllowed('cursor-agent', '.cursor/skills/build-test-push/SKILL.md')).toThrow(
      /may not run Skill/
    );
  });

  it('default-denies: a step type naming no Skills permits none', () => {
    expect(() => assertSkillAllowed('notify', '.cursor/skills/app-knowledge/SKILL.md')).toThrow(
      /no Skills/
    );
  });

  it('names a Skill that actually exists in the repo', () => {
    // An allow-list entry with a typo would default-deny everything at demo time, which is the
    // worst moment to discover it.
    for (const skillPath of PHASE_0_ALLOWED_AGENT_SKILLS) {
      expect(fs.existsSync(path.resolve(REPO_ROOT, skillPath))).toBe(true);
    }
  });
});

describe('TBI-016 VT-04 — the registry is the only place a step type is declared', () => {
  const STEP_TYPE_NAMES = ['cursor-agent', 'approval-gate', 'notify'];
  const OWNING_DIR = 'src/server/services/playbookSteps';

  function sourceFilesUnder(relativeDir: string): string[] {
    const absolute = path.join(REPO_ROOT, relativeDir);
    if (!fs.existsSync(absolute)) return [];

    return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
      const child = path.join(relativeDir, entry.name).replace(/\\/g, '/');
      if (entry.isDirectory()) return sourceFilesUnder(child);
      return /\.tsx?$/.test(entry.name) ? [child] : [];
    });
  }

  /** Comments are stripped so that prose naming a step type is not mistaken for logic about one. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  it('finds no step-type literal in code outside playbookSteps/ and its tests', () => {
    const offenders = ['src/client', 'src/server', 'src/shared']
      .flatMap(sourceFilesUnder)
      .filter(
        (file) =>
          !file.startsWith(`${OWNING_DIR}/`) &&
          !file.includes('__tests__') &&
          file !== 'src/server/routes/e2eSetup.ts'
      )
      .filter((file) => {
        const code = stripComments(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
        return STEP_TYPE_NAMES.some((name) => code.includes(`'${name}'`));
      });

    expect(offenders).toEqual([]);
  });

  it('keeps the descriptors themselves in one array', () => {
    // Registered types and declared descriptors must be the same set; a type appearing in the map
    // but not in this array would mean a second registration path had grown.
    expect(PRODUCTION_STEP_TYPES.map((d) => d.stepType).sort()).toEqual(
      listStepTypeDescriptors().map((d) => d.stepType).sort()
    );
  });
});

describe('FEAT-008 VT-01 (TBI-032 a, d) — every step type declares inspectable Zod schemas', () => {
  it('gives all three production types an input and an output schema', () => {
    for (const d of listStepTypeDescriptors()) {
      expect(d.inputSchema).toBeInstanceOf(z.ZodType);
      expect(d.outputSchema).toBeInstanceOf(z.ZodType);
    }
  });

  it('retrieves both schemas by step-type key', () => {
    const cursorAgent = getStepTypeDescriptor('cursor-agent');

    expect(cursorAgent.inputSchema.safeParse({ skillPath: 'a', prompt: 'b' }).success).toBe(true);
    expect(
      cursorAgent.outputSchema.safeParse({
        agentRunId: 'run-1',
        completedAt: '2026-09-22T10:00:00.000Z',
      }).success
    ).toBe(true);
  });

  it('reaches no adapter, engine, database or agent run to answer that', () => {
    // Asserted against the module's imports rather than by mocking: a descriptor lookup that can
    // reach an adapter is a lookup that can have a side effect, and the only way it reaches one is
    // by importing it.
    const source = fs.readFileSync(REGISTRY_SOURCE, 'utf8');
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

    expect([...new Set(specifiers)].sort()).toEqual(['../../../shared/types/playbook', 'zod']);
  });
});

describe('FEAT-008 VT-02 (TBI-032 b) — a missing or non-Zod schema fails registration', () => {
  it('names the step type and the field for a missing inputSchema', () => {
    const missing = descriptor({ stepType: 'no-input', inputSchema: undefined });

    expect(() => createStepTypeRegistry([missing])).toThrow(PlaybookStepTypeError);
    expect(() => validateStepTypeDescriptor(missing)).toThrow(/no-input.*inputSchema/s);
  });

  it('names the step type and the field for a missing outputSchema', () => {
    const missing = descriptor({ stepType: 'no-output', outputSchema: null });

    expect(() => validateStepTypeDescriptor(missing)).toThrow(/no-output.*outputSchema/s);
  });

  it('refuses a lookalike that merely has a parse method', () => {
    // A cast object with the right method names is what a hand-rolled "schema" looks like, and it
    // would pass every later parse call by doing nothing.
    const lookalike = descriptor({
      stepType: 'not-really-zod',
      inputSchema: { parse: (value: unknown) => value, safeParse: () => ({ success: true }) },
    });

    expect(() => validateStepTypeDescriptor(lookalike)).toThrow(/not-really-zod.*inputSchema/s);
  });
});

describe('FEAT-008 VT-03 (TBI-032 c) — registration inspects schemas, it does not run them', () => {
  it('registers a schema of entirely optional fields without inventing data for it', () => {
    const inputSchema = z.object({ subject: z.string().optional() });
    const parse = jest.spyOn(inputSchema, 'parse');
    const safeParse = jest.spyOn(inputSchema, 'safeParse');

    const registry = createStepTypeRegistry([descriptor({ stepType: 'all-optional', inputSchema })]);

    expect(registry.get('all-optional')?.inputSchema).toBe(inputSchema);
    expect(parse).not.toHaveBeenCalled();
    expect(safeParse).not.toHaveBeenCalled();
  });
});

describe('FEAT-008 VT-04 (TBI-033 a) — the approved classification and permission matrix', () => {
  it('classifies cursor-agent as leaves-apex requiring playbooks:run', () => {
    const cursorAgent = getStepTypeDescriptor('cursor-agent');

    expect(cursorAgent.sideEffect).toBe('leaves-apex');
    expect(cursorAgent.requiredPermissions).toEqual(['playbooks:run']);
  });

  it('classifies approval-gate as read requiring playbooks:view', () => {
    const approvalGate = getStepTypeDescriptor('approval-gate');

    expect(approvalGate.sideEffect).toBe('read');
    expect(approvalGate.requiredPermissions).toEqual(['playbooks:view']);
  });

  it('classifies notify as writes-apex requiring playbooks:run', () => {
    const notify = getStepTypeDescriptor('notify');

    expect(notify.sideEffect).toBe('writes-apex');
    expect(notify.requiredPermissions).toEqual(['playbooks:run']);
  });

  it('holds cursor-agent to a named Skill and a prompt, with an optional model', () => {
    const { inputSchema, outputSchema } = getStepTypeDescriptor('cursor-agent');

    expect(inputSchema.safeParse({ skillPath: 'a', prompt: 'b', model: 'auto' }).success).toBe(
      true
    );
    expect(inputSchema.safeParse({ skillPath: '', prompt: 'b' }).success).toBe(false);
    expect(inputSchema.safeParse({ skillPath: 'a', prompt: '' }).success).toBe(false);
    expect(inputSchema.safeParse({ prompt: 'b' }).success).toBe(false);

    expect(
      outputSchema.safeParse({ agentRunId: 'run-1', completedAt: '2026-09-22T10:00:00.000Z' })
        .success
    ).toBe(true);
    // A completion time nobody can read as a time is not a completion time.
    expect(outputSchema.safeParse({ agentRunId: 'run-1', completedAt: 'whenever' }).success).toBe(
      false
    );
    expect(outputSchema.safeParse({ agentRunId: 'run-1' }).success).toBe(false);
  });

  it('lets an approval gate carry an optional deadline and subject, and decide either way', () => {
    const { inputSchema, outputSchema } = getStepTypeDescriptor('approval-gate');

    expect(inputSchema.safeParse({}).success).toBe(true);
    expect(inputSchema.safeParse({ deadlineMs: 90 * 60 * 1000, subject: 'Ship it?' }).success).toBe(
      true
    );
    for (const deadlineMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(inputSchema.safeParse({ deadlineMs }).success).toBe(false);
    }

    expect(outputSchema.safeParse({ decision: 'approved', decidedBy: 'someone' }).success).toBe(
      true
    );
    expect(outputSchema.safeParse({ decision: 'rejected', decidedBy: 'someone' }).success).toBe(
      true
    );
    expect(outputSchema.safeParse({ decision: 'maybe', decidedBy: 'someone' }).success).toBe(false);
    expect(outputSchema.safeParse({ decision: 'approved' }).success).toBe(false);
  });

  it('requires a notify title and records who the notification reached', () => {
    const { inputSchema, outputSchema } = getStepTypeDescriptor('notify');

    expect(inputSchema.safeParse({ title: 'Done' }).success).toBe(true);
    expect(
      inputSchema.safeParse({ title: 'Done', body: 'b', link: '/x', recipientUserId: 'u' }).success
    ).toBe(true);
    expect(inputSchema.safeParse({ title: '' }).success).toBe(false);
    expect(inputSchema.safeParse({}).success).toBe(false);

    expect(outputSchema.safeParse({ notificationId: 'n-1', recipientUserId: 'u-1' }).success).toBe(
      true
    );
    // The recipient is resolved by the time the step completes, so it is not optional on the way
    // out even though the config may leave it to the run initiator.
    expect(outputSchema.safeParse({ notificationId: 'n-1' }).success).toBe(false);
  });
});

describe('FEAT-008 VT-05 (TBI-033 b) — a step type must state what it executes with', () => {
  it('refuses a descriptor with no requiredPermissions', () => {
    const absent = descriptor({ stepType: 'no-permissions', requiredPermissions: undefined });

    expect(() => createStepTypeRegistry([absent])).toThrow(PlaybookStepTypeError);
    expect(() => validateStepTypeDescriptor(absent)).toThrow(/no-permissions.*requiredPermissions/s);
  });

  it('refuses an empty requiredPermissions list', () => {
    const empty = descriptor({ stepType: 'empty-permissions', requiredPermissions: [] });

    expect(() => validateStepTypeDescriptor(empty)).toThrow(
      /empty-permissions.*requiredPermissions/s
    );
  });

  it('refuses a blank permission key, which permits nothing while reading like it permits something', () => {
    const blank = descriptor({ stepType: 'blank-permission', requiredPermissions: ['  '] });

    expect(() => validateStepTypeDescriptor(blank)).toThrow(
      /blank-permission.*requiredPermissions/s
    );
  });
});

describe('FEAT-008 VT-06 (TBI-033 c) — a fourth step type needs no registry change', () => {
  const FAKE_TYPE = 'fake-leaves-apex';

  const fake = descriptor({
    stepType: FAKE_TYPE,
    sideEffect: 'leaves-apex',
    isAgentStep: true,
    requiredPermissions: ['playbooks:run'],
    inputSchema: z.object({ target: z.string().min(1) }),
    outputSchema: z.object({ externalId: z.string() }),
  });

  it('registers and keeps its metadata retrievable', () => {
    const registry = createStepTypeRegistry([fake]);
    const registered = registry.get(FAKE_TYPE);

    expect(registered?.sideEffect).toBe('leaves-apex');
    expect(registered?.requiredPermissions).toEqual(['playbooks:run']);
    expect(registered?.inputSchema.safeParse({ target: 'somewhere' }).success).toBe(true);
  });

  it('does so without the registry naming it', () => {
    // Extension has to depend on the data a caller passes in, not on a branch over type names.
    expect(fs.readFileSync(REGISTRY_SOURCE, 'utf8')).not.toContain(FAKE_TYPE);
  });
});

describe('FEAT-008 VT-07 (TBI-033 d) — BR-005 still refuses a deadline-less suspension', () => {
  it('fails on the deadline even when schemas and permissions are perfectly valid', () => {
    const endless = descriptor({
      stepType: 'valid-but-endless',
      canSuspend: true,
      suspendReason: 'approval_gate',
      deadlineOverridable: true,
    });

    expect(() => validateStepTypeDescriptor(endless)).toThrow(/valid-but-endless/);
    expect(() => validateStepTypeDescriptor(endless)).toThrow(/defaultDeadlineMs/);
  });
});

describe('FEAT-008 TBI-033 — none has left the side-effect vocabulary', () => {
  it('offers exactly read, writes-apex and leaves-apex', () => {
    expect([...PLAYBOOK_STEP_SIDE_EFFECTS].sort()).toEqual(['leaves-apex', 'read', 'writes-apex']);
  });

  it('refuses a descriptor still classified none', () => {
    const stale = descriptor({ stepType: 'stale-classification', sideEffect: 'none' });

    expect(() => validateStepTypeDescriptor(stale)).toThrow(/stale-classification.*sideEffect/s);
  });

  it('returns no classification at all for an unknown step type', () => {
    // Not a default of `read` either: a type nobody recognises has not been shown to be harmless.
    expect(sideEffectOfStepType('teleport')).toBeUndefined();
  });

  it('re-checks permissions for anything that is not read, including an unknown type', () => {
    expect(requiresInitiatorPermissionRecheck('approval-gate')).toBe(false);
    expect(requiresInitiatorPermissionRecheck('notify')).toBe(true);
    expect(requiresInitiatorPermissionRecheck('cursor-agent')).toBe(true);
    expect(requiresInitiatorPermissionRecheck('teleport')).toBe(true);
  });
});

describe('FEAT-008 S1 — the half of the contract the compiler holds', () => {
  it('names ungated-leaves-apex among the guard violations', () => {
    const kind: PlaybookGuardViolationKind = 'ungated-leaves-apex';

    expect(kind).toBe('ungated-leaves-apex');
  });

  it('cannot be written with an empty permission list or a removed classification', () => {
    const noPermissions = {
      stepType: 'compile-time-empty',
      canSuspend: false,
      isAgentStep: false,
      sideEffect: 'read',
      // @ts-expect-error — requiredPermissions is a non-empty tuple, so [] cannot be written.
      requiredPermissions: [],
      inputSchema: z.object({}),
      outputSchema: z.object({}),
    } satisfies PlaybookStepTypeDescriptor;

    const staleClassification = {
      stepType: 'compile-time-none',
      canSuspend: false,
      isAgentStep: false,
      // @ts-expect-error — `none` was removed rather than aliased; `read` replaces it.
      sideEffect: 'none',
      requiredPermissions: ['playbooks:view'],
      inputSchema: z.object({}),
      outputSchema: z.object({}),
    } satisfies PlaybookStepTypeDescriptor;

    expect(noPermissions.stepType).toBe('compile-time-empty');
    expect(staleClassification.stepType).toBe('compile-time-none');
  });
});
