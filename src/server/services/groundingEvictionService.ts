import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { RunGrounding } from '../../shared/types/runGrounding';
import { resolveDataRoot } from '../utils/dataDir';
import { resolveRunGroundingWorkspacePath } from './runGroundingMaterializer';
import { runGroundingRepository } from './runGroundingRepository';
import { trackEvent } from './telemetry';

export const GROUNDING_WORKSPACE_IDLE_TTL_MS = 30 * 60 * 1000;

export interface GroundingEvictionResult {
  scanned: number;
  evicted: number;
  protected: number;
}

export interface GroundingEvictionService {
  evictIdle(): Promise<GroundingEvictionResult>;
}

export interface GroundingEvictionDependencies {
  dataRoot?: string;
  now?: () => number;
  listActiveGroundings?: () => Promise<RunGrounding[]>;
  telemetry?: typeof trackEvent;
}

export function createGroundingEvictionService(
  dependencies: GroundingEvictionDependencies = {},
): GroundingEvictionService {
  const dataRoot = dependencies.dataRoot ?? resolveDataRoot();
  const now = dependencies.now ?? Date.now;
  const listActiveGroundings =
    dependencies.listActiveGroundings ??
    (() => runGroundingRepository.listActiveGroundings());
  const telemetry = dependencies.telemetry ?? trackEvent;
  const workspacesRoot = path.join(dataRoot, 'workspaces', 'grounding');

  return {
    async evictIdle() {
      const activeGroundings = await listActiveGroundings();
      const protectedNames = new Set(
        activeGroundings.map((grounding) =>
          path.basename(
            resolveRunGroundingWorkspacePath(
              grounding,
              grounding,
              dataRoot,
            ),
          ),
        ),
      );
      const result: GroundingEvictionResult = {
        scanned: 0,
        evicted: 0,
        protected: 0,
      };
      let entries: Dirent[];
      try {
        entries = await fs.readdir(workspacesRoot, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
        throw error;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        result.scanned += 1;
        if (protectedNames.has(entry.name)) {
          result.protected += 1;
          continue;
        }
        const workspace = path.join(workspacesRoot, entry.name);
        try {
          const stats = await fs.stat(workspace);
          if (now() - stats.atimeMs <= GROUNDING_WORKSPACE_IDLE_TTL_MS) {
            continue;
          }
          await fs.rm(workspace, { recursive: true, force: true });
          result.evicted += 1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }

      telemetry(
        'grounding.workspace.eviction',
        {},
        {
          scanned: result.scanned,
          evicted: result.evicted,
          protected: result.protected,
        },
      );
      return result;
    },
  };
}

export const groundingEvictionService = createGroundingEvictionService();
