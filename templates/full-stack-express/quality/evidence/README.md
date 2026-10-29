# Evidence reports

A prompted build writes one evidence file per role under this directory. The template ships no sample report. Paths and the brief that names the slug are in [the build artifacts guide](../../docs/plans/README.md).

| File                                   | Who writes it | What the person uses it for                                                             |
| -------------------------------------- | ------------- | --------------------------------------------------------------------------------------- |
| `quality/evidence/<slug>-ui.md`        | UI role       | Catalog components, theme tokens, and tests for loading, empty, error, and loaded       |
| `quality/evidence/<slug>.md`           | QA            | Every quality gate. Verified only when every gate passed. A deferred gate is not a pass |
| `quality/evidence/<slug>-readiness.md` | Integration   | The status the person sees: ready or not ready                                          |

QA evidence and the readiness report answer different questions. QA says whether every gate passed. Integration says whether the build is ready for a pipeline, including gates that were deferred with a reason and an owner. Show the readiness report.
