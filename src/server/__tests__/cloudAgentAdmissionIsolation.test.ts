import fs from 'node:fs';
import path from 'node:path';

describe('VT-10 Cloud Agent runs stay out of background admission', () => {
  it('keeps admission SQL scoped to lane = background', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/server/services/admissionGovernorService.ts'),
      'utf8',
    );
    expect(source).toMatch(/const BACKGROUND_LANE = 'background'/);
    expect(source).toMatch(/WHERE lane = \$\{BACKGROUND_LANE\}/);
    expect(source).not.toMatch(/cloud-agent/);
  });
});
