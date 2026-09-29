jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    delete: jest.fn(),
  },
}));

import { db } from '../db/drizzle';
import {
  addDevEnvAllowlistEntry,
  clearDevEnvAllowlistCache,
  getDevEnvAllowlistView,
  isDevEnvironmentAllowed,
  removeDevEnvAllowlistEntry,
} from '../services/devEnvAllowlistService';

const mockDb = db as jest.Mocked<typeof db>;

const entry = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'person@example.com',
  createdBy: 'Ada',
  createdAt: '2026-09-28T12:00:00.000Z',
};

function mockList(rows: typeof entry[]) {
  const orderBy = jest.fn().mockResolvedValue(rows);
  const from = jest.fn().mockReturnValue({ orderBy });
  mockDb.select.mockReturnValue({ from } as never);
  return { from, orderBy };
}

describe('devEnvAllowlistService', () => {
  const originalAppEnv = process.env.APP_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    clearDevEnvAllowlistCache();
    process.env.APP_ENV = 'dev';
  });

  afterEach(() => {
    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
  });

  describe('isDevEnvironmentAllowed', () => {
    it('allows everyone outside the dev site', async () => {
      process.env.APP_ENV = 'prod';
      await expect(isDevEnvironmentAllowed('person@example.com')).resolves.toBe(true);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('allows the automated test account on the dev site without reading the list', async () => {
      const originalTestUser = process.env.E2E_TEST_USER;
      process.env.E2E_TEST_USER = 'apex-e2e-test@amergis.com';
      mockDb.select.mockImplementation(() => {
        throw new Error('db down');
      });
      try {
        await expect(isDevEnvironmentAllowed('Apex-E2E-Test@amergis.com')).resolves.toBe(true);
        expect(mockDb.select).not.toHaveBeenCalled();
      } finally {
        if (originalTestUser === undefined) delete process.env.E2E_TEST_USER;
        else process.env.E2E_TEST_USER = originalTestUser;
      }
    });

    it('allows platform admins on the dev site without reading the list', async () => {
      mockDb.select.mockImplementation(() => {
        throw new Error('db down');
      });
      await expect(isDevEnvironmentAllowed('anedunur@amergis.com')).resolves.toBe(true);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('allows an email that is on the list', async () => {
      mockList([entry]);
      await expect(isDevEnvironmentAllowed('Person@Example.com')).resolves.toBe(true);
    });

    it('denies an email that is not on the list', async () => {
      mockList([]);
      await expect(isDevEnvironmentAllowed('other@example.com')).resolves.toBe(false);
      await expect(isDevEnvironmentAllowed('')).resolves.toBe(false);
    });

    it('denies non-admins when the list cannot be read', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockDb.select.mockImplementation(() => {
        throw new Error('db down');
      });
      await expect(isDevEnvironmentAllowed('person@example.com')).resolves.toBe(false);
      errorSpy.mockRestore();
    });

    it('reuses the list for a short time, then reads again after a change', async () => {
      mockList([entry]);
      await isDevEnvironmentAllowed('person@example.com');
      await isDevEnvironmentAllowed('person@example.com');
      expect(mockDb.select).toHaveBeenCalledTimes(1);

      const returning = jest.fn().mockResolvedValue([{
        ...entry,
        id: '22222222-2222-2222-2222-222222222222',
        email: 'new@example.com',
      }]);
      const values = jest.fn().mockReturnValue({ returning });
      mockDb.insert.mockReturnValue({ values } as never);
      await addDevEnvAllowlistEntry('new@example.com', 'Ada');

      mockList([entry]);
      await isDevEnvironmentAllowed('person@example.com');
      expect(mockDb.select).toHaveBeenCalledTimes(2);
    });
  });

  describe('getDevEnvAllowlistView', () => {
    it('reports that the list controls access only on the dev site', async () => {
      mockList([entry]);
      await expect(getDevEnvAllowlistView()).resolves.toEqual({
        environment: 'dev',
        managesDevAccess: true,
        entries: [entry],
      });

      clearDevEnvAllowlistCache();
      process.env.APP_ENV = 'local';
      mockList([]);
      await expect(getDevEnvAllowlistView()).resolves.toMatchObject({
        environment: 'local',
        managesDevAccess: false,
      });
    });
  });

  describe('addDevEnvAllowlistEntry', () => {
    it('stores a normalized email on the dev site', async () => {
      const returning = jest.fn().mockResolvedValue([{ ...entry, email: 'new@example.com' }]);
      const values = jest.fn().mockReturnValue({ returning });
      mockDb.insert.mockReturnValue({ values } as never);

      const saved = await addDevEnvAllowlistEntry('  New@Example.com ', 'Ada');

      expect(values).toHaveBeenCalledWith({ email: 'new@example.com', createdBy: 'Ada' });
      expect(saved.email).toBe('new@example.com');
    });

    it('rejects an invalid email, a platform admin, a duplicate, and changes off the dev site', async () => {
      await expect(addDevEnvAllowlistEntry('not-an-email', 'Ada')).rejects.toThrow('valid email');
      await expect(addDevEnvAllowlistEntry('anedunur@amergis.com', 'Ada')).rejects.toThrow(
        'already have access',
      );

      const returning = jest.fn().mockRejectedValue({ code: '23505' });
      const values = jest.fn().mockReturnValue({ returning });
      mockDb.insert.mockReturnValue({ values } as never);
      await expect(addDevEnvAllowlistEntry('person@example.com', 'Ada')).rejects.toThrow(
        'already on the dev access list',
      );

      process.env.APP_ENV = 'prod';
      await expect(addDevEnvAllowlistEntry('person@example.com', 'Ada')).rejects.toThrow(
        'only be changed on the dev site',
      );
    });
  });

  describe('removeDevEnvAllowlistEntry', () => {
    it('removes a row on the dev site', async () => {
      const returning = jest.fn().mockResolvedValue([{ id: entry.id }]);
      const where = jest.fn().mockReturnValue({ returning });
      mockDb.delete.mockReturnValue({ where } as never);

      await removeDevEnvAllowlistEntry(entry.id);
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
    });

    it('rejects a missing row, a bad id, and changes off the dev site', async () => {
      const returning = jest.fn().mockResolvedValue([]);
      const where = jest.fn().mockReturnValue({ returning });
      mockDb.delete.mockReturnValue({ where } as never);

      await expect(removeDevEnvAllowlistEntry(entry.id)).rejects.toThrow('not found');
      await expect(removeDevEnvAllowlistEntry('nope')).rejects.toThrow('not found');
      expect(mockDb.delete).toHaveBeenCalledTimes(1);

      process.env.APP_ENV = 'local';
      await expect(removeDevEnvAllowlistEntry(entry.id)).rejects.toThrow(
        'only be changed on the dev site',
      );
    });
  });
});
