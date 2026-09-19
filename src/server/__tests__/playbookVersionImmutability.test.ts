/**
 * TBI-011 DoD-2 — a published version's content cannot be edited through the application layer.
 *
 * Covers VT-03 and VT-04.
 *
 * This is the half of BR-006 the database deliberately does not enforce: expressing "no column may
 * change once status is published, except status" as a constraint means a trigger, and a trigger
 * puts business logic somewhere reviewers do not look. The rule lives in the service, so it is only
 * real if a test says so.
 */
jest.mock('../db/drizzle', () => {
  const setMock = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
  return {
    db: {
      query: { playbookDefinitionVersions: { findFirst: jest.fn() } },
      update: jest.fn().mockReturnValue({ set: setMock }),
    },
  };
});

import { db } from '../db/drizzle';
import type { PlaybookGraph, PlaybookVersionStatus } from '../../shared/types/playbook';
import {
  assertContentMutable,
  assertLifecycleTransition,
  moveVersionLifecycle,
  PlaybookVersionImmutableError,
  PlaybookVersionNotFoundError,
  PlaybookVersionTransitionError,
  publishVersion,
  updateVersionGraph,
} from '../services/playbookDefinitionService';

const mockFindFirst = db.query.playbookDefinitionVersions.findFirst as jest.Mock;
const mockUpdate = db.update as jest.Mock;

const VERSION_ID = 'ver-1';
const GRAPH: PlaybookGraph = {
  nodes: [{ id: 'step-1', stepType: 'notify' }],
  edges: [],
};

/** The status the service will read for the version under test. */
function versionIs(status: PlaybookVersionStatus | null): void {
  mockFindFirst.mockResolvedValue(status === null ? undefined : { status });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('VT-03 — editing a published version is rejected', () => {
  it('refuses a graph update on a published version, naming immutability', async () => {
    versionIs('published');

    await expect(updateVersionGraph(VERSION_ID, GRAPH)).rejects.toThrow(
      PlaybookVersionImmutableError
    );
    await expect(updateVersionGraph(VERSION_ID, GRAPH)).rejects.toThrow(/immutable/i);
  });

  it('writes nothing when it refuses', async () => {
    versionIs('published');

    await expect(updateVersionGraph(VERSION_ID, GRAPH)).rejects.toThrow();
    // The guard has to run before the update, not alongside it.
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('refuses on deprecated and archived versions too', async () => {
    for (const status of ['deprecated', 'archived'] as const) {
      versionIs(status);
      await expect(updateVersionGraph(VERSION_ID, GRAPH)).rejects.toThrow(
        PlaybookVersionImmutableError
      );
    }
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('allows a graph update while the version is still a draft', async () => {
    versionIs('draft');

    await expect(updateVersionGraph(VERSION_ID, GRAPH)).resolves.toBeUndefined();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('reports a missing version rather than silently doing nothing', async () => {
    versionIs(null);

    await expect(updateVersionGraph(VERSION_ID, GRAPH)).rejects.toThrow(
      PlaybookVersionNotFoundError
    );
  });
});

describe('VT-04 — lifecycle status is the one thing that still moves', () => {
  it('moves a published version to deprecated, then archived', async () => {
    versionIs('published');
    await expect(moveVersionLifecycle(VERSION_ID, 'deprecated')).resolves.toBeUndefined();

    versionIs('deprecated');
    await expect(moveVersionLifecycle(VERSION_ID, 'archived')).resolves.toBeUndefined();

    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });

  it('publishes a draft', async () => {
    versionIs('draft');

    await expect(publishVersion(VERSION_ID, 'user-oid-1')).resolves.toBeUndefined();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  /*
   * The escape hatch that would make immutability decorative: unpublish, edit, republish. Refusing
   * the first move is what closes it, so this is the assertion that matters most in the file.
   */
  it('refuses to move a published version back to draft', async () => {
    versionIs('published');

    await expect(moveVersionLifecycle(VERSION_ID, 'draft')).rejects.toThrow(
      PlaybookVersionTransitionError
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('refuses to revive an archived version', async () => {
    versionIs('archived');

    for (const next of ['draft', 'published', 'deprecated'] as const) {
      await expect(moveVersionLifecycle(VERSION_ID, next)).rejects.toThrow(
        PlaybookVersionTransitionError
      );
    }
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('refuses to publish an already published version', async () => {
    versionIs('published');

    await expect(publishVersion(VERSION_ID, 'user-oid-1')).rejects.toThrow(
      PlaybookVersionTransitionError
    );
  });
});

describe('the rules themselves', () => {
  // Asserted directly as well as through the service, because these are the statements the rest of
  // the Feature relies on and a mocked service call is an indirect way to read them.
  it('treats draft as the only content-mutable status', () => {
    expect(() => assertContentMutable(VERSION_ID, 'draft')).not.toThrow();
    for (const status of ['published', 'deprecated', 'archived'] as const) {
      expect(() => assertContentMutable(VERSION_ID, status)).toThrow(PlaybookVersionImmutableError);
    }
  });

  it('permits exactly the forward lifecycle moves', () => {
    const legal: Array<[PlaybookVersionStatus, PlaybookVersionStatus]> = [
      ['draft', 'published'],
      ['published', 'deprecated'],
      ['published', 'archived'],
      ['deprecated', 'archived'],
    ];
    for (const [from, to] of legal) {
      expect(() => assertLifecycleTransition(from, to)).not.toThrow();
    }

    const illegal: Array<[PlaybookVersionStatus, PlaybookVersionStatus]> = [
      ['published', 'draft'],
      ['deprecated', 'published'],
      ['archived', 'draft'],
      ['draft', 'archived'],
    ];
    for (const [from, to] of illegal) {
      expect(() => assertLifecycleTransition(from, to)).toThrow(PlaybookVersionTransitionError);
    }
  });
});
