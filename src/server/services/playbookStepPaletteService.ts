import { toJSONSchema } from 'zod';
import type { PlaybookStepTypePaletteItem } from '../../shared/types/playbook';
import { listStepTypeDescriptors } from './playbookSteps/registry';

/**
 * Step types an author cannot add from the library. An interview is now an Agent task or Cloud
 * agent step with an interview Skill, and a build step needs a build run that only the
 * build-from-prompt flow creates.
 */
const NOT_ADDABLE_STEP_TYPES = new Set(['interview', 'build']);

/** Step types exposed to the authoring canvas palette. */
export function listPlaybookStepPaletteItems(): PlaybookStepTypePaletteItem[] {
  return listStepTypeDescriptors().map((descriptor) => ({
    stepType: descriptor.stepType,
    schemaVersion: descriptor.schemaVersion,
    label: descriptor.stepType,
    sideEffect: descriptor.sideEffect,
    requiredPermissions: descriptor.requiredPermissions,
    inputJsonSchema: toJSONSchema(descriptor.inputSchema) as Record<string, unknown>,
    outputJsonSchema: toJSONSchema(descriptor.outputSchema) as Record<string, unknown>,
    canSuspend: descriptor.canSuspend,
    addable: !NOT_ADDABLE_STEP_TYPES.has(descriptor.stepType),
  }));
}
