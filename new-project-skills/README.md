# New project skills

Skills in this folder belong only to a project created from an approved product proposal. They are not Apex skills.

## Lifecycle

1. **Product foundation** writes and maintains `PRODUCT.md`. That file is the broad product context: who it is for, the problem, the product scope, and the success criteria. It is not the first pull request.
2. **Product discovery** reads `PRODUCT.md` as that north star, chooses the smallest usable slice, and writes `.ai-pilot/output/product-build-brief.json` only after the person confirms the brief is ready for a prototype. That confirmation does not approve code.
3. After the brief and the prototype are approved together, Apex writes `PRODUCT.md` when the product context changed, plus `docs/product/BUILD_BRIEF.md` and `docs/product/build-manifest.json`. The build brief is the subset for one pull request.
4. **Product implementation** builds exactly that brief and manifest. It leaves setup, tests, migrations, CI, and deployment config in the tree, and it leaves the quality checks passing. It does not commit, push, or open the pull request. The cloud runner does that, and only after install, lint, typecheck, unit tests, build, migration check, end-to-end tests, accessibility, and `npm audit` pass.

Later feature, bug, and refinement requests use product discovery again, once the current pull request is merged. Change `PRODUCT.md` only when the stable product scope or success criteria change.

## Artifacts

- `PRODUCT.md` — broad product context. Not the first build.
- `.ai-pilot/output/product-build-brief.json` — discovery output, ready for a prototype.
- `docs/product/BUILD_BRIEF.md` — approved scope for one pull request.
- `docs/product/build-manifest.json` — the same approved scope, for the implementation agent.
- `docs/product/prototype.html` — the approved prototype, written with the brief at approval.

## Where they live

Keep them here:

- Do not add them under `.cursor/skills`. That folder is Apex's own agent skills.
- Do not add them under `foundation-skills`. That package is installed into entitled projects as `@apex/skills`.
- Add the next skill as `new-project-skills/<skill-name>/SKILL.md`.

Nothing in this folder is installed by itself. Approving a proposal copies the pack into the new repository as `.agents/skills/` and `.cursor/skills/`.
