# QA Lab test runs and Bugs

QA runs a published Test Case from QA Lab: they mark each step Passed or Failed, add comments and attachments to a step or to the whole case, and publish the result to Azure DevOps as a real test run. When something fails, QA files a Bug from the same screen.

## Which cases can be run

A case can be run once it has an Azure DevOps Test Case in a Test Plan suite:

- a case Apex published, using the plan and suite from the publish record; or
- an existing case the agent matched, using the first suite Azure DevOps lists for it.

A case in no suite has no test point, so it cannot be run until it is published into one.

## Steps

The run shows the Test Case's steps as they are in Azure DevOps, not the generated copy, so each result lines up with the step id Azure DevOps stores. Shared steps are not shown; QA records them in the case comment.

## Saving while testing

Results are saved in Apex as QA works (`qa_case_runs`). A draft belongs to the Azure DevOps Test Case, not to one generation, so a Regenerate keeps it. There is one draft per Test Case; publishing closes it and the next run starts a new one.

Attachments go to Azure DevOps as soon as QA adds them (work item attachment store, 10 MB each). Apex keeps the name and URL. This needs no Apex file storage, so it works the same on every instance.

## Publishing results

Publish, as the signed-in user:

1. creates a manual test run for the case's test point;
2. sets the result's outcome and comment, and one action result per marked step with the step comment;
3. copies each attachment onto the result, or onto the step it belongs to;
4. links any Bugs filed from this run to the result;
5. completes the run.

The case outcome is required. QA Lab suggests Failed when any step failed and Passed when every step passed.

## Bugs

Create Bug appears when the case or a step is Failed and a comment explains the failure. The Bug:

- is a child of the PBI the case tests;
- is linked to the Test Case by Tested By;
- is linked to the test result once results are published (or right away if they already are);
- gets the failed steps, their comments, and the case comment as repro steps;
- gets the run's attachments;
- uses the project's top-level area path and the PBI's iteration.

## Area path

Everything QA Lab creates in Azure DevOps (Test Cases, Test Plans, Bugs) uses the project's top-level area path (`MatterWorx`), not the PBI's team area (`MatterWorx\The Bakery`).

## Permissions

The routes use `interviews:manage`, like the rest of QA Lab. Writing runs and results needs the Basic + Test Plans access level in Azure DevOps.

## Tests

- `src/server/__tests__/qaCaseRunService.test.ts`: draft save, Bug rules, publish order and payloads.
- `src/server/__tests__/azureDevOps.test.ts`: run, result, step result, and attachment calls; Bug links.
- `src/client/components/__tests__/QaLabCaseRun.test.tsx`: step and case Pass/Fail, Create Bug visibility, publish.
