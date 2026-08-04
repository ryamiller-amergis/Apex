import {
  parseWalkthroughAnchorDiscoveryOutput,
  WalkthroughAnchorDiscoveryError,
} from '../../shared/types/walkthroughAnchorDiscovery';

describe('parseWalkthroughAnchorDiscoveryOutput', () => {
  it('parses a valid discovery proposal payload', () => {
    const result = parseWalkthroughAnchorDiscoveryOutput(
      JSON.stringify({
        proposals: [
          {
            testId: 'profile-edit-bio',
            anchorKey: 'profile-edit-bio',
            label: 'Edit bio',
            suggestedRoute: '/profile',
            allowedPlacements: ['bottom'],
            smartTags: ['profile', 'edit', 'button'],
            sourceLocations: [{ filePath: 'src/client/components/ProfilePage.tsx', line: 42 }],
            confidence: 0.88,
            rationale: 'Matches edit bio control on ProfilePage',
          },
        ],
      }),
    );
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].anchorKey).toBe('profile-edit-bio');
  });

  it('rejects invalid JSON', () => {
    expect(() => parseWalkthroughAnchorDiscoveryOutput('{')).toThrow(
      WalkthroughAnchorDiscoveryError,
    );
  });
});
