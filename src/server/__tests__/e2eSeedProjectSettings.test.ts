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
  const state = {
    existingSettings: [] as unknown[],
    insertedSettingsRow: {} as Record<string, unknown>,
  };

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

  const makeUpdate = () => {
    const chain = {
      set() {
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
      where: () => chain,
      limit: () => Promise.resolve(state.existingSettings),
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
  };
});

import express from 'express';
import request from 'supertest';
import e2eRouter from '../routes/e2eSetup';
import { projectApprovalModes } from '../db/schema';

const { __mockState: mockState, __inserts: inserts } = jest.requireMock('../db/drizzle') as {
  __mockState: { existingSettings: unknown[]; insertedSettingsRow: Record<string, unknown> };
  __inserts: Array<{ table: unknown; values: unknown; conflict: string; conflictArgs: unknown }>;
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
