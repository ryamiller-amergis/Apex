# APEX — Teams Notification Bot Manifests

This folder contains the Microsoft Teams app packages for the APEX notification bot.
The bot sends proactive Adaptive Cards to users in Teams when they are assigned to
interviews or reviews, driven by `src/server/services/teamsBotService.ts`.

There is **one bot per environment**, each backed by its own Entra app registration
and its own Azure Bot resource. Both can be installed by the same user at the same
time, because the two Teams app packages use different app IDs.

| | Production | Development |
|---|---|---|
| Teams display name | `APEX Bot` | `APEX Bot - Dev` |
| Manifest | `prod/manifest.json` | `dev/manifest.json` |
| Teams app ID | `2f0071fc-b6cd-45a5-ae0d-f3bdfa0271c6` | `1d3382ad-f82f-4ea2-9cfe-56f2fbbb539f` |
| Bot app ID | _see Part A — not yet created_ | `1d3382ad-f82f-4ea2-9cfe-56f2fbbb539f` |
| Messaging endpoint | `https://apex.amergis.com/api/messages` | `https://app-scrum-dev.azurewebsites.net/api/messages` |
| App Service | `app-apex-prd` (`rg-apex-prd-app`) | `app-scrum-dev` |
| Icon | Blue | Amber, with a `DEV` band |

> The Teams app ID and the bot app ID are separate identifiers. Dev happens to use the
> same GUID for both for historical reasons; prod does not. Never reuse a Teams app ID
> across environments — Teams would treat the two packages as the same app and installing
> one would replace the other.

---

## Part A — Create the production bot in the Azure Portal

Only needed once. Requires an account that can create Entra app registrations and
Azure resources in `rg-apex-prd-app`.

Keep a scratch note open — steps A1 and A2 produce two values you need later:

| Value | Produced in | Used in |
|---|---|---|
| Prod bot **app ID** | A1 | A3, A6, A7 |
| Prod bot **client secret** | A2 | A6 only |

### A1. Create the Entra app registration

1. Go to the [Azure Portal](https://portal.azure.com) → **Microsoft Entra ID** → **App registrations**.
2. Click **+ New registration**.
3. **Name:** `APEX Bot`
4. **Supported account types:** *Accounts in this organizational directory only (Single tenant)*.
   This must be single-tenant to match `MicrosoftAppType: 'SingleTenant'` in `teamsBotService.ts`.
5. Leave **Redirect URI** empty — the bot authenticates with a client secret, not a redirect flow.
6. Click **Register**.
7. On the **Overview** blade, copy the **Application (client) ID**. This is the prod bot app ID.
   Also note the **Directory (tenant) ID** — you need it in A3, and it should match the
   `AZURE_TENANT_ID` already configured on the app.

### A2. Create a client secret

1. Still in the app registration, go to **Certificates & secrets** → **Client secrets** tab.
2. Click **+ New client secret**.
3. **Description:** `apex-bot-prod`. **Expires:** 24 months.
4. Click **Add**.
5. Copy the **Value** column immediately — not the Secret ID. The value is masked as soon as
   you navigate away and cannot be retrieved afterwards.

Set a calendar reminder for the expiry date. When the secret lapses, Teams notifications stop
silently: `teamsBotService` catches and logs send failures rather than surfacing them to users.

### A3. Create the Azure Bot resource

1. In the portal, choose **Create a resource**, search for **Azure Bot**, and click **Create**.
2. Fill in the **Basics** tab:

   | Field | Value |
   |---|---|
   | Bot handle | `bot-apex-prd` (must be globally unique; immutable after creation) |
   | Subscription | the one containing `rg-apex-prd-app` |
   | Resource group | `rg-apex-prd-app` |
   | Data residency | Global |
   | Pricing tier | **Free (F0)** |
   | Type of App | **Single Tenant** |
   | Creation type | **Use existing app registration** |
   | App ID | the Application (client) ID from A1 |
   | App tenant ID | the Directory (tenant) ID from A1 |

   F0 covers Teams, which is a standard channel with unlimited messages. If F0 is unavailable,
   **S1** works identically for this use.

3. Click **Review + create**, then **Create**, and wait for deployment to finish.

### A4. Set the messaging endpoint

1. Open the new `bot-apex-prd` resource → **Settings** → **Configuration**.
2. Set **Messaging endpoint** to:

   ```
   https://apex.amergis.com/api/messages
   ```

3. Click **Apply**.

This route is registered in `src/server/index.ts` ahead of the session-auth middleware,
because Teams authenticates with its own bearer token rather than a session cookie.

### A5. Enable the Teams channel

1. In the same bot resource, go to **Settings** → **Channels**.
2. Click **Microsoft Teams** in the available channels list.
3. Select **Microsoft Teams Commercial**, accept the Terms of Service, and click **Apply**.
4. Confirm the channel shows as **Running** on the Channels list.

### A6. Set the app settings on the prod App Service

1. Go to **App Services** → **app-apex-prd** → **Settings** → **Environment variables**
   → **App settings** tab.
2. Click **+ Add** and create each of these, ticking **Deployment slot setting** on both:

   | Name | Value |
   |---|---|
   | `TEAMS_BOT_APP_ID` | Application (client) ID from A1 |
   | `TEAMS_BOT_APP_PASSWORD` | client secret **Value** from A2 |

3. Click **Apply**, then **Confirm**. The app restarts.

**Deployment slot setting** is the important checkbox. It pins both values to the production
slot so the staging slot does not inherit them during a swap. This is deliberate: with a shared
value, staging would send real notifications to real users from the production bot. Leaving the
settings absent on staging disables Teams delivery there, which is the behavior we want.

These settings are safe to manage by hand — `infra/main.tf` declares
`ignore_changes = [app_settings, ...]` on the web app, so a later `terraform apply` will not
remove them, and `deploy.yml` sets app settings with merge semantics rather than replacing the
whole map.

### A7. Fill in the manifest

Replace the `REPLACE_WITH_PROD_BOT_APP_ID` placeholder in `prod/manifest.json` with the
Application (client) ID from A1, and commit it. The bot app ID is not a secret; the client
secret is, and never belongs in this repo.

---

## Part B — Build the app packages

### B1. Generate the icons

Icons are not committed and must be generated before zipping.

1. Open `create-icons.html` in Chrome or Edge.
2. Under **Production**, download `color.png` and `outline.png`, then move both into `prod/`.
3. Under **Development**, download `color.png` and `outline.png`, then move both into `dev/`.

Move each pair before downloading the next, otherwise the browser saves the second pair as
`color (1).png`.

### B2. Zip

The three files must sit at the **root** of the zip, not inside a sub-folder. Run from the
workspace root in PowerShell:

```powershell
Compress-Archive -Path teams-app\prod\* -DestinationPath teams-app-prod.zip -Force
Compress-Archive -Path teams-app\dev\*  -DestinationPath teams-app-dev.zip  -Force
```

Verify the contents:

```powershell
[System.IO.Compression.ZipFile]::OpenRead((Resolve-Path teams-app-prod.zip)).Entries | Select-Object Name
```

Each zip should contain exactly `manifest.json`, `color.png`, and `outline.png`.

---

## Part C — Publish and update in the org app catalog

Both bots are distributed through the Teams org catalog, not per-user sideloading.

Do the dev rename **first**, so there is never a moment where two catalog entries are both
called "APEX Bot".

### C1. Rename the already-deployed dev app

Nothing about the running dev bot changes. Leave its app registration, client secret,
messaging endpoint, Teams channel, and the `TEAMS_BOT_APP_ID` / `TEAMS_BOT_APP_PASSWORD`
settings on `app-scrum-dev` exactly as they are. Because the bot app ID is unchanged, every
conversation reference already stored in the dev database stays valid — existing users keep
receiving dev notifications through the rename without reinstalling anything.

The only change that matters is the catalog listing, because the name shown in a user's Teams
chat list comes from the manifest's `name.short`, not from anything in Azure.
`dev/manifest.json` keeps the original Teams app ID and bumps `version` to `1.0.2`, so this is
an **update in place**.

1. Open the [Teams Admin Center](https://admin.teams.microsoft.com).
2. Go to **Teams apps → Manage apps** and search for **APEX Bot**.
3. Open the app and use **Update** — *not* **Upload new app** — then select `teams-app-dev.zip`.
   Uploading it as a new app would either be rejected as a duplicate app ID or create a second
   parallel listing.
4. Confirm the listing now reads **APEX Bot - Dev**.

#### Optional — matching renames in Azure

Neither of these affects what users see in Teams; they only stop the portal from being
confusing once a second bot exists.

**Azure Bot resource display name.** Open the dev bot resource → **Settings** →
**Configuration**, set **Display Name** to `APEX Bot - Dev`, and click **Apply**. The resource
name / bot handle itself is immutable — only the display name can change. If you cannot find
the resource, search the portal for the dev bot app ID `1d3382ad-f82f-4ea2-9cfe-56f2fbbb539f`,
or filter **All resources** by type *Azure Bot*.

**Entra app registration name.** Go to **Microsoft Entra ID** → **App registrations**, open the
registration with that same app ID, then **Branding & properties** → set **Name** to
`APEX Bot - Dev` → **Save**.

### C2. Publish the new production app

1. In **Teams apps → Manage apps**, click **Actions → Upload new app** and select
   `teams-app-prod.zip`. This one *is* a new app — it carries a different Teams app ID.
2. Once uploaded, find **APEX Bot** in the list and set its **Status** to **Allowed**.
3. Publishing to the catalog makes the app available; it does not install it. Either let
   users add it themselves from **Apps → Built for your org**, or push it out via
   **Teams apps → Setup policies** by adding it to the **Installed apps** list on the
   relevant policy.

Each user must add the app once so the bot receives an `installationUpdate` activity and
stores their conversation reference in `teams_conversation_references`. Until that happens
they will receive in-app notifications but no Teams messages. Prod starts with an empty table
here — dev's references are deliberately not migrated, since they belong to the dev bot.

Keep the dev app scoped to the people who test against dev rather than adding it to an
org-wide setup policy.

### C3. Verify

1. In Teams, confirm both **APEX Bot** and **APEX Bot - Dev** appear as separate chats.
2. Trigger a notification in prod (for example, assign yourself as a reviewer) and confirm
   the card arrives from **APEX Bot** and that its **View** button opens an
   `apex.amergis.com` URL.
3. Repeat against dev and confirm the card arrives from **APEX Bot - Dev** with an
   `app-scrum-dev.azurewebsites.net` URL.

If a card never arrives, check the App Service log stream for
`[teamsBotService] Failed to send Teams notification`.

---

## Environment variables

Both are read in `src/server/services/teamsBotService.ts` and documented in `.env.example`.

| Variable | Purpose |
|---|---|
| `TEAMS_BOT_APP_ID` | Bot app ID for the environment's Entra app registration |
| `TEAMS_BOT_APP_PASSWORD` | Client secret for that registration |
| `AZURE_TENANT_ID` | Tenant for single-tenant bot auth; already set in all environments |
| `AZURE_REDIRECT_URL` | Base URL for the card's **View** deep link, with `/auth/callback` stripped |

Leaving `TEAMS_BOT_APP_ID` unset disables Teams delivery for that environment — in-app
notifications are unaffected.

---

## Files in this folder

| File | Description |
|---|---|
| `prod/manifest.json` | Production Teams manifest (`APEX Bot`) |
| `dev/manifest.json` | Development Teams manifest (`APEX Bot - Dev`) |
| `create-icons.html` | Browser-based generator for both icon sets |
| `README.md` | This file |
| `prod/color.png`, `prod/outline.png` | Generated, not committed |
| `dev/color.png`, `dev/outline.png` | Generated, not committed |
