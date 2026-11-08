# Build artifacts

The orchestrator writes these files for one prompted build. The template ships no sample brief, plan, or evidence report. `<slug>` is kebab-case words from the prompt. It holds no secret and no email address.

| File                                   | Who writes it | What it holds                                                                 |
| -------------------------------------- | ------------- | ----------------------------------------------------------------------------- |
| `docs/plans/<slug>.brief.md`           | Orchestrator  | The prompt summary and the recorded answers                                   |
| `docs/plans/<slug>.md`                 | Planner       | The plan. The developer skill starts only after the person approves this file |
| `quality/evidence/<slug>-ui.md`        | UI role       | Catalog components, theme tokens, and the four screen states                  |
| `quality/evidence/<slug>.md`           | QA            | The gate evidence. The verdict is verified only when every gate passed        |
| `quality/evidence/<slug>-readiness.md` | Integration   | Ready or not ready. This is the status the person sees                        |

The evidence files are described again in [the evidence guide](../../quality/evidence/README.md).

## Brief

```markdown
# Brief

- Slug:
- Prompt summary:
- Authorization: not asked, stay, or pause
- Identity: not asked, keep, or pause
- Performance: not asked, leave out, or the numbers the person supplied
```

Ask a question only when its section below says to. Ask it verbatim. Record the answer in the brief before the planner writes the plan. A pause answer stops the build. Write no plan and no code after a pause.

## Authorization

Ask when the prompt requests roles, permissions, a user list, user create, user lookup, an admin screen, or any data that is not the caller's own.

Stay on the caller's own data, or pause until an authorization model is decided?

- Stay: the plan and the code use the authenticated principal only. Do not invent a role model.
- Pause: stop. Name [ADR 0002](../adr/0002-no-roles-or-permissions-in-the-template.md).

## Identity

Ask when the prompt requests a production login provider or a replacement for the development adapter.

Keep the development adapter for local runs, or pause until a production identity provider is chosen?

- Keep: local runs use `AUTH_MODE=development`. Do not wire a provider.
- Pause: stop. Name [the identity guide](../../apps/api/src/identity/README.md).

## Performance

Ask only when the prompt requests a response-time, concurrency, or data-volume target.

Supply real targets, or leave load-test evidence out of this plan?

- Supply: record the numbers the person gives. The plan says those numbers are not in `quality/nfr-manifest.json` until that file is updated and `illustrative` is set to false. Do not invent numbers.
- Leave out: the plan says real targets are missing and load-test evidence is out of this plan. Do not copy the example numbers.

When the prompt does not request a target, do not ask this question. The plan still says real targets are missing and load-test evidence is out of this plan.

## Approval

Show the plan file to the person. Wait for approval. A request to change the plan is another planner pass. A refusal stops the build. Silence is not approval. The developer skill does not start before approval.
