# Outcome feedback step

`feedback-review` and `capture-outcome-feedback` are reusable Playbook steps. An author explicitly selects the earlier AI steps. Apex does not walk the graph to discover them.

`feedback-review` pauses the run. The person who started it accepts, questions, overrides, rejects, or defers each item from those selected steps, then sends the choices on or stops the outcome.

`capture-outcome-feedback` stores one outcome record. Its review step is optional. When set, it must be an earlier approval or feedback review. An optional feedback step adds the item choices. When no review is set, the record stores the selected AI provenance with decision `recorded`.

- the approval decision, including a send-back
- the optional overall comment
- structured answers already recorded on the approval
- provenance for each selected AI step: step id, step type, agent run, skill path, and model

The record does not include prompts, reports, chat messages, or chain-of-thought. The step does not call an agent and does not edit a skill. A later review can read these outcomes and propose a skill change. A person still reviews, tests, and publishes that change.

The ATS agent board asks for leadership feedback after the chair, revises the synopsis once from those notes, then ratifies. Learning stores the chair, deliberation, and revision, plus the feedback choices and the final ratification.
