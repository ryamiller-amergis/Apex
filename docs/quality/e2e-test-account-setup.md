# E2E Test Account Setup (Azure AD / Entra) for Apex Playwright SSO

This runbook explains how to create and configure the dedicated Microsoft Entra ID
(Azure AD) test account used by Apex's automated Playwright `deployed-smoke` E2E tests.
Follow it top to bottom — it is a checklist a teammate can execute without prior context.

> **No secrets are printed here.** Where a value comes from `.env`, this doc names the
> variable (e.g. `AZURE_TENANT_ID`) and tells you where to read it. Never paste real
> credentials into this file, a PR, or chat.

---

## At a glance — what you'll do

Six actions, in order. Each links to its detailed section below.

1. [Create the Entra user](#1-create-the-entra-user) — a dedicated Azure AD account for the tests.
2. [Exempt it from MFA / Conditional Access](#2-mfa--conditional-access-exemption-critical--now-doubly-so) — so automated login isn't blocked by a prompt.
3. [Do one manual sign-in](#3-app-consent--first-sign-in) — clears any first-run consent / password-change screen.
4. [Grant project access in the environment's Apex database](#4-grant-in-app-access-so-authenticated-tests-see-real-pages) — one SQL row (dev/staging only; prod needs nothing).
5. [Add the GitHub secrets](#5-github-secrets--variables-to-set) — `E2E_TEST_USER` and `E2E_TEST_PASSWORD`.
6. [Verify](#6-verify) — run the smoke suite against a deployed env.

Steps 1–2 happen in the Microsoft Entra admin center, step 3 in a browser, step 4 in a
database client, step 5 in GitHub. See the access you need for each below.

---

## Prerequisites & access you need

This task spans **three separate systems**. Confirm you can reach each one (and have the
right role) before you start. If you lack the access listed, that step is a request to the
team named in the "who to ask" column — you can still do the other steps.

| System | Where to go | Access / role required | If you don't have it — who to ask |
|--------|-------------|------------------------|-----------------------------------|
| **Microsoft Entra admin center** (create the user + set the MFA/CA exemption) | `https://entra.microsoft.com` — or `https://portal.azure.com` then search **"Microsoft Entra ID"** in the top search bar | **User Administrator** to create the user (Step 1). **Conditional Access Administrator** *or* **Security Administrator** (or **Global Administrator**) to set the MFA/CA exemption (Step 2). | Your **IT / identity (Azure AD) team** — ask them to create the account and/or apply the CA exemption. You can hand them Steps 1–2 verbatim. |
| **The target environment's Apex database** (grant project access) | A SQL client (psql, Azure Data Studio, or pgAdmin) pointed at the **deployed dev / staging** Postgres, using that env's `DATABASE_URL` connection string | **Connection access** to the dev/staging Apex Postgres (the same `DATABASE_URL` the deploy uses). **Prod needs nothing here.** | Whoever **owns the deploy / database** (holds the `DATABASE_URL` secret). You can hand them the one-line SQL in Step 4 to run for you. |
| **GitHub repository settings** (add the secrets) | `https://github.com/<org>/<repo>/settings/secrets/actions` — or repo → **Settings** → **Secrets and variables** → **Actions** | **Repository admin** (Settings is only visible to repo admins) | A **repo admin / maintainer** — ask them to add the two secrets, or to grant you admin. |

> `<org>/<repo>` is this repository's GitHub path (e.g. the URL you cloned from). The
> `.env` / deployed `AZURE_TENANT_ID` identifies which Entra tenant to sign into; you don't
> need to know its value to create a user, only to be an admin in that tenant.

---

## 0. Background — what this account is (and is NOT)

- Apex authenticates users with **Azure AD OIDC** via `passport-azure-ad`
  (`src/server/routes/auth.ts`). The app uses a **single existing app registration**,
  configured through these env vars (see `.env.example` / `deploy.yml`):
  - `AZURE_TENANT_ID` — the Entra tenant (real value lives in `.env`, injected in CI
    from `AZURE_CREDENTIALS.tenantId`).
  - `AZURE_CLIENT_ID` — the app registration's client ID.
  - `AZURE_CLIENT_SECRET` — the app registration's client secret.
  - `AZURE_REDIRECT_URL` — fallback redirect URL.
  - OIDC scopes requested at login: `profile openid email offline_access User.Read`.
- **You do NOT create a new app registration.** The test account is just an ordinary
  **user** in the same tenant who can sign in through the app that is already registered
  and admin-consented. It only needs to (a) exist in the tenant, (b) complete a
  **non-interactive** sign-in, and (c) have enough in-app access to see the pages the
  authenticated smoke tests assert on.

### How CI authenticates now (final state)

CI runs **fully-automated programmatic Azure AD SSO**. A dedicated Playwright **`setup`
project** (`tests/e2e/support/auth.setup.ts`) drives the real Microsoft/Entra login form
each run using the dedicated test account, then writes an **ephemeral, gitignored**
`storageState` to `tests/e2e/.auth/deployed.json` (produced fresh every run — there is
**no** stored or manually-captured session blob, and no base64 secret). The
`deployed-smoke` project then `dependencies: ['setup']` and reuses that fresh session.
See `playwright.config.ts`, `.github/workflows/pr-tests.yml`, `.github/workflows/deploy.yml`.

Credentials are supplied via two GitHub **secrets**:

- `E2E_TEST_USER` — the test account UPN/email.
- `E2E_TEST_PASSWORD` — the test account password.

Auth model per environment:

| Environment | Auth | Credentials / setup project |
|-------------|------|-----------------------------|
| Deployed Dev | Programmatic Azure AD SSO (`setup`) | `E2E_TEST_USER` + `E2E_TEST_PASSWORD` |
| Staging slot | Programmatic Azure AD SSO (`setup`) | `E2E_TEST_USER` + `E2E_TEST_PASSWORD` |
| Production | **Unauthenticated** (`--grep @prod-safe`) | **none** — no creds, no `setup` project, no in-app grant |

> An **optional local fallback** exists — `npm run test:e2e:auth:capture` +
> `E2E_STORAGE_STATE` — used **only** when no `E2E_TEST_USER`/`E2E_TEST_PASSWORD` are set
> (e.g. debugging a tenant login page the automated selectors can't yet drive). CI does
> not use it. See Section 7.

### Redirect URIs (Reply URLs) the app registration must allow

`auth.ts` builds the redirect URL per host as `<proto>://<host>/auth/callback`. Confirm
the app registration's **Authentication → Redirect URIs** include every host the account
signs in against:

| Environment | Redirect URI |
|-------------|--------------|
| Local dev | `http://localhost:3001/auth/callback` |
| Deployed Dev | `https://app-scrum-dev.azurewebsites.net/auth/callback` |
| Staging slot | `https://app-apex-prd-staging.azurewebsites.net/auth/callback` |
| Production | `https://app-apex-prd.azurewebsites.net/auth/callback` |

These already exist for real users; you only need to verify them, not add them, unless a
sign-in fails with `redirect_uri mismatch`.

---

## 1. Create the Entra user

*(System: Microsoft Entra admin center — needs **User Administrator**.)*

Step by step, starting from a fresh browser:

1. Go to **`https://entra.microsoft.com`** and sign in with your **admin** account
   (not the test account — the one that has User Administrator).
   - Alternative: `https://portal.azure.com` → type **"Microsoft Entra ID"** in the top
     search bar → open it.
2. In the **left navigation**, expand **Identity** → **Users** → **All users**.
   (In the classic Azure portal view it's **Microsoft Entra ID** → **Users**.)
3. Click **+ New user** (top toolbar) → choose **Create new user**.
4. Fill in the **Basics** tab using the table below, then click **Review + create** →
   **Create**.

Field values (recommended template — adjust to your tenant):

| Field | Recommended value | Notes |
|-------|-------------------|-------|
| User principal name | `apex-e2e-test@<yourtenantdomain>` | The part after `@` is your tenant's verified domain. Find it in **Entra ID → Overview → Primary domain**, or from the `@…` suffix of any real user (e.g. `…@amergis.com`). **This UPN becomes the `E2E_TEST_USER` secret.** |
| Display name | `Apex E2E Test` | Clearly marks the account as automation-only. |
| Password | *A strong password you choose* | Uncheck "Auto-generate" so you control it. **This value becomes the `E2E_TEST_PASSWORD` secret.** Store it in your team password vault — never in the repo. |
| Account enabled | ✅ Enabled | Must be enabled to sign in. |
| Usage location | Your org's country (e.g. United States) | Sometimes required before licenses/sign-in. |

> **Tip:** after creation, open the new user's page and note/copy the **User principal
> name** exactly — you'll paste it as the `E2E_TEST_USER` secret in Step 5.

> The account does **not** need any Microsoft 365 / Graph license for Apex SSO — Apex only
> reads basic profile + email claims. Assign a license only if your tenant blocks
> sign-in for unlicensed users.

---

## 2. MFA / Conditional Access exemption (critical — now doubly so)

*(System: Microsoft Entra admin center — needs **Conditional Access Administrator** or
**Security Administrator**, or **Global Administrator**. If Step 1 was done by your IT team,
this is the same request — send it together.)*

Because login is now **fully programmatic**, this is a hard prerequisite. Programmatic
login **cannot** satisfy an interactive MFA prompt or a blocking Conditional Access (CA)
policy — the `setup` project would hang on the MFA screen and time out.

Do **one** of the following (least-privilege, in preference order):

1. **Exclude the account from CA/MFA policies (preferred).** Starting from
   **`https://entra.microsoft.com`**:
   - Left nav: **Protection** → **Conditional Access** → **Policies**. (Older view:
     **Microsoft Entra ID** → **Security** → **Conditional Access**.)
   - For **each** policy that requires MFA or blocks automation/legacy sign-in, click it →
     under **Assignments** click **Users** → open the **Exclude** tab → **Select users and
     groups** → tick **Users and groups** → search for and add **`Apex E2E Test`** →
     **Select** → **Save** the policy.
   - Prefer excluding from a *dedicated* policy rather than your org-wide one.
2. **Create a dedicated scoped policy** instead: same **Conditional Access → Policies**
   screen → **+ New policy**. Target **only** this account under **Assignments → Users**,
   and under **Grant** choose **Grant access** without "Require multifactor authentication".
   Ideally **restrict by trusted IP / named location** (**Protection → Conditional Access →
   Named locations**) scoped to your CI runner egress. GitHub-hosted runners have dynamic
   IPs; if you can't pin them, restrict as tightly as your controls allow and monitor
   sign-ins.
3. **Per-user MFA (legacy only):** from `https://entra.microsoft.com` → **Identity** →
   **Users** → **All users** → **Per-user MFA** (toolbar) → find the account → set its MFA
   state to **Disabled**. Only relevant if your tenant still uses legacy per-user MFA.

> Apply the exemption for **dev + staging** (the environments that log in). **Prod needs
> no exemption** because prod runs unauthenticated.
>
> If MFA/CA genuinely cannot be bypassed, programmatic SSO is impossible. Fall back to the
> optional local `storageState` capture (Section 7) for manual debugging — but CI
> authenticated smoke on dev/staging will not pass without the exemption.

---

## 3. App consent / first sign-in

*(System: any web browser — no special access; just the test account's credentials.)*

- The Apex app registration is **already admin-consented** for its delegated scopes, so a
  normal tenant user does not need to grant consent individually.
- Still, do **one manual interactive sign-in** as the test account first, to clear any
  first-run consent screen, "stay signed in?" prompt, or password-change-on-first-login
  requirement:
  1. Open a browser (an incognito/private window avoids clashing with your own session)
     and go to the deployed dev site: **`https://app-scrum-dev.azurewebsites.net`**.
  2. Click **"Sign in with Amergis SSO"** and complete the login as
     `apex-e2e-test@<yourtenantdomain>` with the password you set.
  3. If prompted to **change the password on first sign-in**, do so now (and update your
     stored password so it matches what you'll put in the `E2E_TEST_PASSWORD` secret).
     Accept any "stay signed in?" prompt.
- This one-time interactive login makes later automated logins clean.

---

## 4. Grant in-app access (so authenticated tests see real pages)

*(System: the deployed environment's Apex Postgres database — needs connection access to
that env's `DATABASE_URL`. **Prod needs nothing here.** No access? Hand the SQL below to the
deploy/DB owner, or use the in-app UI alternative at the end of this section.)*

After SSO, Apex provisions the user on login (`src/server/routes/auth.ts`):
- `upsertAppUser(oid, displayName, email)` → inserts/updates the `app_users` row.
- `resolvePendingAssignments(oid, email)` → converts any matching
  `pending_project_assignments` (matched by **email**) into real
  `user_project_assignments` rows via `assignUserToProject`.

**Roles:** a fresh user with no explicit role automatically resolves to the **`member`**
role (it is the seeded default — `is_default = true` in
`migrations/1778778800000_rbac-tables.sql`). `member` already carries `calendar:view`,
`backlog:view`, chat, planning, etc. That is enough for the tagged authenticated
`@deployed-smoke` tests, which assert:
- the project selector prompt ("select a project to start planning"),
- the app shell with sidebar + header,
- `nav-item-calendar` and `nav-item-backlog` visible,
- direct navigation to `/calendar` and the interview dashboard loading.

So **no extra role assignment is required** beyond the default `member`.

**Project assignment (needed to enter a project):** the dev + staging smoke tests that
navigate into a project (`calendar-work-items`, `interview-dashboard`) need the account
assigned to a project. Least-privilege recommended path — add a **pending assignment by
email** so it auto-resolves on first login.

**Where this runs — read carefully:** the SQL below must run against the **deployed
environment's Apex Postgres** (dev, then staging if you smoke staging), **not** your local
`aipilot` database. That is the database the deployed app reads at runtime — the one whose
connection string is the env's `DATABASE_URL` secret used by the deploy.

**How to connect:**
1. Get the **dev** (and/or **staging**) `DATABASE_URL` connection string from the
   deploy/DB owner (it's the same value the pipeline injects as `DATABASE_URL`). It looks
   like `postgresql://<user>:<password>@<host>:5432/<db>?sslmode=require`.
2. Open a SQL client and connect with it. Any of these work:
   - **psql**: `psql "<the DATABASE_URL>"`
   - **Azure Data Studio** or **pgAdmin**: New Connection → paste host / db / user /
     password from the string (enable SSL).
3. Run the statement (replace the UPN with your account, and `MaxView` with the project the
   smoke tests target in that env):

```sql
-- Least-privilege: assign the E2E test account to the smoke test project.
-- Resolves to a real user_project_assignments row automatically on next login.
INSERT INTO pending_project_assignments (email, project, assigned_by, assigned_at)
VALUES ('apex-e2e-test@<yourtenantdomain>', 'MaxView', 'e2e-setup', now())
ON CONFLICT DO NOTHING;
```

4. Repeat against the **staging** DB if you run staging smoke.

**No DB access?** Either (a) paste the one line above to the deploy/DB owner and ask them
to run it against the dev/staging DB, **or** (b) after the test account's first sign-in
(Step 3) — which creates its `app_users` row — ask a **Project Admin** to add the account
in-app: open Apex on that env → **Project Admin** → **Users** → add
`apex-e2e-test@<yourtenantdomain>` to the target project. Either path achieves the same
`user_project_assignments` row.

**Do NOT add the account to the super-admin allowlist** unless you specifically need
platform-admin coverage. That allowlist lives in code
(`src/server/utils/superAdmin.ts`, per-env `SUPER_ADMIN_EMAILS_BY_ENV`), so adding the
account there is a **code change + redeploy** — heavier than needed and over-privileged
for read-only smoke.

**Production needs no in-app grant.** Prod smoke runs only the `@prod-safe` subset
**unauthenticated** — no login happens, so there is no user to provision and no project or
role to assign on the prod DB.

---

## 5. GitHub secrets / variables to set

*(System: GitHub repository settings — needs **repository admin**.)*

Get to the right page:

- Go to **`https://github.com/<org>/<repo>/settings/secrets/actions`** (replace
  `<org>/<repo>` with this repo's path).
- Or navigate: open the repo on GitHub → **Settings** (top tab) → in the left sidebar
  expand **Secrets and variables** → **Actions**.
- This page has two tabs: **Secrets** and **Variables**. The credentials go under
  **Secrets**; the base URLs go under **Variables**.

### Add the two secrets (Secrets tab — the CI auth credentials)

On the **Secrets** tab, under **Repository secrets**:

1. Click **New repository secret**.
2. **Name:** `E2E_TEST_USER` — **Secret (value):** the UPN from Step 1, e.g.
   `apex-e2e-test@<yourtenantdomain>`. Click **Add secret**.
3. Click **New repository secret** again.
4. **Name:** `E2E_TEST_PASSWORD` — **Secret (value):** the password from Step 1. Click
   **Add secret**.

| Secret | Value to set | Used by |
|--------|--------------|---------|
| `E2E_TEST_USER` | The UPN from Section 1, e.g. `apex-e2e-test@<yourtenantdomain>` | `deployed-smoke-dev` (`pr-tests.yml`), `deployed-smoke-staging` (`deploy.yml`) |
| `E2E_TEST_PASSWORD` | The password from Section 1 | `deployed-smoke-dev`, `deployed-smoke-staging` |

> GitHub never shows a secret's value again after you save it — that's expected. To change
> it later, open the secret and click **Update**.
>
> **Prod uses no secrets** — `deployed-smoke-prod` passes no credentials and runs the
> `@prod-safe` subset unauthenticated. Without these two secrets, dev/staging fall back to
> only the unauthenticated boundary passing.

### Add the base URLs (Variables tab — optional; defaults used if unset)

Switch to the **Variables** tab on the same page → **New repository variable** → add each
below (Name / Value). These are non-secret; skip them entirely to accept the defaults. The
workflows read these `vars.*` and pass them to Playwright as `E2E_BASE_URL`.

| Variable | Value to set | Default if unset |
|----------|--------------|------------------|
| `E2E_DEV_BASE_URL` | `https://app-scrum-dev.azurewebsites.net` | `https://app-scrum-dev.azurewebsites.net` |
| `E2E_STAGING_BASE_URL` | `https://app-apex-prd-staging.azurewebsites.net` | `https://app-apex-prd-staging.azurewebsites.net` (the pre-swap staging slot) |
| `E2E_PROD_BASE_URL` | `https://app-apex-prd.azurewebsites.net` | `https://app-apex-prd.azurewebsites.net` |

> `E2E_*_STORAGE_STATE_B64` secrets are **no longer used** — the previous base64
> `storageState` approach has been replaced by programmatic SSO. Remove any stale copies.

---

## 6. Verify

Test the account locally against a deployed environment before relying on CI. Setting the
credentials enables the `setup` project, which logs in and produces the fresh ephemeral
`storageState` the `deployed-smoke` project consumes:

```powershell
# Dev / staging — programmatic SSO (authenticated):
$env:E2E_BASE_URL="https://app-scrum-dev.azurewebsites.net"
$env:E2E_TEST_USER="apex-e2e-test@<yourtenantdomain>"
$env:E2E_TEST_PASSWORD="<the-account-password>"
npx playwright test --project=deployed-smoke

# Prod-safe subset — UNAUTHENTICATED (do NOT pass credentials for prod):
$env:E2E_BASE_URL="https://app-apex-prd.azurewebsites.net"
npx playwright test --project=deployed-smoke --grep "@prod-safe"
```

Expected: the `setup` project completes the Entra login and writes
`tests/e2e/.auth/deployed.json`; the authenticated tests (project selector, app shell,
calendar/backlog nav) pass once the account has the project assignment from Section 4. For
prod, only the unauthenticated login-boundary test is expected to pass.

### Entra login-form selector caveat (per-tenant)

`auth.setup.ts` drives the Microsoft/Entra login form using the well-known Entra element
ids, with generic fallbacks:

| Step | Primary selector | Fallback |
|------|------------------|----------|
| Email field | `#i0116` | `input[type=email]` |
| Password field | `#i0118` | `input[type=password]` |
| Next / Sign in / "Yes" button | `#idSIButton9` | `input[type=submit]` |

If Amergis's tenant customises the login page, these **may need per-tenant adjustment** —
update the locators in `tests/e2e/support/auth.setup.ts` **and nowhere else**.

---

## 7. Optional local fallback — manual SSO storageState capture

Not used by CI. Available only for local debugging (e.g. a tenant login page the automated
selectors can't yet drive). Run it **without** `E2E_TEST_USER`/`E2E_TEST_PASSWORD`:

```powershell
$env:E2E_BASE_URL="https://app-scrum-dev.azurewebsites.net"
$env:E2E_STORAGE_STATE="tests/e2e/.auth/dev.storageState.json"   # optional; defaults to tests/e2e/.auth/storageState.json
npm run test:e2e:auth:capture
```

A headed browser opens; log in as the dedicated **E2E test account**, then press ENTER to
save the `storageState`. Re-run smoke with the same `E2E_STORAGE_STATE` set (and no
credentials). Never commit the file — `tests/e2e/.auth/` is gitignored.

---

## Quick reference — facts pulled from this repo

- **Deployed URLs:** dev `https://app-scrum-dev.azurewebsites.net`; staging slot
  `https://app-apex-prd-staging.azurewebsites.net`; prod `https://app-apex-prd.azurewebsites.net`.
- **Auth vars:** `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
  `AZURE_REDIRECT_URL` (`.env` / `deploy.yml`). Scopes: `profile openid email
  offline_access User.Read`.
- **Existing app registration is reused** — no new registration for the test account.
- **CI auth = programmatic Azure AD SSO** via the `setup` project
  (`tests/e2e/support/auth.setup.ts`), using secrets `E2E_TEST_USER` + `E2E_TEST_PASSWORD`
  on dev + staging. Ephemeral session at `tests/e2e/.auth/deployed.json`; no stored blob.
- **Prod is unauthenticated** — `@prod-safe` subset, no credentials, no in-app grant.
- **Base-URL vars:** `E2E_DEV_BASE_URL`, `E2E_STAGING_BASE_URL`, `E2E_PROD_BASE_URL`.
- **Default role = `member`** (seeded `is_default`), which satisfies the authenticated
  smoke assertions; add only a project assignment for in-project navigation.
- **Entra selectors:** `#i0116` (email), `#i0118` (password), `#idSIButton9` (Next/Sign
  in/Yes), with `input[type=email|password|submit]` fallbacks — tune per tenant in
  `auth.setup.ts`.
