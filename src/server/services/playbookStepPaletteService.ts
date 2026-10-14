import { toJSONSchema } from 'zod';
import type { PlaybookStepTypePaletteItem } from '../../shared/types/playbook';
import { listStepTypeDescriptors } from './playbookSteps/registry';

/** Step types exposed to the authoring canvas palette. */
export function listPlaybookStepPaletteItems(): PlaybookStepTypePaletteItem[] {
  return listStepTypeDescriptors().map((descriptor) => ({
    stepType: descriptor.stepType,
    label: descriptor.stepType,
    sideEffect: descriptor.sideEffect,
    requiredPermissions: descriptor.requiredPermissions,
    inputJsonSchema: toJSONSchema(descriptor.inputSchema) as Record<string, unknown>,
    outputJsonSchema: toJSONSchema(descriptor.outputSchema) as Record<string, unknown>,
    canSuspend: descriptor.canSuspend,
  }));
}
