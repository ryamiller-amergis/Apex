import type { InterviewSkillOption } from '../types/projectSettings';

export interface PrototypeStageSkillConfig {
  prototypeStageEnabled?: boolean;
  interviewSkillOptions?: InterviewSkillOption[] | null;
}

/**
 * Resolve whether the design-prototype stage is enabled for a workflow.
 *
 * Priority:
 * 1. Matching interview skill option (by path) → wantsDesignPrototype !== false
 * 2. Sole configured interview skill option → wantsDesignPrototype !== false
 * 3. Interview snapshot, except heal stale `false` when every configured option
 *    wants prototypes (legacy: project-level toggle was removed from admin UI
 *    while remaining false in DB; option checkboxes still showed checked)
 * 4. Project-level prototypeStageEnabled !== false
 */
export function resolvePrototypeStageEnabled(
  interviewSnapshot: boolean | null | undefined,
  skillConfig?: PrototypeStageSkillConfig | null,
  selectedSkillPath?: string | null,
): boolean {
  const options = skillConfig?.interviewSkillOptions ?? null;

  if (options && options.length > 0) {
    const matched = selectedSkillPath
      ? options.find((o) => o.path === selectedSkillPath)
      : undefined;
    if (matched) {
      return matched.wantsDesignPrototype !== false;
    }
    if (options.length === 1) {
      return options[0].wantsDesignPrototype !== false;
    }
    if (interviewSnapshot === true) return true;
    if (interviewSnapshot === false) {
      const allWantPrototypes = options.every((o) => o.wantsDesignPrototype !== false);
      if (allWantPrototypes) return true;
      return false;
    }
  }

  if (interviewSnapshot != null) return interviewSnapshot;
  return skillConfig?.prototypeStageEnabled !== false;
}
