/**
 * FEAT-002 — Enforce Home Pill Access
 * Unit tests for the pure resolver in `services/homePillAccessResolver.ts`.
 *
 * The resolver takes every input it needs as a plain argument (TBI-003 NFR:
 * "pure function of inputs"), so these tests mock nothing at all.
 */

import {
  resolveHomePillAccess,
  resolveThreadCreationAdmission,
} from '../services/homePillAccessResolver';
import type { QuickMcpPill, QuickSkillPill } from '../../shared/types/projectSettings';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const CALLER = 'caller-oid';
const OTHER = 'other-oid';

const skillPill = (overrides: Partial<QuickSkillPill> = {}): QuickSkillPill => ({
  label: 'Kick Off',
  skillPath: '.cursor/skills/kick-off/SKILL.md',
  ...overrides,
});

const mcpPill = (overrides: Partial<QuickMcpPill> = {}): QuickMcpPill =>
  ({
    label: 'Docs',
    mcpServerName: 'docs-mcp',
    transport: 'http',
    url: 'https://mcp.example.com/docs',
    ...overrides,
  }) as QuickMcpPill;

/** A non-admin caller in no groups, unless overridden. */
const caller = (overrides: Record<string, unknown> = {}) => ({
  callerId: CALLER,
  callerGroupIds: [] as string[],
  isSuperAdmin: false,
  ...overrides,
});

// ── resolveHomePillAccess — allowed subsets ────────────────────────────────────

describe('resolveHomePillAccess — allowed subsets', () => {
  it('TBI-003 DoD-0 / PBI-003 BR-001 / VT-01 includes a pill whose allow-list fields are absent', () => {
    const pill = skillPill();

    const result = resolveHomePillAccess({
      skillPills: [pill],
      mcpPills: [],
      ...caller(),
    });

    expect(result.allowedSkillPills).toEqual([pill]);
  });

  it('TBI-003 DoD-0 / PBI-003 BR-001 / VT-01 includes a pill whose allow-lists are present but empty', () => {
    const pill = skillPill({ allowedUserIds: [], allowedGroupIds: [] });
    const mcp = mcpPill({ allowedUserIds: [], allowedGroupIds: [] });

    const result = resolveHomePillAccess({
      skillPills: [pill],
      mcpPills: [mcp],
      ...caller(),
    });

    expect(result.allowedSkillPills).toEqual([pill]);
    expect(result.allowedMcpPills).toEqual([mcp]);
  });

  it('TBI-003 DoD-0 / PBI-003 AC-0 / VT-02 returns only the pill the caller is directly allowed on', () => {
    const mine = skillPill({ label: 'Mine', allowedUserIds: [CALLER] });
    const theirs = skillPill({ label: 'Theirs', skillPath: 'other.md', allowedUserIds: [OTHER] });

    const result = resolveHomePillAccess({
      skillPills: [mine, theirs],
      mcpPills: [],
      ...caller(),
    });

    expect(result.allowedSkillPills).toEqual([mine]);
  });

  it('TBI-003 DoD-0 / PBI-003 AC-0 / BR-002 returns a pill the caller reaches through group membership', () => {
    const viaGroup = mcpPill({ label: 'Via group', allowedGroupIds: ['group-1'] });
    const notMine = mcpPill({
      label: 'Not mine',
      mcpServerName: 'other-mcp',
      allowedGroupIds: ['group-9'],
    });

    const result = resolveHomePillAccess({
      skillPills: [],
      mcpPills: [viaGroup, notMine],
      ...caller({ callerGroupIds: ['group-1'] }),
    });

    expect(result.allowedMcpPills).toEqual([viaGroup]);
  });

  it('TBI-003 DoD-0 / PBI-003 AC-0 returns direct, group, and open matches together across both pill kinds', () => {
    const open = skillPill({ label: 'Open' });
    const direct = skillPill({ label: 'Direct', skillPath: 'direct.md', allowedUserIds: [CALLER] });
    const excludedSkill = skillPill({
      label: 'Excluded',
      skillPath: 'excluded.md',
      allowedUserIds: [OTHER],
    });
    const viaGroup = mcpPill({ label: 'Group', allowedGroupIds: ['group-1'] });
    const excludedMcp = mcpPill({
      label: 'Excluded MCP',
      mcpServerName: 'excluded-mcp',
      allowedGroupIds: ['group-9'],
    });

    const result = resolveHomePillAccess({
      skillPills: [open, direct, excludedSkill],
      mcpPills: [viaGroup, excludedMcp],
      ...caller({ callerGroupIds: ['group-1'] }),
    });

    expect(result.allowedSkillPills).toEqual([open, direct]);
    expect(result.allowedMcpPills).toEqual([viaGroup]);
  });

  it('TBI-003 DoD-3 / PBI-003 AC-1 / VT-03 grants no access for a stale group reference and does not throw', () => {
    const stale = mcpPill({ allowedGroupIds: ['deleted-group-id'] });

    const act = () =>
      resolveHomePillAccess({
        skillPills: [],
        mcpPills: [stale],
        ...caller({ callerGroupIds: ['group-1'] }),
      });

    expect(act).not.toThrow();
    expect(act().allowedMcpPills).toEqual([]);
  });

  it('PBI-003 AC-3 returns empty subsets when the caller is allowed on none of the configured pills', () => {
    const result = resolveHomePillAccess({
      skillPills: [skillPill({ allowedUserIds: [OTHER] })],
      mcpPills: [mcpPill({ allowedGroupIds: ['group-9'] })],
      ...caller(),
    });

    expect(result.allowedSkillPills).toEqual([]);
    expect(result.allowedMcpPills).toEqual([]);
  });

  it('TBI-003 DoD-0 tolerates null and omitted pill arrays from the repository route', () => {
    expect(resolveHomePillAccess({ skillPills: null, mcpPills: null, ...caller() })).toEqual({
      allowedSkillPills: [],
      allowedMcpPills: [],
      canStartPillessChat: true,
    });
    expect(resolveHomePillAccess(caller())).toEqual({
      allowedSkillPills: [],
      allowedMcpPills: [],
      canStartPillessChat: true,
    });
  });

  it('TBI-003 NFR is a pure function — it does not mutate the pill arrays it is given', () => {
    const pills = [skillPill({ allowedUserIds: [OTHER] }), skillPill({ skillPath: 'open.md' })];
    const snapshot = JSON.parse(JSON.stringify(pills));

    resolveHomePillAccess({ skillPills: pills, mcpPills: [], ...caller() });

    expect(pills).toEqual(snapshot);
    expect(pills).toHaveLength(2);
  });
});

// ── resolveHomePillAccess — super admin bypass ─────────────────────────────────

describe('resolveHomePillAccess — Platform Admin bypass', () => {
  it('TBI-003 DoD-2 / PBI-004 BR-003 / AC-0 / VT-04 returns every pill unfiltered for a super admin', () => {
    const a = skillPill({ label: 'A', allowedUserIds: [OTHER] });
    const b = skillPill({ label: 'B', skillPath: 'b.md', allowedGroupIds: ['group-9'] });
    const m = mcpPill({ allowedUserIds: [OTHER] });

    const result = resolveHomePillAccess({
      skillPills: [a, b],
      mcpPills: [m],
      ...caller({ isSuperAdmin: true }),
    });

    expect(result.allowedSkillPills).toEqual([a, b]);
    expect(result.allowedMcpPills).toEqual([m]);
    expect(result.canStartPillessChat).toBe(true);
  });

  it('PBI-004 AC-1 treats a caller whose admin status is unverifiable as a regular caller', () => {
    const pill = skillPill({ allowedUserIds: [OTHER] });

    const result = resolveHomePillAccess({
      skillPills: [pill],
      mcpPills: [],
      callerId: CALLER,
      callerGroupIds: [],
      isSuperAdmin: undefined,
    });

    expect(result.allowedSkillPills).toEqual([]);
    expect(result.canStartPillessChat).toBe(false);
  });

  it('PBI-004 AC-2 leaves a zero-pill project unchanged for a super admin', () => {
    const result = resolveHomePillAccess({
      skillPills: [],
      mcpPills: [],
      ...caller({ isSuperAdmin: true }),
    });

    expect(result.allowedSkillPills).toEqual([]);
    expect(result.allowedMcpPills).toEqual([]);
    expect(result.canStartPillessChat).toBe(true);
  });

  it('PBI-004 BR-004 / AC-3 / VT-05 gives a Project Admin no bypass — pills stay filtered', () => {
    const a = skillPill({ label: 'A', allowedUserIds: [OTHER] });
    const b = skillPill({ label: 'B', skillPath: 'b.md', allowedGroupIds: ['group-9'] });

    const result = resolveHomePillAccess({
      skillPills: [a, b],
      mcpPills: [],
      ...caller({ isSuperAdmin: false }),
    });

    expect(result.allowedSkillPills).toEqual([]);
  });
});

// ── resolveHomePillAccess — canStartPillessChat ────────────────────────────────

describe('resolveHomePillAccess — canStartPillessChat', () => {
  it('TBI-003 DoD-1 / PBI-006 BR-006 / AC-2 / VT-06 is true when the project has zero configured pills', () => {
    const result = resolveHomePillAccess({ skillPills: [], mcpPills: [], ...caller() });

    expect(result.canStartPillessChat).toBe(true);
  });

  it('TBI-003 DoD-1 / PBI-006 BR-005 / VT-07 is false when pills are configured and the caller is allowed on none', () => {
    const result = resolveHomePillAccess({
      skillPills: [skillPill({ allowedUserIds: [OTHER] })],
      mcpPills: [mcpPill({ allowedUserIds: [OTHER] })],
      ...caller(),
    });

    expect(result.canStartPillessChat).toBe(false);
  });

  it('TBI-003 DoD-1 / PBI-006 AC-3 / VT-08 is true when the caller is allowed on at least one configured pill', () => {
    const result = resolveHomePillAccess({
      skillPills: [skillPill({ allowedUserIds: [OTHER] })],
      mcpPills: [mcpPill({ allowedUserIds: [CALLER] })],
      ...caller(),
    });

    expect(result.canStartPillessChat).toBe(true);
  });

  it('PBI-003 AC-2 preserves pill-less chat when zero pills are configured, for any caller identity', () => {
    const anonymous = resolveHomePillAccess({
      skillPills: [],
      mcpPills: [],
      callerId: null,
      callerGroupIds: null,
      isSuperAdmin: false,
    });

    expect(anonymous.canStartPillessChat).toBe(true);
  });
});

// ── resolveThreadCreationAdmission ─────────────────────────────────────────────

describe('resolveThreadCreationAdmission', () => {
  it('TBI-003 DoD-1 / PBI-005 AC-0 / VT-09 admits a kickoff naming a skill pill the caller is allowed on', () => {
    const allowed = skillPill({ skillPath: 'allowed.md', allowedUserIds: [CALLER] });

    const result = resolveThreadCreationAdmission({
      skillPills: [allowed],
      mcpPills: [],
      skillPath: 'allowed.md',
      ...caller(),
    });

    expect(result.admitted).toBe(true);
  });

  it('PBI-005 AC-0 denies a kickoff naming a skill pill the caller is not allowed on', () => {
    const denied = skillPill({ skillPath: 'denied.md', allowedUserIds: [OTHER] });

    const result = resolveThreadCreationAdmission({
      skillPills: [denied],
      mcpPills: [],
      skillPath: 'denied.md',
      ...caller(),
    });

    expect(result.admitted).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('PBI-005 AC-1 / VT-10 denies a kickoff naming an MCP pill the caller is not allowed on', () => {
    const denied = mcpPill({ mcpServerName: 'secret-mcp', allowedGroupIds: ['group-9'] });

    const result = resolveThreadCreationAdmission({
      skillPills: [],
      mcpPills: [denied],
      mcpServerName: 'secret-mcp',
      ...caller({ callerGroupIds: ['group-1'] }),
    });

    expect(result.admitted).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('PBI-005 AC-1 admits a kickoff naming an MCP pill the caller reaches through a group', () => {
    const allowed = mcpPill({ mcpServerName: 'team-mcp', allowedGroupIds: ['group-1'] });

    const result = resolveThreadCreationAdmission({
      skillPills: [],
      mcpPills: [allowed],
      mcpServerName: 'team-mcp',
      ...caller({ callerGroupIds: ['group-1'] }),
    });

    expect(result.admitted).toBe(true);
  });

  it('PBI-005 AC-2 / VT-11 denies an unmatched skillPath as pill-less when the caller is allowed on zero pills', () => {
    const result = resolveThreadCreationAdmission({
      skillPills: [skillPill({ skillPath: 'configured.md', allowedUserIds: [OTHER] })],
      mcpPills: [],
      skillPath: 'not-a-configured-pill.md',
      ...caller(),
    });

    expect(result.admitted).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('PBI-005 AC-2 admits an unmatched skillPath as pill-less when the caller is allowed on another pill', () => {
    const result = resolveThreadCreationAdmission({
      skillPills: [skillPill({ skillPath: 'configured.md', allowedUserIds: [CALLER] })],
      mcpPills: [],
      skillPath: 'not-a-configured-pill.md',
      ...caller(),
    });

    expect(result.admitted).toBe(true);
  });

  it('PBI-005 AC-2 matches skillPath on exact equality only — no trimming or case folding', () => {
    const configured = skillPill({ skillPath: 'Configured.md', allowedUserIds: [OTHER] });

    const nearMiss = resolveThreadCreationAdmission({
      skillPills: [configured],
      mcpPills: [],
      skillPath: ' configured.md ',
      ...caller(),
    });

    expect(nearMiss.admitted).toBe(false);
  });

  it('PBI-005 AC-3 / VT-12 admits a Platform Admin naming a pill they are not allow-listed on', () => {
    const denied = mcpPill({ mcpServerName: 'secret-mcp', allowedUserIds: [OTHER] });

    const result = resolveThreadCreationAdmission({
      skillPills: [skillPill({ skillPath: 'locked.md', allowedUserIds: [OTHER] })],
      mcpPills: [denied],
      mcpServerName: 'secret-mcp',
      ...caller({ isSuperAdmin: true }),
    });

    expect(result.admitted).toBe(true);
  });

  it('PBI-006 BR-006 / AC-2 / VT-14 admits a pill-less kickoff when the project has zero configured pills', () => {
    const result = resolveThreadCreationAdmission({
      skillPills: [],
      mcpPills: [],
      ...caller(),
    });

    expect(result.admitted).toBe(true);
  });

  it('PBI-006 BR-005 / VT-13 denies a pill-less kickoff when pills are configured and the caller is allowed on none', () => {
    const result = resolveThreadCreationAdmission({
      skillPills: [skillPill({ allowedUserIds: [OTHER] })],
      mcpPills: [],
      ...caller(),
    });

    expect(result.admitted).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('PBI-006 AC-3 admits a pill-less kickoff when the caller is allowed on at least one configured pill', () => {
    const result = resolveThreadCreationAdmission({
      skillPills: [skillPill({ allowedUserIds: [CALLER] })],
      mcpPills: [mcpPill({ allowedUserIds: [OTHER] })],
      ...caller(),
    });

    expect(result.admitted).toBe(true);
  });

  it('TBI-003 DoD-1 carries no denial reason on an admitted result', () => {
    const result = resolveThreadCreationAdmission({ skillPills: [], mcpPills: [], ...caller() });

    expect(result.admitted).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('PBI-005 AC-1 denies on the MCP pill when a kickoff names an allowed skill pill and a disallowed MCP pill', () => {
    const result = resolveThreadCreationAdmission({
      skillPills: [skillPill({ skillPath: 'ok.md', allowedUserIds: [CALLER] })],
      mcpPills: [mcpPill({ mcpServerName: 'secret-mcp', allowedUserIds: [OTHER] })],
      skillPath: 'ok.md',
      mcpServerName: 'secret-mcp',
      ...caller(),
    });

    expect(result.admitted).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});
