import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compose,
  composeManaged,
  composeAdapter,
  split,
  splitZones,
  splice,
  spliceAdapter,
  hashManaged,
  hasFence,
  hasAdapterFence,
  inspectFences,
  END_MARKER,
  ADAPTER_END_MARKER,
} from '../lib/managedRegion.mjs';
import { normalizeText } from '../lib/util.mjs';

const FOUNDATION = `---
name: grill-with-docs
description: Foundation description.
---

# Grill With Docs — Foundation

Ask one question at a time.
`;

const ADAPTER = `---
name: grill-with-docs
description: Adapter description.
---

# grill-with-docs — Project Adapter

- Project: Acme
`;

describe('managedRegion', () => {
  it('compose produces three zones: foundation fence, adapter zone, project notes', () => {
    const out = compose(FOUNDATION, ADAPTER, 'grill-with-docs', '1.1.0');
    assert.ok(out.startsWith('---\nname: grill-with-docs\n'));
    assert.ok(out.includes('<!-- APEX:BEGIN managed (grill-with-docs @ 1.1.0) -->'));
    assert.ok(out.includes(END_MARKER));
    assert.ok(out.includes('<!-- APEX:BEGIN adapter (grill-with-docs @ 1.1.0) -->'));
    assert.ok(out.includes(ADAPTER_END_MARKER));
    assert.ok(out.includes('# Grill With Docs — Foundation'));
    assert.ok(out.includes('# grill-with-docs — Project Adapter'));
    assert.ok(out.includes('## Project notes'));
    // Foundation zone must NOT contain adapter body
    const z = splitZones(out);
    assert.ok(z.managed.includes('# Grill With Docs — Foundation'));
    assert.ok(!z.managed.includes('# grill-with-docs — Project Adapter'));
    assert.ok(z.adapter.includes('# grill-with-docs — Project Adapter'));
    assert.ok(!z.adapter.includes('# Grill With Docs — Foundation'));
    // Frontmatter from foundation wins
    assert.ok(out.includes('description: Foundation description.'));
  });

  it('splitZones round-trips all three parts', () => {
    const out = compose(FOUNDATION, ADAPTER, 'grill-with-docs', '1.1.0');
    const z = splitZones(out);
    assert.equal(z.hasFence, true);
    assert.equal(z.hasAdapterFence, true);
    assert.ok(z.managed.includes(END_MARKER));
    assert.ok(z.adapter.includes(ADAPTER_END_MARKER));
    assert.ok(z.project.includes('## Project notes'));
  });

  it('splice foundation preserves adapter + project notes', () => {
    const original = compose(FOUNDATION, ADAPTER, 'grill-with-docs', '1.0.0');
    const edited = original.replace(
      '<!-- Yours. APEX never writes below this line. -->\n',
      '<!-- Yours. APEX never writes below this line. -->\n\nMaxView asks about PHI first.\n',
    );
    const newFoundation = composeManaged(
      FOUNDATION.replace('Ask one question at a time.', 'Ask relentlessly.'),
      '',
      'grill-with-docs',
      '1.1.0',
    );
    const next = splice(edited, newFoundation, null);
    assert.ok(next.includes('Ask relentlessly.'));
    assert.ok(next.includes('MaxView asks about PHI first.'));
    assert.ok(next.includes('# grill-with-docs — Project Adapter'));
    assert.ok(!next.includes('Ask one question at a time.'));
  });

  it('splice foundation replaces foundation frontmatter and preserves the project-owned tail', () => {
    const original = compose(FOUNDATION, ADAPTER, 'grill-with-docs', '1.0.0');
    const edited = original
      .replace('description: Foundation description.', 'description: Team changed this.')
      .replace(
        '<!-- APEX:END adapter -->',
        'TEAM_OWNED_FREEFORM\n<!-- APEX:END adapter -->',
      );
    const before = splitZones(edited);
    const nextFoundation = composeManaged(
      FOUNDATION.replace('Foundation description.', 'Updated foundation description.'),
      '',
      'grill-with-docs',
      '2.0.0',
    );

    const next = splice(edited, nextFoundation, null);
    const after = splitZones(next);

    assert.match(next, /description: Updated foundation description\./);
    assert.doesNotMatch(next, /description: Team changed this\./);
    assert.equal(after.adapter + after.project, before.adapter + before.project);
    assert.match(next, /TEAM_OWNED_FREEFORM/);
  });

  it('spliceAdapter refreshes adapter only — foundation and project notes survive', () => {
    const original = compose(FOUNDATION, ADAPTER, 'grill-with-docs', '1.0.0');
    let edited = original.replace(
      '<!-- Yours. APEX never writes below this line. -->\n',
      '<!-- Yours. APEX never writes below this line. -->\n\nPROJECT_TAIL\n',
    );
    edited = edited.replace('Ask one question at a time.', 'FOUNDATION_CUSTOM');
    const newAdapter = composeAdapter(
      ADAPTER.replace('Project: Acme', 'Project: MatterWorx'),
      'grill-with-docs',
      '1.1.0',
    );
    const next = spliceAdapter(edited, newAdapter);
    assert.ok(next.includes('FOUNDATION_CUSTOM'), 'foundation body must survive bootstrap');
    assert.ok(next.includes('PROJECT_TAIL'), 'project notes must survive bootstrap');
    assert.ok(next.includes('Project: MatterWorx'));
    assert.ok(!next.includes('Project: Acme'));
  });

  it('splice returns null when fence is missing', () => {
    const noFence = '# Hand-written skill\n\nTeam owns everything.\n';
    const result = splice(noFence, composeManaged(FOUNDATION, '', 'x', '1.0.0'));
    assert.equal(result, null);
    assert.equal(hasFence(noFence), false);
  });

  it('hashManaged ignores adapter and project-note edits', () => {
    const original = compose(FOUNDATION, ADAPTER, 'grill-with-docs', '1.0.0');
    const h1 = hashManaged(original);
    assert.ok(h1);

    const below = original + '\nExtra project note.\n';
    assert.equal(hashManaged(below), h1);

    const adapterEdited = original.replace('Project: Acme', 'Project: Other');
    assert.equal(hashManaged(adapterEdited), h1);

    const foundationEdited = original.replace('Ask one question at a time.', 'Edited inside fence.');
    assert.notEqual(hashManaged(foundationEdited), h1);

    const frontmatterEdited = original.replace(
      'description: Foundation description.',
      'description: Locally changed trigger.',
    );
    assert.notEqual(hashManaged(frontmatterEdited), h1);
  });

  it('handles CRLF input via normalizeText', () => {
    const crlf = FOUNDATION.replace(/\n/g, '\r\n');
    const out = compose(crlf, ADAPTER.replace(/\n/g, '\r\n'), 'grill-with-docs', '1.1.0');
    assert.equal(out.includes('\r'), false);
    assert.equal(out, normalizeText(out));
    assert.equal(hasAdapterFence(out), true);
    const { hasFence: fenced } = split(out.replace(/\n/g, '\r\n'));
    assert.equal(fenced, true);
  });

  it('split reports hasFence=false for unfenced files', () => {
    const { managed, project, hasFence: fenced } = split('# plain\n');
    assert.equal(fenced, false);
    assert.equal(project, '');
    assert.ok(managed.includes('# plain'));
  });

  it('rejects missing, reversed, and duplicate fence pairs', () => {
    const missingBegin =
      '# TEAM CONTENT\n<!-- APEX:END managed -->\n' +
      '<!-- APEX:BEGIN adapter -->\nTEAM\n<!-- APEX:END adapter -->\n';
    const reversed =
      '<!-- APEX:END managed -->\nTEAM\n<!-- APEX:BEGIN managed -->\n';
    const duplicate =
      '<!-- APEX:BEGIN managed -->\nTEAM\n<!-- APEX:END managed -->\n' +
      '<!-- APEX:END managed -->\n';

    for (const malformed of [missingBegin, reversed, duplicate]) {
      const status = inspectFences(malformed);
      assert.equal(status.malformed, true);
      assert.equal(hasFence(malformed), false);
    }
  });
});
