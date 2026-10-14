# Example pull request description

The container copies this file into the target repo as `.apex-pr-description.example.md` while the agent writes the real description, then deletes both files before commit. Do not commit this file.

Match the headings below. A note under each heading says what that section is for. The paragraphs after each note are a filled example from Bug 56483. Write a new description for the current work item. Do not copy the notes or the sample text.

Work items: Bug #56483

Note: Name the work item. When this fixes a bug, include the bug and the original PBI when one exists.

#### What does this PR do?

Note: One or two short paragraphs. State the user-visible result, then the cause.

Speeds up mobile job favorites and replaces the irrelevant Favorites empty state.

Two separate bottlenecks: `dbo.Favorites` had no index supporting its query patterns, and once that was fixed favorites still felt slow, so the remaining cost was measured and traced to RecruitCare identity resolution.

#### What are the major changes in the code?

Note: Group by area. Name the files, indexes, and behavior a reviewer needs. Call out anything that needs sign-off before promotion.

##### RecruitCare identity resolution (the dominant cost)

MaxHub resolves a MaxView user to an RC candidate on every favorites read and write, filtering `dbo.CANDIDATE` on `EMAIL = @e OR PrimaryEmail = @e`. Neither column led an index, so it scanned 5,101,547 rows: 1,910,677 logical reads and 3,953 ms CPU, sitting in front of a Favorites query already down to 0 ms.

- Added `Maxim.ERecruit.Db/DeploymentScripts/release-2026.13.3/AddCandidateEmailIndexes.sql` creating `IX_CANDIDATE_PrimaryEmail_IsMergedTo` and `IX_CANDIDATE_EMAIL_IsMergedTo`, both `INCLUDE (UserID)`, `ONLINE = ON` with an offline fallback. After indexing: 7 logical reads, 0 ms, as an index union of two seeks, so no query rewrite was needed.
- `PrimaryEmail` covers 80% of candidates versus 10% for `EMAIL`, so indexing `EMAIL` alone would miss most lookups.
- MaxHub caches the resolved identity in `IMemoryCache`, 30 minute sliding expiry, keyed by MaxView user id. Only successful resolutions are cached, so a newly provisioned candidate is not locked out.

**DBA REVIEW REQUIRED:** `PrimaryEmail` is `nvarchar(1000)`, making the key 2004 bytes against a 1700-byte limit. The index builds with a warning, and once it exists any write over roughly 848 characters into `PrimaryEmail` will fail. Longest in dev is 596. Documented in the script header; needs sign-off before promotion past dev.

##### TimeClock database

- Added `dbo/Tables/Favorites.sql` as the SSDT source of truth, plus `release-2026.13.3/AddFavoritesIndexes.sql`, which keeps the oldest row per duplicate `(UserId, PositionId)` then creates `UX_Favorites_UserId_PositionId` (unique) and `IX_Favorites_PositionId`. Re-runnable, throws on a wrong-shaped index of the same name.

##### MaxHub

- `JobService.cs` loads favorite ids once for a favorites-only request and reuses that set instead of a second page-scoped query. Favorite reads use `AsNoTracking()`.
- A concurrent duplicate insert is idempotent: only SQL 2601/2627 on the add path are absorbed, unrelated `DbUpdateException` still propagates.
- `AzureSearchJobFilterBuilder.cs` emits `search.in` instead of a long OR chain.

##### Mobile

- Favorites empty state now reads "No saved jobs yet. Jobs you favorite will appear here. Browse jobs and tap the heart to save them." with a Find jobs action. Shift and Contract keep Create Job Alert.
- `JobInfiniteScrollList` gained `emptyMessage`, `emptyActionLabel`, `onEmptyAction`; `TabPagerLayout` supports controlled selection; Find jobs cancels a queued debounced tab load so a late Favorites fetch cannot overwrite All Jobs filters.

#### How should this be manually tested?

Note: Steps a reviewer can run. Include scripts, feature flags, and the empty or error states that changed.

- Run both scripts; confirm the indexes exist and a rerun skips and validates.
- With `job-favorites` enabled: favorite jobs, confirm Favorites loads with filled hearts, clear all favorites and confirm the new copy plus Find jobs with no Create Job Alert, then tap Find jobs and confirm All Jobs is selected immediately.
- Empty Shift and Contract still offer Create Job Alert.

#### Any background context you want to provide?

Note: Design doc path, measurements, and test results. Do not repeat the change list.

Design doc and Agent Review metrics: `design-doc/bug-56483-mobile-jobs-favorites-load-slowly-and-em.md` and its counterpart under `design-doc/reviews/`.

Both scripts have been run against dev. The RC indexes built online in 40 seconds with no blocking.

Testing: MaxHub NUnit 1660 passed, 0 failed, including two new tests covering the identity cache hit and the uncached miss. Mobile Jest 36 passed across the 3 changed suites.

#### Screenshots (if appropriate):

Note: Leave this heading. Add images only when the UI changed. Leave the body empty when there are none.

#### Questions:

Note: Open questions for reviewers. Leave the heading even when there are none.

Please confirm `release-2026.13.3` for both scripts.
