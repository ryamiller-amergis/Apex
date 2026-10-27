/**
 * Static contract for `.cursor/skills/build-intake/SKILL.md` and recorded
 * transcripts. A live model run is a manual rollout check (VT-23).
 */
import fs from 'fs';
import path from 'path';
import {
  BUILD_INTAKE_CONFIRM_MARKER,
  BUILD_INTAKE_QUESTION_MARKER,
  countQuestionMarkers,
  hasConfirmMarker,
  stripBuildIntakeMarkers,
  warningClasses,
  warningMarker,
} from '../../shared/utils/buildIntakeMarkers';
import { detectSensitiveClasses } from '../services/buildIntakeSensitiveText';

const SKILL_PATH = path.resolve(__dirname, '../../../.cursor/skills/build-intake/SKILL.md');
const skill = fs.readFileSync(SKILL_PATH, 'utf8');

describe('VT-04 — build-intake SKILL.md contract (TBI-009 DoD-0, DoD-3)', () => {
  it('declares the skill name', () => {
    expect(skill).toMatch(/^---\r?\nname: build-intake\r?\n/);
  });

  it.each([
    ['restate step', /restate the feature/i],
    ['zero questions when clear', /zero questions is the right answer for a clear request/i],
    ['cap of 5', /at most 5 questions/i],
    ['no breaking-change questions', /never ask whether something might break/i],
    ['hidden context block', /<<<INTERNAL_INTAKE_CONTEXT>>>/],
    ['warning label line', /Sensitive data warning/],
    ['never quote flagged text', /never quote, repeat, restate/i],
    ['warning does not block', /does not block/i],
  ])('carries the %s rule', (_label, pattern) => {
    expect(skill).toMatch(pattern);
  });

  it('names the three marker kinds', () => {
    expect(skill).toContain(BUILD_INTAKE_QUESTION_MARKER);
    expect(skill).toContain(BUILD_INTAKE_CONFIRM_MARKER);
    expect(skill).toContain('[[build-intake:warning:');
  });

  it('names no model (model-neutral NFR)', () => {
    expect(skill).not.toMatch(/\b(claude|gpt|gemini|sonnet|opus|grok|haiku|llama|mistral)\b/i);
  });
});

describe('VT-05 — recorded transcripts through the marker utility', () => {
  const clear = [
    { role: 'user', text: 'Add a dark mode toggle to the profile page.' },
    {
      role: 'agent',
      text: `You want a switch on your profile page that turns dark mode on and off.\n\nAssumptions:\n- The choice is saved per user.\n\n${BUILD_INTAKE_CONFIRM_MARKER}\nDoes this match what you want?\na. Confirm\nb. Change it`,
    },
  ];

  const unclear = [
    { role: 'user', text: 'Make reporting better.' },
    {
      role: 'agent',
      text: `I'd like to understand a little more.\n\n${BUILD_INTAKE_QUESTION_MARKER} Which report do you use most?\n${BUILD_INTAKE_QUESTION_MARKER} What is hard about it today?\n${BUILD_INTAKE_QUESTION_MARKER} Who else reads it?`,
    },
  ];

  const token = 'ghp_FAKEtoken1234567890abcdef';
  const tokenPrompt = `Deploy the widget. Bearer ${token}`;
  const tokenReply = [
    { role: 'user', text: tokenPrompt },
    {
      role: 'agent',
      text: `Sensitive data warning ${warningMarker('access_token')}\nYour request looks like it holds an access token. Please remove it.\n\nYou want the widget deployed.\n${BUILD_INTAKE_CONFIRM_MARKER}\na. Confirm\nb. Change it`,
    },
  ];

  it('clear prompt: no questions and a confirm (PBI-009 AC-0)', () => {
    expect(countQuestionMarkers(clear)).toBe(0);
    expect(hasConfirmMarker(clear[1].text)).toBe(true);
  });

  it('unclear prompt: 3 questions, never above 5 (PBI-009 AC-2)', () => {
    const asked = countQuestionMarkers(unclear);
    expect(asked).toBe(3);
    expect(asked).toBeLessThanOrEqual(5);
  });

  it('pasted token: flagged, warned, and the reply holds no part of it (PBI-010 AC-0)', () => {
    expect(detectSensitiveClasses(tokenPrompt)).toContain('access_token');
    expect(warningClasses(tokenReply[1].text)).toEqual(['access_token']);
    const visible = stripBuildIntakeMarkers(tokenReply[1].text);
    expect(visible.startsWith('Sensitive data warning')).toBe(true);
    expect(visible).not.toContain(token);
    expect(visible).not.toContain(token.slice(0, 8));
  });
});
