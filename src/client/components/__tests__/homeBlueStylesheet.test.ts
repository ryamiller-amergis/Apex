/**
 * FEAT-001 stylesheet contracts — CSS modules are mocked via identity-obj-proxy
 * in Jest, so color assertions read the source stylesheets directly.
 */
import fs from 'fs';
import path from 'path';

const agentHomeCss = fs.readFileSync(
  path.join(__dirname, '../AgentHome.module.css'),
  'utf8',
);
const appCss = fs.readFileSync(
  path.join(__dirname, '../../App.css'),
  'utf8',
);

function blockFor(css: string, selector: string): string {
  const re = new RegExp(`${selector.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`, 'm');
  const match = css.match(re);
  if (!match) {
    throw new Error(`Selector ${selector} not found in stylesheet`);
  }
  return match[1];
}

describe('FEAT-001 Home blue stylesheet contracts', () => {
  it('DoD-0: .page background is hard #2563EB (not --bg-primary)', () => {
    const block = blockFor(agentHomeCss, '.page');
    expect(block).toMatch(/background:\s*#2563EB/);
    expect(block).not.toMatch(/var\(--bg-primary\)/);
  });

  it('DoD-3: empty-state primary uses #FFFFFF', () => {
    expect(blockFor(agentHomeCss, '.composeLogo')).toMatch(/color:\s*#FFFFFF/);
    expect(blockFor(agentHomeCss, '.composeHeading')).toMatch(/color:\s*#FFFFFF/);
  });

  it('DoD-3: empty-state secondary uses #E2E8F0', () => {
    expect(blockFor(agentHomeCss, '.hint')).toMatch(/color:\s*#E2E8F0/);
    expect(blockFor(agentHomeCss, '.pillDescription')).toMatch(/color:\s*#E2E8F0/);
  });

  it('DoD-4: skill pills and composer retain themed token surfaces', () => {
    expect(blockFor(agentHomeCss, '.pill')).toMatch(/var\(--bg-secondary\)/);
    expect(blockFor(agentHomeCss, '.inputBox')).toMatch(/var\(--bg-secondary\)/);
  });

  it('DoD-1: .app-header--home uses #2563EB background and light brand text', () => {
    const homeHeader = blockFor(appCss, '.app-header--home');
    expect(homeHeader).toMatch(/background:\s*#2563EB/);
    expect(blockFor(appCss, '.app-header--home .app-brand')).toMatch(/color:\s*#FFFFFF/);
    expect(blockFor(appCss, '.app-header--home .app-brand-text')).toMatch(/color:\s*#FFFFFF/);
  });

  it('DoD-2: default .app-header still uses theme --bg-secondary', () => {
    const header = blockFor(appCss, '.app-header');
    expect(header).toMatch(/background:\s*var\(--bg-secondary\)/);
  });

  it('BR-001: global --bg-primary token definition is not reassigned to #2563EB in AgentHome', () => {
    expect(agentHomeCss).not.toMatch(/--bg-primary\s*:\s*#2563EB/);
  });
});
