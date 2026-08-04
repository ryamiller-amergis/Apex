import fs from 'node:fs';
import path from 'node:path';

describe('TBI-004 scratch workspace lifecycle contract', () => {
  it.each(['prdService.ts', 'designDocService.ts'])(
    'DoD-2 keeps normal scratch cleanup in %s after grounding deactivation',
    (serviceFile) => {
      // Arrange
      const source = fs.readFileSync(
        path.resolve(__dirname, `../services/${serviceFile}`),
        'utf8',
      );

      // Act / Assert
      expect(source).not.toMatch(
        /preserveGroundedWorkspace|workspaceOwnedByIdleCleanup/,
      );
      expect(source).toMatch(/fs\.rmSync\(row\.workspaceDir/);
    },
  );
});
