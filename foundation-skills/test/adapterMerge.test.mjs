import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wrapSlot,
  mergeAdapterBodies,
  mergeAdapterRegions,
  extractSlotValues,
  extractAdapterBodyFromRegion,
  listUnfilledMarkers,
  isUnfilledInner,
} from '../lib/adapterMerge.mjs';
import { renderTemplate } from '../lib/template.mjs';

test('wrapSlot / extractSlotValues round-trip', () => {
  const body = [
    '# Adapter',
    wrapSlot('projectName', 'MaxView'),
    wrapSlot('contextFile', '<!-- APEX:unfilled(contextFile): missing -->'),
  ].join('\n');
  const map = extractSlotValues(body);
  assert.equal(map.get('projectName').value, 'MaxView');
  assert.equal(map.get('projectName').isUnfilled, false);
  assert.equal(map.get('contextFile').isUnfilled, true);
});

test('mergeAdapterBodies preserves filled slots and takes incoming for unfilled', () => {
  const existing = [
    wrapSlot('projectName', 'Human Override Corp'),
    wrapSlot('contextFile', '<!-- APEX:unfilled(contextFile): old -->'),
  ].join('\n');
  const incoming = [
    wrapSlot('projectName', 'Detector Name'),
    wrapSlot('contextFile', 'docs/CONTEXT.md'),
    wrapSlot('agentsFile', '<!-- APEX:unfilled(agentsFile): new gap -->'),
  ].join('\n');

  const merged = mergeAdapterBodies(existing, incoming);
  const map = extractSlotValues(merged);
  assert.equal(map.get('projectName').value, 'Human Override Corp');
  assert.equal(map.get('contextFile').value, 'docs/CONTEXT.md');
  assert.equal(map.get('agentsFile').isUnfilled, true);
  assert.equal(listUnfilledMarkers(merged).length, 1);
});

test('mergeAdapterBodies preserves a project-owned adapter with no slots', () => {
  const incoming = wrapSlot('projectName', 'Fresh');
  const merged = mergeAdapterBodies('# plain adapter\n', incoming);
  assert.equal(merged, '# plain adapter\n');
  assert.equal(extractSlotValues(merged).size, 0);
});

test('mergeAdapterBodies preserves freeform edits while filling anchored gaps', () => {
  const existing = [
    '# Team adapter',
    'TEAM_FREEFORM_RULE',
    wrapSlot('contextFile', '<!-- APEX:unfilled(contextFile): missing -->'),
  ].join('\n');
  const incoming = [
    '# Package template changed',
    wrapSlot('contextFile', 'docs/CONTEXT.md'),
    wrapSlot('agentsFile', 'AGENTS.md'),
  ].join('\n');

  const merged = mergeAdapterBodies(existing, incoming);
  const slots = extractSlotValues(merged);
  assert.match(merged, /# Team adapter/);
  assert.match(merged, /TEAM_FREEFORM_RULE/);
  assert.doesNotMatch(merged, /# Package template changed/);
  assert.equal(slots.get('contextFile').value, 'docs/CONTEXT.md');
  assert.equal(slots.get('agentsFile').value, 'AGENTS.md');
});

test('mergeAdapterRegions edits slots surgically without replacing project wrapper content', () => {
  const existing = [
    '<!-- APEX:BEGIN managed (x @ 1.0.0) -->',
    '# Foundation',
    '<!-- APEX:END managed -->',
    '',
    '<!-- APEX:BEGIN adapter (team-custom-version) -->',
    '<!-- TEAM IMPORTANT -->',
    '# Team-owned adapter',
    wrapSlot('contextFile', '<!-- APEX:unfilled(contextFile): missing -->'),
    '<!-- APEX:END adapter -->',
    '',
    '## Project notes',
    'TEAM_NOTE',
  ].join('\n');
  const incoming = [
    '<!-- APEX:BEGIN adapter (x @ 2.0.0) -->',
    '<!-- Project-owned APEX adapter scaffold. -->',
    '# Package replacement text',
    wrapSlot('contextFile', 'docs/CONTEXT.md'),
    wrapSlot('agentsFile', 'AGENTS.md'),
    '<!-- APEX:END adapter -->',
  ].join('\n');

  const merged = mergeAdapterRegions(existing, incoming, 'x', '2.0.0');
  assert.match(merged, /APEX:BEGIN adapter \(team-custom-version\)/);
  assert.match(merged, /<!-- TEAM IMPORTANT -->/);
  assert.match(merged, /# Team-owned adapter/);
  assert.doesNotMatch(merged, /# Package replacement text/);
  assert.equal(extractSlotValues(merged).get('contextFile').value, 'docs/CONTEXT.md');
  assert.equal(extractSlotValues(merged).get('agentsFile').value, 'AGENTS.md');
});

test('adapter notice parsing removes known APEX notices but preserves project comments', () => {
  const legacyNotice = [
    '<!-- APEX:BEGIN adapter (x @ 1.1.0) -->',
    '<!-- APEX project context — merged by `bootstrap` / install.',
    '     Filled <!-- APEX:slot(name) --> values are preserved across refreshes.',
    '     Unfilled markers: retry bootstrap or run /post-skill-bootstrap.',
    '     Free-form notes go under ## Project notes below. -->',
    '<!-- TEAM IMPORTANT -->',
    '# Team adapter',
    '<!-- APEX:END adapter -->',
  ].join('\n');

  const body = extractAdapterBodyFromRegion(legacyNotice);
  assert.doesNotMatch(body, /APEX project context/);
  assert.match(body, /<!-- TEAM IMPORTANT -->/);
  assert.match(body, /# Team adapter/);
});

test('listUnfilledMarkers recognizes legacy TODO markers', () => {
  const markers = listUnfilledMarkers('<!-- TODO(contextFile): choose a context file -->');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].slot, 'contextFile');
  assert.equal(markers[0].legacy, true);
});

test('isUnfilledInner detects markers', () => {
  assert.equal(isUnfilledInner('<!-- APEX:unfilled(x): why -->'), true);
  assert.equal(isUnfilledInner('docs/CONTEXT.md'), false);
});

test('template render wraps every slot', () => {
  const { text, explain } = renderTemplate(
    'Name: {{slot:projectName}}\nCtx: {{slot:contextFile}}\n',
    {
      slots: {
        projectName: { type: 'value', detector: 'stack', key: 'projectName' },
        contextFile: { type: 'value', detector: 'repo-docs', key: 'contextFile' },
      },
    },
    {
      stack: { projectName: { key: 'projectName', value: 'Acme', source: { file: 'package.json' } } },
      'repo-docs': {},
    },
  );
  assert.match(text, /APEX:slot\(projectName\)/);
  assert.match(text, /Acme/);
  assert.match(text, /APEX:\/slot\(projectName\)/);
  assert.match(text, /APEX:unfilled\(contextFile\)/);
  assert.equal(explain.projectName.filled, true);
  assert.equal(explain.contextFile.todo, true);
});
