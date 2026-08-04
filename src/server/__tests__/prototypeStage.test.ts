import { resolvePrototypeStageEnabled } from '../../shared/utils/prototypeStage';
import type { InterviewSkillOption } from '../../shared/types/projectSettings';

describe('resolvePrototypeStageEnabled', () => {
  const protoOn: InterviewSkillOption = {
    path: '.cursor/skills/grill-with-docs/SKILL.md',
    friendlyName: 'Feature grill',
    wantsDesignPrototype: true,
  };
  const protoUnset: InterviewSkillOption = {
    path: '.cursor/skills/grill-with-docs/SKILL.md',
    friendlyName: 'Feature grill',
  };
  const protoOff: InterviewSkillOption = {
    path: '.cursor/skills/grill-design/SKILL.md',
    friendlyName: 'Tech design',
    wantsDesignPrototype: false,
  };

  it('uses matched interview skill option wantsDesignPrototype (default on when unset)', () => {
    expect(resolvePrototypeStageEnabled(false, {
      prototypeStageEnabled: false,
      interviewSkillOptions: [protoUnset, protoOff],
    }, protoUnset.path)).toBe(true);

    expect(resolvePrototypeStageEnabled(true, {
      prototypeStageEnabled: true,
      interviewSkillOptions: [protoOn, protoOff],
    }, protoOff.path)).toBe(false);
  });

  it('uses sole interview skill option when no path is provided', () => {
    expect(resolvePrototypeStageEnabled(false, {
      prototypeStageEnabled: false,
      interviewSkillOptions: [protoUnset],
    })).toBe(true);
  });

  it('heals stale interview false when every option wants prototypes', () => {
    expect(resolvePrototypeStageEnabled(false, {
      prototypeStageEnabled: false,
      interviewSkillOptions: [protoUnset, { ...protoOn, path: 'other' }],
    })).toBe(true);
  });

  it('trusts interview false when some options opt out of prototypes', () => {
    expect(resolvePrototypeStageEnabled(false, {
      prototypeStageEnabled: true,
      interviewSkillOptions: [protoOn, protoOff],
    })).toBe(false);
  });

  it('falls back to project-level when no options are configured', () => {
    expect(resolvePrototypeStageEnabled(undefined, { prototypeStageEnabled: false })).toBe(false);
    expect(resolvePrototypeStageEnabled(undefined, { prototypeStageEnabled: true })).toBe(true);
    expect(resolvePrototypeStageEnabled(undefined, {})).toBe(true);
    expect(resolvePrototypeStageEnabled(false, { prototypeStageEnabled: true })).toBe(false);
  });
});
