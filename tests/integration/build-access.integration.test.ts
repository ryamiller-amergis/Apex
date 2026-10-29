/**
 * FEAT-002 build access on the migrated test database.
 * Covers VT-12 (migrations re-run cleanly and grant the right roles),
 * VT-15 (allow-list lookup under 50 ms with 300 rows) and VT-16 (allow-list
 * change and its audit row commit or roll back together).
 */
import './setup';
import { db } from './setup';
import fs from 'fs';
import path from 'path';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import pool from '../../src/server/db';
import {
  appPermissions,
  appRolePermissions,
  appRoles,
  appUserRoles,
  appUsers,
  buildAllowlist,
  buildAllowlistAudit,
  featureFlags,
  projectSkillSettings,
} from '../../src/server/db/schema';
import { getUserPermissions } from '../../src/server/services/rbacService';
import {
  addBuildAllowlistEntry,
  BuildAccessError,
  isBuildPairAllowed,
  removeBuildAllowlistEntry,
  type BuildAllowlistActor,
} from '../../src/server/services/buildAccessService';
import { BUILDS_RUN, BUILDS_VIEW } from '../../src/shared/types/buildAccess';
import { BUILD_FROM_PROMPT_FLAG } from '../../src/shared/types/featureFlags';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const PERMISSIONS_MIGRATION = '20261023200000_b7e2_add-builds-permissions.sql';
const FLAG_MIGRATION = '20261023200100_b7e3_seed-build-from-prompt-flag.sql';

const PROJECT_PREFIX = 'feat002-it-';
const PROJECT = `${PROJECT_PREFIX}project`;
const REPOSITORY = 'Feat002-Repo';
const MEMBER_OID = 'feat002-it-member';
const VIEWER_OID = 'feat002-it-viewer';
const ACTOR: BuildAllowlistActor = {
  id: 'feat002-it-admin',
  label: 'FEAT-002 Admin',
};
const BROKEN_ACTOR = {
  id: null,
  label: 'No id',
} as unknown as BuildAllowlistActor;

function upSection(file: string): string {
  const text = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  const [up] = text.split(/^-- Down Migration/m);
  return up;
}

async function cleanup() {
  await db
    .delete(buildAllowlist)
    .where(like(buildAllowlist.project, `${PROJECT_PREFIX}%`));
  await db
    .delete(buildAllowlistAudit)
    .where(like(buildAllowlistAudit.project, `${PROJECT_PREFIX}%`));
  await db
    .delete(projectSkillSettings)
    .where(eq(projectSkillSettings.project, PROJECT));
  await db
    .delete(appUsers)
    .where(inArray(appUsers.oid, [MEMBER_OID, VIEWER_OID]));
}

async function grantRole(oid: string, roleName: string) {
  await db
    .insert(appUsers)
    .values({ oid, displayName: oid })
    .onConflictDoNothing();
  const [role] = await db
    .select({ id: appRoles.id })
    .from(appRoles)
    .where(eq(appRoles.name, roleName));
  await db.insert(appUserRoles).values({ userId: oid, roleId: role.id });
}

async function roleNamesFor(permissionKey: string): Promise<string[]> {
  const rows = await db
    .select({ name: appRoles.name })
    .from(appRolePermissions)
    .innerJoin(appRoles, eq(appRoles.id, appRolePermissions.roleId))
    .innerJoin(
      appPermissions,
      eq(appPermissions.id, appRolePermissions.permissionId)
    )
    .where(
      and(
        eq(appPermissions.key, permissionKey),
        inArray(appRoles.name, ['admin', 'member', 'viewer'])
      )
    );
  return rows.map((row) => row.name).sort();
}

async function auditRows() {
  return db
    .select({
      action: buildAllowlistAudit.action,
      actorId: buildAllowlistAudit.actorId,
    })
    .from(buildAllowlistAudit)
    .where(eq(buildAllowlistAudit.project, PROJECT));
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe('VT-12 build permission and flag migrations re-run cleanly', () => {
  it('leaves one grant per role and one flag after a second run', async () => {
    await db.execute(sql.raw(upSection(PERMISSIONS_MIGRATION)));
    await db.execute(sql.raw(upSection(FLAG_MIGRATION)));

    const permissions = await db
      .select({ key: appPermissions.key })
      .from(appPermissions)
      .where(inArray(appPermissions.key, [BUILDS_VIEW, BUILDS_RUN]));
    expect(permissions.map((row) => row.key).sort()).toEqual([
      BUILDS_RUN,
      BUILDS_VIEW,
    ]);

    expect(await roleNamesFor(BUILDS_VIEW)).toEqual([
      'admin',
      'member',
      'viewer',
    ]);
    expect(await roleNamesFor(BUILDS_RUN)).toEqual(['admin', 'member']);

    const flags = await db
      .select({ enabled: featureFlags.enabled })
      .from(featureFlags)
      .where(eq(featureFlags.key, BUILD_FROM_PROMPT_FLAG));
    expect(flags).toHaveLength(1);
  });

  it('resolves builds permissions through getUserPermissions', async () => {
    await grantRole(MEMBER_OID, 'member');
    await grantRole(VIEWER_OID, 'viewer');

    const member = await getUserPermissions(MEMBER_OID);
    expect(member.has(BUILDS_VIEW)).toBe(true);
    expect(member.has(BUILDS_RUN)).toBe(true);

    const viewer = await getUserPermissions(VIEWER_OID);
    expect(viewer.has(BUILDS_VIEW)).toBe(true);
    expect(viewer.has(BUILDS_RUN)).toBe(false);
  });
});

describe('VT-15 allow-list lookup speed', () => {
  it('answers in under 50 ms at the 95th percentile with 300 rows', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      project: `${PROJECT_PREFIX}load-${i % 30}`,
      repository: `repo-${i}`,
    }));
    await db.insert(buildAllowlist).values(rows);

    await isBuildPairAllowed(`${PROJECT_PREFIX}load-0`, 'repo-0');
    const samples: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const start = performance.now();
      const allowed = await isBuildPairAllowed(
        `${PROJECT_PREFIX}load-${i % 30}`,
        `REPO-${i}`
      );
      samples.push(performance.now() - start);
      expect(allowed).toBe(true);
    }
    expect(await isBuildPairAllowed(`${PROJECT_PREFIX}load-0`, 'repo-1')).toBe(
      false
    );

    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
    expect(p95).toBeLessThan(50);
  });
});

describe('VT-16 allow-list change and audit row share one transaction', () => {
  beforeEach(async () => {
    await db.insert(projectSkillSettings).values({
      project: PROJECT,
      skillRepo: REPOSITORY,
      skillBranch: 'main',
      friendlyName: 'FEAT-002 integration',
    });
  });

  it('writes one audit row for each successful add and remove', async () => {
    const entry = await addBuildAllowlistEntry({
      project: PROJECT,
      repository: REPOSITORY.toLowerCase(),
      actor: ACTOR,
    });
    expect(entry.repository).toBe(REPOSITORY);
    expect(await isBuildPairAllowed(PROJECT, REPOSITORY)).toBe(true);

    await removeBuildAllowlistEntry(entry.id, ACTOR);
    expect(await isBuildPairAllowed(PROJECT, REPOSITORY)).toBe(false);

    const audit = await auditRows();
    expect(audit.map((row) => row.action).sort()).toEqual(['added', 'removed']);
    expect(audit.every((row) => row.actorId === ACTOR.id)).toBe(true);
  });

  it('keeps no allow-list row when the audit insert fails on add', async () => {
    await expect(
      addBuildAllowlistEntry({
        project: PROJECT,
        repository: REPOSITORY,
        actor: BROKEN_ACTOR,
      })
    ).rejects.toThrow();

    expect(await isBuildPairAllowed(PROJECT, REPOSITORY)).toBe(false);
    expect(await auditRows()).toEqual([]);
  });

  it('keeps the allow-list row when the audit insert fails on remove', async () => {
    const entry = await addBuildAllowlistEntry({
      project: PROJECT,
      repository: REPOSITORY,
      actor: ACTOR,
    });

    await expect(
      removeBuildAllowlistEntry(entry.id, BROKEN_ACTOR)
    ).rejects.toThrow();

    expect(await isBuildPairAllowed(PROJECT, REPOSITORY)).toBe(true);
    expect((await auditRows()).map((row) => row.action)).toEqual(['added']);
  });

  it('reports a duplicate add without writing a second audit row', async () => {
    await addBuildAllowlistEntry({
      project: PROJECT,
      repository: REPOSITORY,
      actor: ACTOR,
    });

    await expect(
      addBuildAllowlistEntry({
        project: PROJECT,
        repository: REPOSITORY,
        actor: ACTOR,
      })
    ).rejects.toMatchObject({
      kind: 'DUPLICATE',
    } satisfies Partial<BuildAccessError>);

    expect(await auditRows()).toHaveLength(1);
  });
});
