import fs from 'node:fs';
import path from 'node:path';

jest.mock('../db/drizzle', () => ({ db: {} }));

import {
  createRunGroundingRepository,
  RunGroundingRepositoryError,
  type RunGroundingStore,
} from '../services/runGroundingRepository';
import type {
  ActiveRepositoryBranchQuery,
  CreateRunGroundingInput,
  RepoRole,
  RunGrounding,
  RunRef,
} from '../../shared/types/runGrounding';

class InMemoryRunGroundingStore implements RunGroundingStore {
  private rows: RunGrounding[] = [];
  private sequence = 0;
  batchFailureIndex: number | null = null;

  async insert(input: CreateRunGroundingInput): Promise<RunGrounding> {
    if (
      this.rows.some(
        (row) =>
          row.runType === input.runType &&
          row.runId === input.runId &&
          row.project === input.project &&
          row.repoRole === input.repoRole &&
          row.isActive
      )
    ) {
      throw new Error('duplicate active role');
    }

    const createdAt = `2026-08-02T14:00:0${this.sequence}.000Z`;
    const row: RunGrounding = {
      ...input,
      id: `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, '0')}`,
      groundedAt: input.groundedAt ?? createdAt,
      isActive: true,
      createdAt,
      updatedAt: createdAt,
    };
    this.rows.push(row);
    return row;
  }

  async insertMany(inputs: CreateRunGroundingInput[]): Promise<RunGrounding[]> {
    const rowsBefore = this.rows.map((row) => ({ ...row }));
    const sequenceBefore = this.sequence;

    try {
      const inserted: RunGrounding[] = [];
      for (const [index, input] of inputs.entries()) {
        if (index === this.batchFailureIndex) {
          throw new Error('simulated batch insert failure');
        }
        inserted.push(await this.insert(input));
      }
      return inserted;
    } catch (error) {
      this.rows = rowsBefore;
      this.sequence = sequenceBefore;
      throw error;
    }
  }

  async findByRun(ref: RunRef): Promise<RunGrounding[]> {
    return this.rows
      .filter(
        (row) =>
          row.runType === ref.runType &&
          row.runId === ref.runId &&
          row.project === ref.project
      )
      .sort(
        (left, right) =>
          right.groundedAt.localeCompare(left.groundedAt) ||
          right.createdAt.localeCompare(left.createdAt) ||
          right.id.localeCompare(left.id)
      );
  }

  async findActiveByRole(
    ref: RunRef,
    role: RepoRole
  ): Promise<RunGrounding | null> {
    return (
      this.rows.find(
        (row) =>
          row.runType === ref.runType &&
          row.runId === ref.runId &&
          row.project === ref.project &&
          row.repoRole === role &&
          row.isActive
      ) ?? null
    );
  }

  async findActiveByRepoBranch(
    query: ActiveRepositoryBranchQuery
  ): Promise<RunGrounding[]> {
    return this.rows.filter(
      (row) =>
        row.provider === query.provider &&
        row.project === query.project &&
        row.repository === query.repository &&
        row.branch === query.branch &&
        row.isActive
    );
  }

  async reground(
    ref: RunRef,
    role: RepoRole,
    newSha: string,
    groundedAt: string
  ): Promise<RunGrounding | null> {
    const current =
      (await this.findActiveByRole(ref, role)) ??
      (await this.findByRun(ref)).find((row) => row.repoRole === role) ??
      null;
    if (!current) return null;

    if (current.isActive) {
      current.isActive = false;
      current.updatedAt = groundedAt;
    }
    return this.insert({
      ...ref,
      repoRole: role,
      provider: current.provider,
      repository: current.repository,
      branch: current.branch,
      groundedSha: newSha,
      groundedAt,
    });
  }

  async deactivateByRun(ref: RunRef): Promise<number> {
    let affected = 0;
    for (const row of this.rows) {
      if (
        row.runType === ref.runType &&
        row.runId === ref.runId &&
        row.project === ref.project &&
        row.isActive
      ) {
        row.isActive = false;
        affected += 1;
      }
    }
    return affected;
  }
}

const targetInput: CreateRunGroundingInput = {
  runType: 'chat',
  runId: 'run-1',
  project: 'Apex',
  repoRole: 'target',
  provider: 'github',
  repository: 'ASM/AI-Pilot',
  branch: 'main',
  groundedSha: 'target-sha',
  groundedAt: '2026-08-02T14:00:00.000Z',
};

describe('runGroundingRepository', () => {
  it('PBI-003 AC-0 atomically activates exact target and skill rows in one batch', async () => {
    const store = new InMemoryRunGroundingStore();
    const repository = createRunGroundingRepository(store);
    const skillInput: CreateRunGroundingInput = {
      ...targetInput,
      repoRole: 'skill',
      repository: 'ASM/agent-skills',
      groundedSha: 'skill-sha',
    };

    const rows = await repository.activateGroundings([targetInput, skillInput]);

    expect(rows).toEqual([
      expect.objectContaining({
        repoRole: 'target',
        groundedSha: 'target-sha',
        groundedAt: '2026-08-02T14:00:00.000Z',
        isActive: true,
      }),
      expect.objectContaining({
        repoRole: 'skill',
        groundedSha: 'skill-sha',
        groundedAt: '2026-08-02T14:00:00.000Z',
        isActive: true,
      }),
    ]);
    await expect(repository.findByRun(targetInput)).resolves.toHaveLength(2);
  });

  it('PBI-003 AC-1 rolls back every row when atomic activation fails', async () => {
    const store = new InMemoryRunGroundingStore();
    store.batchFailureIndex = 1;
    const repository = createRunGroundingRepository(store);

    const activation = repository.activateGroundings([
      targetInput,
      {
        ...targetInput,
        repoRole: 'skill',
        repository: 'ASM/agent-skills',
        groundedSha: 'skill-sha',
      },
    ]);

    await expect(activation).rejects.toMatchObject({
      code: 'run_grounding_persistence_failed',
      operation: 'activate',
    });
    await expect(repository.findByRun(targetInput)).resolves.toEqual([]);
  });

  it('DoD-1 / VT-01 creates and queries target and skill roles independently', async () => {
    const repository = createRunGroundingRepository(
      new InMemoryRunGroundingStore(),
      {
        now: () => '2026-08-02T14:30:00.000Z',
      }
    );

    await repository.createGrounding(targetInput);
    await repository.createGrounding({
      ...targetInput,
      repoRole: 'skill',
      repository: 'ASM/agent-skills',
      groundedSha: 'skill-sha',
    });

    const rows = await repository.findByRun({
      runType: 'chat',
      runId: 'run-1',
      project: 'Apex',
    });
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repoRole: 'target',
          groundedSha: 'target-sha',
          groundedAt: '2026-08-02T14:00:00.000Z',
          isActive: true,
        }),
        expect.objectContaining({
          repoRole: 'skill',
          groundedSha: 'skill-sha',
          groundedAt: '2026-08-02T14:00:00.000Z',
          isActive: true,
        }),
      ])
    );
  });

  it.each(['chat', 'one_shot', 'service'] as const)(
    'DoD-2 / VT-07 supports the polymorphic %s run type without domain joins',
    async (runType) => {
      const repository = createRunGroundingRepository(
        new InMemoryRunGroundingStore()
      );
      await repository.createGrounding({
        ...targetInput,
        runType,
        runId: `${runType}-run`,
      });

      await expect(
        repository.findByRun({
          runType,
          runId: `${runType}-run`,
          project: 'Apex',
        })
      ).resolves.toEqual([
        expect.objectContaining({ runType, runId: `${runType}-run` }),
      ]);
    }
  );

  it('DoD-1 copies an active grounding by value into a separately scoped run', async () => {
    const repository = createRunGroundingRepository(
      new InMemoryRunGroundingStore(),
      {
        now: () => '2026-08-02T15:00:00.000Z',
      }
    );
    await repository.createGrounding(targetInput);

    const copied = await repository.copyGrounding(
      { runType: 'chat', runId: 'run-1', project: 'Apex' },
      { runType: 'service', runId: 'run-2', project: 'Apex' },
      'target'
    );

    expect(copied).toEqual(
      expect.objectContaining({
        runType: 'service',
        runId: 'run-2',
        project: 'Apex',
        groundedSha: 'target-sha',
        groundedAt: '2026-08-02T15:00:00.000Z',
      })
    );
  });

  it('TBI-004 DoD-1 copies the latest durable upstream pin after terminal deactivation', async () => {
    const repository = createRunGroundingRepository(
      new InMemoryRunGroundingStore(),
      {
        now: () => '2026-08-02T15:00:00.000Z',
      }
    );
    const source: RunRef = {
      runType: 'chat',
      runId: 'run-1',
      project: 'Apex',
    };
    await repository.createGrounding(targetInput);
    await repository.deactivateByRun(source);

    const copied = await repository.copyGrounding(
      source,
      { runType: 'chat', runId: 'design-doc-thread', project: 'Apex' },
      'target'
    );

    expect(copied).toEqual(
      expect.objectContaining({
        runType: 'chat',
        runId: 'design-doc-thread',
        groundedSha: 'target-sha',
        isActive: true,
      })
    );

    await expect(
      repository.reground(source, 'target', 'new-target-sha')
    ).resolves.toEqual(
      expect.objectContaining({
        runId: 'run-1',
        groundedSha: 'new-target-sha',
        isActive: true,
      })
    );
  });

  it('TBI-004 DoD-3 re-grounds from the newest groundedAt row when all history is inactive', async () => {
    const repository = createRunGroundingRepository(
      new InMemoryRunGroundingStore(),
      {
        now: () => '2026-08-02T17:00:00.000Z',
      }
    );
    const ref: RunRef = {
      runType: 'chat',
      runId: 'run-1',
      project: 'Apex',
    };
    for (const input of [
      {
        ...targetInput,
        repository: 'oldest-repo',
        groundedAt: '2026-08-02T14:00:00.000Z',
      },
      {
        ...targetInput,
        repository: 'newest-repo',
        groundedAt: '2026-08-02T16:00:00.000Z',
      },
      {
        ...targetInput,
        repository: 'middle-repo',
        groundedAt: '2026-08-02T15:00:00.000Z',
      },
    ]) {
      await repository.createGrounding(input);
      await repository.deactivateByRun(ref);
    }

    const replacement = await repository.reground(
      ref,
      'target',
      'replacement-sha'
    );
    const history = await repository.findByRun(ref);

    expect(replacement).toEqual(
      expect.objectContaining({
        repository: 'newest-repo',
        groundedSha: 'replacement-sha',
        isActive: true,
      })
    );
    expect(history).toHaveLength(4);
    expect(history.filter((row) => row.isActive)).toHaveLength(1);
  });

  it('DoD-1 exposes typed persistence failures without raw database details', async () => {
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const store = new InMemoryRunGroundingStore();
    store.insert = jest
      .fn()
      .mockRejectedValue(
        new Error(
          'duplicate key value violates unique constraint with sensitive detail'
        )
      );
    const repository = createRunGroundingRepository(store);

    const result = repository.createGrounding(targetInput);

    await expect(result).rejects.toBeInstanceOf(RunGroundingRepositoryError);
    await expect(result).rejects.toMatchObject({
      code: 'run_grounding_persistence_failed',
      operation: 'create',
      message: 'Run grounding create failed',
    });
    await expect(result).rejects.not.toThrow(/duplicate key|sensitive detail/i);
    expect(warn).toHaveBeenCalledWith(
      '[run-grounding] create persistence failed'
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringMatching(/duplicate key|sensitive detail/i)
    );
    warn.mockRestore();
  });

  it('DoD-1 / VT-06 re-grounds atomically while retaining inactive history', async () => {
    const repository = createRunGroundingRepository(
      new InMemoryRunGroundingStore(),
      {
        now: () => '2026-08-02T16:00:00.000Z',
      }
    );
    const ref: RunRef = { runType: 'chat', runId: 'run-1', project: 'Apex' };
    await repository.createGrounding(targetInput);

    const replacement = await repository.reground(
      ref,
      'target',
      'new-target-sha'
    );
    const history = await repository.findByRun(ref);

    expect(replacement).toEqual(
      expect.objectContaining({
        groundedSha: 'new-target-sha',
        groundedAt: '2026-08-02T16:00:00.000Z',
        isActive: true,
      })
    );
    expect(history).toHaveLength(2);
    expect(history.filter((row) => row.isActive)).toHaveLength(1);
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ groundedSha: 'target-sha', isActive: false }),
        expect.objectContaining({
          groundedSha: 'new-target-sha',
          isActive: true,
        }),
      ])
    );
  });

  it('DoD-1 deactivates a run without deleting its target or skill history', async () => {
    const repository = createRunGroundingRepository(
      new InMemoryRunGroundingStore()
    );
    const ref: RunRef = { runType: 'chat', runId: 'run-1', project: 'Apex' };
    await repository.createGrounding(targetInput);
    await repository.createGrounding({
      ...targetInput,
      repoRole: 'skill',
      groundedSha: 'skill-sha',
    });

    await expect(repository.deactivateByRun(ref)).resolves.toBe(2);
    const history = await repository.findByRun(ref);
    expect(history).toHaveLength(2);
    expect(history.every((row) => !row.isActive)).toBe(true);
  });

  it('VT-04 scopes copy, query, re-ground, and deactivate by run type, id, and project', async () => {
    const repository = createRunGroundingRepository(
      new InMemoryRunGroundingStore()
    );
    await repository.createGrounding(targetInput);
    const wrongScope: RunRef = {
      runType: 'chat',
      runId: 'run-1',
      project: 'Other Project',
    };

    await expect(repository.findByRun(wrongScope)).resolves.toEqual([]);
    await expect(
      repository.copyGrounding(
        wrongScope,
        { runType: 'service', runId: 'run-2', project: 'Apex' },
        'target'
      )
    ).resolves.toBeNull();
    await expect(
      repository.reground(wrongScope, 'target', 'hidden-sha')
    ).resolves.toBeNull();
    await expect(repository.deactivateByRun(wrongScope)).resolves.toBe(0);
    await expect(
      repository.findByRun({
        runType: 'chat',
        runId: 'run-1',
        project: 'Apex',
      })
    ).resolves.toEqual([
      expect.objectContaining({ groundedSha: 'target-sha', isActive: true }),
    ]);
  });

  it('NFR-active-index queries only active rows for a repository branch', async () => {
    const repository = createRunGroundingRepository(
      new InMemoryRunGroundingStore()
    );
    const ref: RunRef = { runType: 'chat', runId: 'run-1', project: 'Apex' };
    await repository.createGrounding(targetInput);
    await repository.deactivateByRun(ref);
    await repository.createGrounding({
      ...targetInput,
      runId: 'run-2',
      groundedSha: 'active-sha',
    });

    await expect(
      repository.findActiveByRepoBranch({
        provider: 'github',
        project: 'Apex',
        repository: 'ASM/AI-Pilot',
        branch: 'main',
      })
    ).resolves.toEqual([
      expect.objectContaining({
        runId: 'run-2',
        groundedSha: 'active-sha',
        isActive: true,
      }),
    ]);
  });
});

describe('run_groundings migration contract', () => {
  const migrationsDir = path.resolve(__dirname, '../../../migrations');
  const migrationNames = fs.existsSync(migrationsDir)
    ? fs
        .readdirSync(migrationsDir)
        .filter((name) => /_run-groundings\.sql$/.test(name))
    : [];
  const migrationSql =
    migrationNames.length === 1
      ? fs.readFileSync(path.join(migrationsDir, migrationNames[0]), 'utf8')
      : '';
  const [upSql = '', downSql = ''] = migrationSql.split(/-- Down Migration/i);

  it('DoD-0 creates the table and required unique and lookup constraints', () => {
    expect(migrationNames).toHaveLength(1);
    expect(upSql).toMatch(/CREATE TABLE run_groundings/i);
    expect(upSql).toMatch(
      /CREATE INDEX idx_run_groundings_run_lookup\s+ON run_groundings\s*\(run_type,\s*run_id\)/i
    );
    expect(upSql).toMatch(
      /CREATE INDEX idx_run_groundings_active_repo_branch\s+ON run_groundings\s*\(provider,\s*project,\s*repository,\s*branch\)\s+WHERE is_active/i
    );
    expect(upSql).toMatch(
      /CREATE UNIQUE INDEX uq_run_groundings_active_run_role\s+ON run_groundings\s*\(run_type,\s*run_id,\s*repo_role\)\s+WHERE is_active/i
    );
  });

  it('NFR-active-index makes repository and branch lookup partial on active rows', () => {
    expect(upSql).toMatch(
      /CREATE INDEX idx_run_groundings_active_repo_branch[\s\S]*?WHERE is_active\s*;/i
    );
  });

  it('NFR-join-free uses a polymorphic TEXT run key with no domain foreign key', () => {
    expect(upSql).toMatch(/run_type\s+TEXT\s+NOT NULL/i);
    expect(upSql).toMatch(/run_id\s+TEXT\s+NOT NULL/i);
    expect(upSql).not.toMatch(/\bREFERENCES\b/i);
  });

  it('DoD-3 / VT-08 down drops only the new grounding table', () => {
    const dropStatements =
      downSql.match(/\bDROP\s+(?:TABLE|INDEX)\b[^;]*;/gi) ?? [];
    expect(dropStatements).toEqual([
      expect.stringMatching(/DROP TABLE(?: IF EXISTS)? run_groundings\s*;/i),
    ]);
  });
});
