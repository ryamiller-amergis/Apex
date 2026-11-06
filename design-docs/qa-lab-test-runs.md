# QA Lab test runs and Bugs

QA tests a case in QA Lab: they mark each step Passed or Failed, add comments and attachments to a step or to the whole case, and the results are saved in Apex. Publishing is the last step: it sends the case and its results to Azure DevOps as a real test run. When something fails, QA files a Bug from the same screen.

## Which cases can be run

Every QA case can be run, whether or not it is in Azure DevOps yet. Unit and integration checks are not, because they are never published as Test Cases.

## Steps

The run shows the case's steps as QA Lab publishes them, numbered from 1. A result is saved with the step text QA tested. If a Regenerate or an edit changes a step, its result is left out and QA Lab asks QA to record that step again; the case result, the comments and the attachments stay.

On publish, step N maps to the Nth step of the Test Case in Azure DevOps. Shared steps are not shown; QA records them in the case comment.

## Saving while testing

Results are saved in Apex as QA works (`qa_case_runs`), with no call to Azure DevOps. A run belongs to one case of one suite (`suite_id`, `local_case_id`), so a Regenerate keeps it and a new generation starts fresh. There is one draft per case; publishing closes it and the next run starts a new one.

Attachments are kept in the Apex database (`qa_case_run_files`, 10 MB each, 20 per run) until they are needed in Azure DevOps. The database is shared by every instance, so nothing depends on local disk. Files open from Apex while testing; only images, PDF and plain text open in the browser, everything else downloads.

## Publishing results

Publishing the suite creates the Test Cases first, then publishes every draft that has a case outcome and whose case is now in a Test Plan suite. A case that is already in Azure DevOps can also publish its results on its own from the run panel.

For each run, as the signed-in user, publish:

1. creates a manual test run for the case's test point;
2. sets the result's outcome and comment, and one action result per marked step with the step comment;
3. uploads each attachment onto the result, or onto the step it belongs to;
4. links any Bugs filed from this run to the Test Case and to the result;
5. completes the run.

The case outcome is required. QA Lab suggests Failed when any step failed and Passed when every step passed. If a case's results fail to publish, the suite publish reports it and the draft stays, so QA can try again.

## Bugs

Create Bug appears when the case or a step is Failed and a comment explains the failure. QA confirms, and the Bug is created in Azure DevOps right away. The Bug:

- is a child of the PBI the case tests;
- is linked to the Test Case by Tested By now, or on publish when the case is not in Azure DevOps yet;
- is linked to the test result on publish (or right away if the results are already published);
- gets the failed steps, their comments, and the case comment as repro steps;
- gets the run's attachments, uploaded to the work item attachment store once;
- uses the project's top-level area path and the PBI's iteration.

## Area path

Everything QA Lab creates in Azure DevOps (Test Cases, Test Plans, Bugs) uses the project's top-level area path (`MatterWorx`), not the PBI's team area (`MatterWorx\The Bakery`).

## Permissions

The routes use `interviews:manage`, like the rest of QA Lab. Writing runs and results needs the Basic + Test Plans access level in Azure DevOps.

## Tests

- `src/server/__tests__/qaCaseRunService.test.ts`: saving before publish, changed steps, Bug rules and links, publish payloads, suite publish.
- `src/server/__tests__/azureDevOps.test.ts`: run, result, step result, and attachment calls; Bug links.
- `src/client/components/__tests__/QaLabCaseRun.test.tsx`: running an unpublished case, Bug confirm, publish, files and changed steps.
