import fs from 'node:fs';
import path from 'node:path';
import { isWalkthroughRoute } from '../../shared/walkthroughRoutes';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260930183000_seed-why-apex-guided-walkthrough.sql'
);

describe('Why Apex guided walkthrough migration', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  it('seeds a dismissible draft for the Apex project without duplicating it', () => {
    expect(sql).toContain("'why-apex-guided-tour'");
    expect(sql).toMatch(
      /IF EXISTS \([\s\S]*internal_name = 'why-apex-guided-tour'[\s\S]*RETURN;/i
    );
    expect(sql).toMatch(/'draft',\s+80,\s+FALSE,\s+1/i);
    expect(sql).toMatch(/'project',\s+'Apex'/i);
    expect(sql).toMatch(
      /DELETE FROM walkthroughs\s+WHERE id = '3f493b4c-7ad6-4aa5-a951-98c6ab0bd8aa'/i
    );
  });

  it('contains eight ordered steps over curated application routes', () => {
    const stepOrdinals = [
      ...sql.matchAll(/\(\s+v_walkthrough_id,\s+(\d+),/g),
    ].map((match) => Number(match[1]));

    expect(stepOrdinals).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    const inAppPaths = [...sql.matchAll(/'(\/[^']+)'/g)]
      .map((match) => match[1])
      .filter((route) => !route.startsWith('/brand-'));

    expect(inAppPaths.length).toBeGreaterThan(0);
    expect(inAppPaths.every((route) => isWalkthroughRoute(route))).toBe(true);
  });

  it('grounds the story in current Apex capabilities and team judgment', () => {
    expect(sql).toContain('Agent Home');
    expect(sql).toContain('design interview');
    expect(sql).toContain('structured PRD and backlog');
    expect(sql).toContain('Interactive design prototypes');
    expect(sql).toContain('Design documents');
    expect(sql).toContain('Project admins can choose skill paths and models');
    expect(sql).toContain('The goal is not to replace team judgment');
  });
});
