/**
 * Seed-route contract checks for POST /seed/project-settings.
 * The Drizzle `db` instance is fully mocked so no real database is needed;
 * the mock records every insert/update so we can assert what the seed writes.
 */

jest.mock('../db/drizzle', () => {
  type InsertRecord = {
    table: unknown;
    values: unknown;
    conflict: 'none' | 'do_nothing' | 'do_update';
    conflictArgs: unknown;
  };
  const inserts: InsertRecord[] = [];
  const updates: Array<{ table: unknown; set: unknown }> = [];
  const state = {
    existingSettings: [] as unknown[],
    insertedSettingsRow: {} as Record<string, unknown>,
    /** Results for successive selects; falls back to existingSettings. */
    selectQueue: [] as unknown[][],
  };
  const nextSelect = () =>
    Promise.resolve(state.selectQueue.length ? state.selectQueue.shift() : state.existingSettings);

  const makeInsert = (table: unknown) => {
    const record: InsertRecord = {
      table,
      values: undefined,
      conflict: 'none',
      conflictArgs: undefined,
    };
    const chain = {
      values(values: unknown) {
        record.values = values;
        inserts.push(record);
        return chain;
      },
      onConflictDoNothing() {
        record.conflict = 'do_nothing';
        return Promise.resolve(undefined);
      },
      onConflictDoUpdate(args: unknown) {
        record.conflict = 'do_update';
        record.conflictArgs = args;
        return Promise.resolve(undefined);
      },
      returning() {
        return Promise.resolve([state.insertedSettingsRow]);
      },
    };
    return chain;
  };

  const makeUpdate = (table: unknown) => {
    const chain = {
      set(set: unknown) {
        updates.push({ table, set });
        return chain;
      },
      where() {
        return Object.assign(Promise.resolve(undefined), {
          returning: () => Promise.resolve([state.insertedSettingsRow]),
        });
      },
    };
    return chain;
  };

  const makeSelect = () => {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      // Thenable so only an awaited where() (no .limit()) takes a queued result.
      where: () => ({
        ...chain,
        then: (resolve: (rows: unknown) => unknown, reject: (err: unknown) => unknown) =>
          nextSelect().then(resolve, reject),
      }),
      limit: () => nextSelect(),
    };
    return chain;
  };

  return {
    db: {
      insert: jest.fn(makeInsert),
      update: jest.fn(makeUpdate),
      delete: jest.fn(() => ({ where: () => Promise.resolve(undefined) })),
      select: jest.fn(makeSelect),
    },
    __mockState: state,
    __inserts: inserts,
    __updates: updates,
  };
});

import express from 'express';
import request from 'supertest';
import e2eRouter from '../routes/e2eSetup';
import {
  appRolePermissions,
  appRoles,
  appUserRoles,
  projectApprovalModes,
  projectSkillSettings,
  projectSkillWorkflowSettings,
} from '../db/schema';

const {
  __mockState: mockState,
  __inserts: inserts,
  __updates: updates,
} = jest.requireMock('../db/drizzle') as {
  __mockState: {
    existingSettings: unknown[];
    insertedSettingsRow: Record<string, unknown>;
    selectQueue: unknown[][];
  };
  __inserts: Array<{ table: unknown; values: unknown; conflict: string; conflictArgs: unknown }>;
  __updates: Array<{ table: unknown; set: unknown }>;
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', e2eRouter);
  return app;
}

function approvalModeInserts() {
  return inserts.filter((record) => record.table === projectApprovalModes);
}

describe('E2E seed/project-settings per-module approval modes', () => {
  beforeEach(() => {
    inserts.length = 0;
    updates.length = 0;
    mockState.selectQueue = [];
    mockState.existingSettings = [];
    mockState.insertedSettingsRow = {
      id: 'settings-1',
      project: 'E2E Project',
      friendlyName: '[E2E] Settings',
      approvalMode: 'any_one',
      isDefault: false,
    };
  });

  it('seeds per-module rows from the supplied legacy approvalMode and forces adr to any_one', async () => {
    const response = await request(buildApp())
      .post('/seed/project-settings')
      .send({ project: 'E2E Project', approvalMode: 'all_required' });

    expect(response.status).toBe(200);
    const [modeInsert, ...extra] = approvalModeInserts();
    expect(extra).toHaveLength(0);
    expect(modeInsert.values).toEqual([
      { settingsId: 'settings-1', documentType: 'prd', mode: 'all_required' },
      { settingsId: 'settings-1', documentType: 'design_doc', mode: 'all_required' },
      { settingsId: 'settings-1', documentType: 'design_prototype', mode: 'all_required' },
      { settingsId: 'settings-1', documentType: 'test_case', mode: 'all_required' },
      { settingsId: 'settings-1', documentType: 'adr', mode: 'any_one' },
    ]);
  });

  it('upserts on (settings_id, document_type) so repeated seeding stays deterministic', async () => {
    await request(buildApp())
      .post('/seed/project-settings')
      .send({ project: 'E2E Project', approvalMode: 'any_one' });

    const [modeInsert] = approvalModeInserts();
    expect(modeInsert.conflict).toBe('do_update');
    expect(modeInsert.conflictArgs).toEqual(
      expect.objectContaining({
        target: [projectApprovalModes.settingsId, projectApprovalModes.documentType],
      }),
    );
  });

  it('leaves per-module rows untouched when approvalMode is not supplied', async () => {
    const response = await request(buildApp())
      .post('/seed/project-settings')
      .send({ project: 'E2E Project', prdApprovers: ['user-1'] });

    expect(response.status).toBe(200);
    expect(approvalModeInserts()).toHaveLength(0);
  });
});

describe('E2E seed/project-settings legacy workflow columns', () => {
  const legacyWorkflowValues = {
    interviewModel: 'legacy-interview-model',
    interviewEffort: 'high',
    adrModel: 'legacy-adr-model',
    adrEffort: 'low',
    uiLabBedrockTemperature: 0.4,
    prdReviewBedrockMaxTokens: 32000,
  };

  beforeEach(() => {
    inserts.length = 0;
    updates.length = 0;
    mockState.selectQueue = [];
    mockState.existingSettings = [];
    mockState.insertedSettingsRow = { id: 'settings-1', project: 'E2E Project', isDefault: true };
  });

  it('writes workflow values into the legacy columns only, like app code that predates the child table', async () => {
    const response = await request(buildApp())
      .post('/seed/project-settings')
      .send({
        project: 'E2E Project',
        defaultModel: 'project-default-model',
        defaultEffort: 'medium',
        legacyWorkflowValues,
      });

    expect(response.status).toBe(200);
    const settingsInsert = inserts.find((record) => record.table === projectSkillSettings);
    expect(settingsInsert?.values).toEqual(
      expect.objectContaining({
        ...legacyWorkflowValues,
        defaultModel: 'project-default-model',
        defaultEffort: 'medium',
      }),
    );
    expect(inserts.some((record) => record.table === projectSkillWorkflowSettings)).toBe(false);
  });

  it('applies the same legacy values when re-seeding an existing row', async () => {
    mockState.existingSettings = [{ id: 'settings-1', project: 'E2E Project' }];

    await request(buildApp())
      .post('/seed/project-settings')
      .send({ project: 'E2E Project', legacyWorkflowValues });

    const settingsUpdate = updates.find((record) => record.table === projectSkillSettings);
    expect(settingsUpdate?.set).toEqual(expect.objectContaining(legacyWorkflowValues));
    expect(inserts.some((record) => record.table === projectSkillWorkflowSettings)).toBe(false);
  });

  it('rejects keys that are not registry legacy workflow fields', async () => {
    const response = await request(buildApp())
      .post('/seed/project-settings')
      .send({ project: 'E2E Project', legacyWorkflowValues: { skillRepo: 'evil/repo' } });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/skillRepo/);
    expect(inserts).toHaveLength(0);
  });
});

describe('E2E seed/admin-role', () => {
  beforeEach(() => {
    inserts.length = 0;
    updates.length = 0;
    mockState.existingSettings = [];
    mockState.insertedSettingsRow = { id: 'role-e2e' };
  });

  // Admin > Project Settings loads through fetch calls that send no project, so
  // only a global role grant reaches requirePermission('admin:roles').
  it('grants a global copy of the admin role that reset removes by its [E2E] name', async () => {
    mockState.selectQueue = [
      [{ id: 'role-admin', name: 'admin' }],
      [{ permissionId: 'perm-admin-roles' }, { permissionId: 'perm-skills-manage' }],
    ];

    const response = await request(buildApp())
      .post('/seed/admin-role')
      .send({ userId: 'dev-mock-oid-00000000-0000-0000-0000-000000000002' });

    expect(response.status).toBe(200);
    const roleInsert = inserts.find((record) => record.table === appRoles);
    expect((roleInsert?.values as { name: string }).name).toBe('[E2E] admin 00000002');
    expect(inserts.find((record) => record.table === appRolePermissions)?.values).toEqual([
      { roleId: 'role-e2e', permissionId: 'perm-admin-roles' },
      { roleId: 'role-e2e', permissionId: 'perm-skills-manage' },
    ]);
    expect(inserts.find((record) => record.table === appUserRoles)?.values).toEqual({
      userId: 'dev-mock-oid-00000000-0000-0000-0000-000000000002',
      roleId: 'role-e2e',
      assignedBy: 'e2e',
    });
  });

  it('fails when the built-in admin role is missing', async () => {
    mockState.selectQueue = [[]];

    const response = await request(buildApp()).post('/seed/admin-role').send({ userId: 'u' });

    expect(response.status).toBe(500);
    expect(inserts).toHaveLength(0);
  });
});
