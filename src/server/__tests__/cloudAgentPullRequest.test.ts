import { buildCloudAgentPullRequestText } from '../services/cloudAgentPullRequest';

describe('buildCloudAgentPullRequestText', () => {
  it('includes the work item, branch, starter, and implementation summary', () => {
    const text = buildCloudAgentPullRequestText({
      workItemId: 42,
      workItemTitle: 'Implement login',
      authorName: 'Jane Developer',
      authorEmail: 'jane@example.com',
      sourceBranch: 'feature/apex-42-abc',
      summary: 'Added the login form.',
    });

    expect(text.title).toBe('AB#42: Implement login');
    expect(text.description).toContain('Work item: AB#42 — Implement login');
    expect(text.description).toContain('Branch: feature/apex-42-abc');
    expect(text.description).toContain('Started by: Jane Developer (jane@example.com)');
    expect(text.description).toContain('Added the login form.');
  });

  it('omits the starter line when the run has no developer name', () => {
    const text = buildCloudAgentPullRequestText({
      workItemId: 7,
      sourceBranch: 'feature/apex-7-abc',
    });

    expect(text.title).toBe('AB#7');
    expect(text.description).not.toContain('Started by:');
    expect(text.description).not.toContain('## Implementation summary');
  });
});
