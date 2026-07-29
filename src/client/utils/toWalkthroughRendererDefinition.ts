/**
 * Map a published WalkthroughDefinition (domain) to the hybrid renderer contract.
 */
import type {
  WalkthroughDefinition,
  WalkthroughRendererDefinition,
  WalkthroughStep,
} from '../../shared/types/walkthrough';

function stepToRenderer(step: WalkthroughStep) {
  return {
    id: step.id,
    position: step.ordinal,
    heading: step.heading,
    bodyMarkdown: step.bodyMarkdown,
    imageUrl: step.imageUrl ?? null,
    ctaLabel: step.ctaLabel ?? null,
    ctaRoute: step.ctaRoute ?? null,
    anchor: step.anchor ?? null,
  };
}

export function toWalkthroughRendererDefinition(
  definition: WalkthroughDefinition,
): WalkthroughRendererDefinition {
  const steps = [...definition.steps]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map(stepToRenderer);

  return {
    id: definition.id,
    revision: definition.revision,
    title: definition.userTitle,
    intro: definition.whyItMatters,
    steps,
  };
}
