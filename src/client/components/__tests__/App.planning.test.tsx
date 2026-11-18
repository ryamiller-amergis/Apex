import * as fs from 'fs';
import * as path from 'path';

const readWorkspaceFile = (relativePath: string) => {
  const fullPath = path.join(process.cwd(), relativePath);
  return fs.readFileSync(fullPath, 'utf8');
};

describe('Planning workspace structure (static checks)', () => {
  it('App.tsx uses Planning and planningTab with only roadmap and releases sub-tabs', () => {
    const content = readWorkspaceFile('src/client/App.tsx');

    expect(content).toContain("'planning'");
    expect(content).toContain('Planning');
    expect(content).toContain('planningTab');
    expect(content).toContain("'roadmap'");
    expect(content).toContain("'releases'");

    // Legacy analytics identifiers and obsolete Planning sub-tabs are removed
    expect(content).not.toContain("'analytics'");
    expect(content).not.toContain('analyticsTab');
    expect(content).not.toContain("'dev-stats'");
    expect(content).not.toContain("'ai-analysis'");
    expect(content).not.toContain('planning:devstats');
    expect(content).not.toContain('planning:ai-analysis');
  });

  it('PlanningTabs.tsx renders only Roadmap and Releases tab definitions', () => {
    const content = readWorkspaceFile('src/client/components/PlanningTabs.tsx');

    expect(content).toContain('Roadmap');
    expect(content).toContain('Releases');
    expect(content).not.toContain('Developer Stats');
    expect(content).not.toContain('QA Metrics');
    expect(content).not.toContain('AI Analysis');
  });

  it('App.css uses planning-* classes (not analytics-*)', () => {
    const content = readWorkspaceFile('src/client/App.css');

    expect(content).toContain('.planning-view');
    expect(content).toContain('.planning-tabs');
    expect(content).toContain('.planning-content');

    expect(content).not.toContain('.analytics-view');
    expect(content).not.toContain('.analytics-tabs');
    expect(content).not.toContain('.analytics-content');
  });
});
