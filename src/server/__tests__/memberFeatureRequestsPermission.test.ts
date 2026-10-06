import fs from 'fs';
import path from 'path';

describe('member feature-requests:view migration', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '../../../migrations/20260930120000_member-feature-requests-view.sql'),
    'utf8',
  );

  it('grants Apex Backlog view to the member role', () => {
    expect(sql).toMatch(/r\.name = 'member'/);
    expect(sql).toMatch(/p\.key = 'feature-requests:view'/);
    expect(sql).toMatch(/INSERT INTO app_role_permissions/);
  });

  it('removes only that grant on the way down', () => {
    const down = sql.split('-- Down Migration')[1] ?? '';
    expect(down).toMatch(/name = 'member'/);
    expect(down).toMatch(/key = 'feature-requests:view'/);
    expect(down).not.toMatch(/INSERT INTO app_permissions/);
  });

  it('takes the grant back off the member role so existing projects are unchanged', () => {
    const revert = fs.readFileSync(
      path.join(__dirname, '../../../migrations/20260930133000_revert-member-feature-requests-view.sql'),
      'utf8',
    );
    const up = revert.split('-- Down Migration')[0] ?? '';
    expect(up).toMatch(/DELETE FROM app_role_permissions/);
    expect(up).toMatch(/name = 'member'/);
    expect(up).toMatch(/key = 'feature-requests:view'/);
  });
});
