import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compose,
  composeManaged,
  split,
  splice,
  hashManaged,
  hasFence,
  END_MARKER,
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
  it('compose produces a fenced file with project notes stub', () => {
    const out = compose(FOUNDATION, ADAPTER, 'grill-with-docs', '1.1.0');
    assert.ok(out.startsWith('---\nname: grill-with-docs\n'));
    assert.ok(out.includes('<!-- APEX:BEGIN managed (grill-with-docs @ 1.1.0) -->'));
    assert.ok(out.includes(END_MARKER));
    assert.ok(out.includes('# Grill With Docs — Foundation'));
    assert.ok(out.includes('# grill-with-docs — Project Adapter'));
    assert.ok(out.includes('## Project notes'));
    assert.ok(out.includes('APEX never writes below this line'));
    // Frontmatter from foundation wins
    assert.ok(out.includes('description: Foundation description.'));
    assert.ok(!out.includes('description: Adapter description.'));
  });

  it('split round-trips managed and project parts', () => {
    const out = compose(FOUNDATION, ADAPTER, 'grill-with-docs', '1.1.0');
    const { managed, project, hasFence: fenced } = split(out);
    assert.equal(fenced, true);
    assert.ok(managed.includes(END_MARKER));
    assert.ok(project.includes('## Project notes'));
    assert.ok(!managed.includes('## Project notes'));
  });

  it('splice preserves project tail and replaces managed region', () => {
    const original = compose(FOUNDATION, ADAPTER, 'grill-with-docs', '1.0.0');
    // Simulate a team edit below the fence
    const edited = original.replace(
      '<!-- Yours. APEX never writes below this line. -->\n',
      '<!-- Yours. APEX never writes below this line. -->\n\nMaxView asks about PHI first.\n',
    );
    const newManaged = composeManaged(
      FOUNDATION.replace('Ask one question at a time.', 'Ask relentlessly.'),
      ADAPTER,
      'grill-with-docs',
      '1.1.0',
    );
    const next = splice(edited, newManaged);
    assert.ok(next.includes('Ask relentlessly.'));
    assert.ok(next.includes('MaxView asks about PHI first.'));
    assert.ok(next.includes('(grill-with-docs @ 1.1.0)'));
    // Old managed body is gone
    assert.ok(!next.includes('Ask one question at a time.'));
  });

  it('splice returns null when fence is missing', () => {
    const noFence = '# Hand-written skill\n\nTeam owns everything.\n';
    const result = splice(noFence, composeManaged(FOUNDATION, ADAPTER, 'x', '1.0.0'));
    assert.equal(result, null);
    assert.equal(hasFence(noFence), false);
  });

  it('hashManaged changes when in-fence content is edited', () => {
    const original = compose(FOUNDATION, ADAPTER, 'grill-with-docs', '1.0.0');
    const h1 = hashManaged(original);
    assert.ok(h1);

    // Edit below fence — hash must stay the same
    const below = original + '\nExtra project note.\n';
    assert.equal(hashManaged(below), h1);

    // Edit above fence — hash must change
    const above = original.replace('Ask one question at a time.', 'Edited inside fence.');
    assert.notEqual(hashManaged(above), h1);
  });

  it('handles CRLF input via normalizeText', () => {
    const crlf = FOUNDATION.replace(/\n/g, '\r\n');
    const out = compose(crlf, ADAPTER.replace(/\n/g, '\r\n'), 'grill-with-docs', '1.1.0');
    assert.equal(out.includes('\r'), false);
    assert.equal(out, normalizeText(out));
    const { hasFence: fenced } = split(out.replace(/\n/g, '\r\n'));
    assert.equal(fenced, true);
  });

  it('split reports hasFence=false for unfenced files', () => {
    const { managed, project, hasFence: fenced } = split('# plain\n');
    assert.equal(fenced, false);
    assert.equal(project, '');
    assert.ok(managed.includes('# plain'));
  });
});
