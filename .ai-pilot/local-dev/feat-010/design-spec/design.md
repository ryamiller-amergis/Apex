# Design — Self-Service Profile Screen

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** Design System and Reference Web Client | **Affected personas:** Authenticated User
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (5 unresolved)

---

## Feature Summary

**Description:** Authenticated Users view and edit their own profile on a screen in the Full-Stack Express Starter Template's reference web client. The screen reads and writes through `GET` and `PUT /api/v1/me`, so it shows the full client stack in use: the typed API client, TanStack Query, React Hook Form with the shared Zod schema, the neutral MUI design system, and its loading, error, and empty states. Platform Engineering and development agents use it as the working example of how a screen in a generated application is built, tested, and made accessible.

**Feature ID:** FEAT-010 | **Depends on:** FEAT-004 (contracts), FEAT-006 (profile API), FEAT-009 (design system and shell)

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| TBI-022 | TBI | Compose the web application with routing, query client, and typed API client | Must Have |
| PBI-019 | PBI | See my profile on a profile screen | Must Have |
| PBI-020 | PBI | Edit my profile with clear validation | Must Have |
| PBI-021 | PBI | Use the profile screen with a keyboard and screen reader | Must Have |

---

## Scope and Out-of-Scope

**In scope:**
- A read page at `/profile` showing display name, email, and status for the signed-in user, with loading, error (retry), empty-email, and unauthenticated states (PBI-019).
- An edit page at `/profile/details/edit` with display name and email fields, field-level validation from the shared Zod schema, a pending state, a save-failure state that keeps entered values, and return to the read page on success (PBI-020).
- Keyboard operation, visible focus, screen-reader announcements for every state, and automated axe checks on every state in both themes (PBI-021).
- The web application composition the screen needs: React Router routes, TanStack Query client, and a typed API client that parses every response with the shared schema and reads Problem Details errors in one place (TBI-022).
- Web tests for the flow: component tests, plus Playwright journeys with axe.

**Out of scope:**
- User list and user create screens.
- Avatar upload and notification preferences.
- Viewing or editing another person's profile; profile history.
- Editing status or external subject.
- Assistive technology beyond keyboard and screen reader; a full manual accessibility audit.
- Amergis branding and Apex components; any Apex navigation entry.
- A sign-in screen or production identity provider flow (extension point; see ⚠ in the assumptions file).
- Changes to the application shell, header, navigation, error boundary, or theme toggle (FEAT-009 owns them).
- Changes to the profile API, contracts package, database, or Apex runtime.
- Client-side roles, permissions, and feature flags.

---

## Target Surface

**Primary surface:** Frontend only (React client). The Feature adds no server code; it consumes the profile API that FEAT-006 delivers. The template as a whole is full-stack.

**Experience notes:** The screen is part of a standalone starter repository, not an Apex screen, and has no Apex navigation entry. It renders inside the responsive application shell with light and dark themes. It works at phone, tablet, and desktop widths with no horizontal scrolling at the narrowest supported width.

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| View own profile (`GET /api/v1/me`) | Authenticated principal from the identity-provider adapter; no roles defined | User-scoped |
| Update own profile (`PUT /api/v1/me`) | Authenticated principal from the identity-provider adapter; no roles defined | User-scoped |
| Use the screen locally without an identity provider | Development adapter: authentication mode `development` and a non-production environment (one fixed synthetic principal) | User-scoped |
| Role-based authorization of the screen | Not defined; extension point for Platform Engineering | Not applicable |

The screen never sends a user identifier or subject. The API takes the subject from the authenticated principal.

**Feature flag:** `None` — rollout: Not applicable (reviewable sample; no change to Apex runtime behavior)
**Behavior when flag is off:** Not applicable

---

## Acceptance Criteria

### PBI-019 — See my profile on a profile screen

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I am signed in and my profile exists | I open the profile screen | My display name, email, and status are shown after a loading state |
| (b) Error/failure | The profile request fails | I open the profile screen | An error state with a retry action is shown, and no technical detail appears |
| (c) Edge case/boundary | My profile has no email | I open the profile screen | The email area shows a clear empty value instead of blank space or the word null |
| (d) Negative scenario | My session is no longer authenticated | I open the profile screen | I am told I must sign in, and no profile data is shown |

### PBI-020 — Edit my profile with clear validation

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I am on the profile screen | I change my display name and save with valid values | The change is saved and the screen shows the updated profile without a reload |
| (b) Error/failure | I am editing my profile | The save request fails | My entered values stay in the form and an error message with a retry option is shown |
| (c) Edge case/boundary | I am editing my profile | I clear the optional email, or enter a display name at the maximum length | The cleared email is accepted, the maximum length is accepted, and longer input shows a field error before I submit |
| (d) Negative scenario | I am editing my profile | I submit an empty display name or a malformed email | The form shows field-level errors, sends no request, and keeps focus on the first invalid field |

### PBI-021 — Use the profile screen with a keyboard and screen reader

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I use only the keyboard | I move through the profile screen, edit a field, and save | Every control is reachable in a logical order with visible focus and the save succeeds |
| (b) Error/failure | I use a screen reader and the save fails | The error appears | The error is announced and linked to the relevant field or to the form |
| (c) Edge case/boundary | The screen is in its loading or empty state | A screen reader reads the page | The state is announced and no focus is trapped |
| (d) Negative scenario | The automated accessibility check runs on every state of the screen | A control lacks a label or has insufficient contrast | The check reports a violation and the quality gate fails |

### TBI-022 — Compose the web application with routing, query client, and typed API client

TBI-022 has no user story. Its definition of done is the acceptance gate, shown here as Given/When/Then rows so each scenario has a test.

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | The web application runs inside the application shell and error boundary | A request to `/api/v1/me` succeeds | The API client returns data typed from the contracts package, and the shared schema has parsed it |
| (b) Error/failure | The API returns a Problem Details error | The API client receives it | The client throws one typed error that carries the status and the parsed body |
| (c) Edge case/boundary | The app runs in local development or in the container | The client builds a request URL | The URL is relative (`/api/v1/me`); local development proxies it, and the production build uses it unchanged |
| (d) Negative scenario | The API returns a 401, or a 200 whose body fails the shared schema | The API client receives the response | A 401 becomes the typed unauthenticated error; a body that fails the schema becomes an error, and no unparsed data reaches a component |

---

## UI/UX

**Routes / screens:**

| Route | Screen | Action | New or extend existing |
|-------|--------|--------|----------------------|
| `/` | Redirect | Send the user to `/profile` so the template opens on its reference screen | New route in the TBI-022 route config (shell unchanged) |
| `/profile` | `ProfileViewPage` | Read own display name, email, and status; choose Edit | New route in the TBI-022 route config (shell unchanged) |
| `/profile/details/edit` | `ProfileEditPage` | Change display name and email; save or cancel | New route in the TBI-022 route config (shell unchanged) |

Both routes render inside the application shell. Save success and Cancel both return to `/profile`.

**Component breakdown:**

| Component | Purpose | Loading state | Error state | Empty state |
|-----------|---------|--------------|-------------|-------------|
| `ProfileQueryBoundary` | Maps the profile query to loading, error, unauthenticated, or data for both pages | UI package `LoadingState`, announced as status text "Loading your profile…", shown on the first render | UI package `ErrorState`: "We couldn't load your profile" with a "Try again" button; unauthenticated variant: "Sign in to view your profile" with no button | Not applicable (create-on-first-access) |
| `ProfileViewPage` | Page heading, saved message, details, Edit button | Via `ProfileQueryBoundary` | Via `ProfileQueryBoundary` | Via `ProfileDetails` |
| `ProfileDetails` | Description list of Display name, Email, Status | None (receives loaded data) | None | Email shows "No email on file" |
| `ProfileEditPage` | Page heading and form host | Via `ProfileQueryBoundary` | Via `ProfileQueryBoundary` | Not applicable |
| `ProfileForm` | Display name and email fields, Save and Cancel, form-level save error | Save button shows a pending label ("Saving…") and ignores repeat submits | Field errors under each input; form-level `Alert` with "We couldn't save your changes. Your entries are still here." and a "Try again" button | Not applicable |
| `ProfileStatusChip` | Text chip for the `status` value | None | None | None |

**Validation rules:**
- Display name: required; trimmed; at most the contract's maximum length (working value 100). Messages come from the shared Zod schema, in plain language.
- Email: optional; if present, must be a valid email at most the contract's maximum length (working value 254). An empty field is valid and sends `null`.
- Validation runs on change, so over-limit input shows its error before submit. A submit with any invalid field sends no request.
- Only display name and email are in the form and in the request body. Status and external subject never appear as inputs.
- A server validation error maps to the named field. A save failure with no field detail shows the form-level message.
- Entered values survive a failed save, and survive a refetch that completes while the form is open.

**Accessibility:**
- One `h1` per page ("Profile" and "Edit profile"); the read page shows details in a `dl` with `dt` and `dd` pairs so a screen reader reads each label with its value.
- Every input has a visible, persistent label. Error text is tied to its input through `aria-describedby`, the input carries `aria-invalid`, and the text uses `role="alert"` so it is announced when it appears.
- On a blocked submit, focus moves to the first invalid field (name before email). On a server field error, focus moves to that field. On a save failure with no field detail, focus moves to the form-level `Alert`, and the form's `aria-describedby` points at it.
- After a successful save the read page loads with the saved message in a `role="status"` region, and focus moves to the page `h1`.
- Loading text sits in a `role="status"` region; the error and unauthenticated states use `role="alert"`. No state traps focus, and every state keeps the shell landmarks.
- Save stays focusable while pending (`aria-disabled`, not `disabled`) so focus is not lost, and it reports "Saving…".
- Status shows as text, not as color alone. All text and controls meet WCAG 2.1 AA contrast in light and dark themes through theme tokens, with no hard-coded colors.
- Tab order follows reading order: Edit on the read page; display name, email, Save, Cancel on the edit page. Focus indicators come from the theme and stay visible in both themes.
- Each route sets `document.title` ("Profile", "Edit profile").

**data-testid attributes:**
- `data-testid="profile-heading"` — page `h1` on both routes
- `data-testid="profile-loading"` — loading state
- `data-testid="profile-error"` — load error state
- `data-testid="profile-retry"` — retry button in the load error state
- `data-testid="profile-unauthenticated"` — sign-in-required state
- `data-testid="profile-saved-message"` — success message on the read page
- `data-testid="profile-details"` — description list
- `data-testid="profile-display-name"` — displayed display name
- `data-testid="profile-email"` — displayed email
- `data-testid="profile-email-empty"` — "No email on file" text
- `data-testid="profile-status"` — status chip
- `data-testid="profile-edit-button"` — Edit button on the read page
- `data-testid="profile-form"` — edit form
- `data-testid="profile-display-name-input"` — display name input
- `data-testid="profile-email-input"` — email input
- `data-testid="profile-save-button"` — Save button
- `data-testid="profile-cancel-button"` — Cancel button
- `data-testid="profile-save-error"` — form-level save error `Alert`
- `data-testid="profile-save-retry"` — retry button in the save error `Alert`

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
