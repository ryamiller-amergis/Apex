/**
 * TBI-016 — the step-type registry.
 *
 * Covers VT-01 (a suspendable type with no deadline is rejected), VT-02 (the three Phase 0 types
 * register with their deadlines) and VT-04 (the registry is the only declaration site).
 *
 * VT-03 — that a malformed descriptor fails at *startup* rather than first use — needs a booting
 * app, so it lives in the integration suite.
 */
import fs from 'fs';
import path from 'path';
import type { PlaybookStepTypeDescriptor } from '../../shared/types/playbook';
import {
  APPROVAL_GATE_DEADLINE_MS,
  CURSOR_AGENT_DEADLINE_MS,
  PHASE_0_ALLOWED_AGENT_SKILLS,
  PHASE_0_STEP_TYPES,
  PlaybookStepTypeError,
  UnknownPlaybookStepTypeError,
  assertSkillAllowed,
  createStepTypeRegistry,
  getStepTypeDescriptor,
  isRegisteredStepType,
  listStepTypeDescriptors,
  resolveDeadlineMs,
  validateStepTypeDescriptor,
  validateStepTypeRegistry,
} from '../services/playbookSteps/registry';

/*
 * Cast because the descriptor union makes this combination fail to compile, which is the point:
 * the type stops a literal, and this asserts the runtime check that catches everything else.
 */
const SUSPENDS_WITHOUT_DEADLINE = {
  stepType: 'forgot-the-deadline',
  canSuspend: true,
} as unknown as PlaybookStepTypeDescriptor;

describe('VT-01 — a suspendable step type must declare a deadline', () => {
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
      const descriptor = {
        stepType: 'bad-deadline',
        canSuspend: true,
        defaultDeadlineMs,
        deadlineOverridable: false,
      } as unknown as PlaybookStepTypeDescriptor;
      expect(() => validateStepTypeDescriptor(descriptor)).toThrow(PlaybookStepTypeError);
    }
  });

  it('accepts a non-suspending type with no deadline', () => {
    expect(() =>
      validateStepTypeDescriptor({ stepType: 'fire-and-forget', canSuspend: false })
    ).not.toThrow();
  });

  it('refuses a deadline on a type that cannot suspend', () => {
    const descriptor = {
      stepType: 'pointless-deadline',
      canSuspend: false,
      defaultDeadlineMs: 1000,
    } as unknown as PlaybookStepTypeDescriptor;

    expect(() => validateStepTypeDescriptor(descriptor)).toThrow(/would never be read/);
  });

  it('refuses two descriptors for one step type', () => {
    const twice = [
      { stepType: 'notify', canSuspend: false },
      { stepType: 'notify', canSuspend: false },
    ] as const;

    expect(() => createStepTypeRegistry(twice)).toThrow(/declared twice/);
  });
});

describe('VT-02 — the three Phase 0 step types', () => {
  it('registers exactly cursor-agent, approval-gate and notify', () => {
    expect(listStepTypeDescriptors().map((d) => d.stepType).sort()).toEqual([
      'approval-gate',
      'cursor-agent',
      'notify',
    ]);
  });

  it('gives cursor-agent a 60-minute deadline that a definition cannot override', () => {
    const descriptor = getStepTypeDescriptor('cursor-agent');

    expect(descriptor.canSuspend).toBe(true);
    expect(CURSOR_AGENT_DEADLINE_MS).toBe(60 * 60 * 1000);
    expect(descriptor.defaultDeadlineMs).toBe(CURSOR_AGENT_DEADLINE_MS);
    expect(resolveDeadlineMs('cursor-agent')).toBe(CURSOR_AGENT_DEADLINE_MS);
    expect(() => resolveDeadlineMs('cursor-agent', 5000)).toThrow(/does not allow/);
  });

  it('gives approval-gate a 48-hour deadline a definition may override', () => {
    const descriptor = getStepTypeDescriptor('approval-gate');

    expect(descriptor.canSuspend).toBe(true);
    expect(APPROVAL_GATE_DEADLINE_MS).toBe(48 * 60 * 60 * 1000);
    expect(resolveDeadlineMs('approval-gate')).toBe(APPROVAL_GATE_DEADLINE_MS);
    expect(resolveDeadlineMs('approval-gate', 90 * 60 * 1000)).toBe(90 * 60 * 1000);
    expect(() => resolveDeadlineMs('approval-gate', 0)).toThrow(/positive number/);
  });

  it('gives notify no deadline, because it never waits', () => {
    const descriptor = getStepTypeDescriptor('notify');

    expect(descriptor.canSuspend).toBe(false);
    expect(descriptor.defaultDeadlineMs).toBeUndefined();
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
      expect(fs.existsSync(path.resolve(__dirname, '../../..', skillPath))).toBe(true);
    }
  });
});

describe('VT-04 — the registry is the only place a step type is declared', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../..');
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
      .filter((file) => !file.startsWith(`${OWNING_DIR}/`) && !file.includes('__tests__'))
      .filter((file) => {
        const code = stripComments(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
        return STEP_TYPE_NAMES.some((name) => code.includes(`'${name}'`));
      });

    expect(offenders).toEqual([]);
  });

  it('keeps the descriptors themselves in one array', () => {
    // Registered types and declared descriptors must be the same set; a type appearing in the map
    // but not in this array would mean a second registration path had grown.
    expect(PHASE_0_STEP_TYPES.map((d) => d.stepType).sort()).toEqual(
      listStepTypeDescriptors().map((d) => d.stepType).sort()
    );
  });
});
