# APEX — Teams Notification Bot Manifests

This folder contains the Microsoft Teams app packages for the APEX notification bot.
The bot sends proactive Adaptive Cards to users in Teams when they are assigned to
interviews or reviews, driven by `src/server/services/teamsBotService.ts`.

There is **one bot per environment**, each backed by its own Entra app registration
and its own Azure Bot resource. Both can be installed by the same user at the same
time, because the two Teams app packages use different app IDs.

| | Production | Development |
|---|---|---|
| Teams display name | `APEX` | `APEX Bot` |
| Manifest | `prod/manifest.json` | `dev/manifest.json` |
| Teams app ID | `2f0071fc-b6cd-45a5-ae0d-f3bdfa0271c6` | `1d3382ad-f82f-4ea2-9cfe-56f2fbbb539f` |
| Bot app ID | `2cc05d99-fad4-4eb9-a9e6-0b926684f5dd` | `1d3382ad-f82f-4ea2-9cfe-56f2fbbb539f` |
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

> **Status:** A1, A2, and A7 are done — the registration exists with app ID
> `2cc05d99-fad4-4eb9-a9e6-0b926684f5dd` and its secret has been generated. A3 through A6
> remain. The steps are kept below so the bot can be rebuilt from scratch if needed.

### A1. Create the Entra app registration

1. Go to the [Azure Portal](https://portal.azure.com) → **Microsoft Entra ID** → **App registrations**.
2. Click **+ New registration**.
3. **Name:** `APEX` — this is the Entra registration name, visible only in the Azure portal.
   It is independent of the `name.short` in the manifest, which is what Teams users see.
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

### A7. Fill in the manifest — already done

`prod/manifest.json` carries `botId: 2cc05d99-fad4-4eb9-a9e6-0b926684f5dd`. If the prod bot is
ever rebuilt against a different app registration, update that field to match.

The bot app ID is not a secret. The client secret is, and never belongs in this repo — it lives
only in the `TEAMS_BOT_APP_PASSWORD` app setting from A6.

---

## Part B — Build the app packages

### B1. Icons

Both icon pairs are committed alongside their manifests — `prod/` has the blue set and `dev/`
has the amber set with the `DEV` band — so you can skip straight to zipping.

Only if you change the artwork: open `create-icons.html` in Chrome or Edge, download the
**Production** pair and move it into `prod/`, then download the **Development** pair and move
it into `dev/`. Move each pair before downloading the next, otherwise the browser saves the
second pair as `color (1).png`.

### B2. Zip

The three files must sit at the **root** of the zip, not inside a sub-folder. Run from the
workspace root in PowerShell:

```powershell
Compress-Archive -Path teams-app\prod\* -DestinationPath teams-app-prod.zip -Force
Compress-Archive -Path teams-app\dev\*  -DestinationPath teams-app-dev.zip  -Force
```

Verify the contents:

```powershell
$zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path teams-app-prod.zip))
$zip.Entries | Select-Object Name
$zip.Dispose()
```

Dispose the handle. Leaving it open locks the file, and the next `Compress-Archive -Force`
fails with "the process cannot access the file".

Each zip should contain exactly `manifest.json`, `color.png`, and `outline.png`.

---

## Part C — Publish and update in the org app catalog

Both bots are distributed through the Teams org catalog, not per-user sideloading.

Production is published as **APEX**; dev keeps the name it already has, **APEX Bot**. Because
the two names differ, the order of C1 and C2 does not matter.

### C1. Refresh the already-deployed dev app

**The dev app is not renamed.** It is already called `APEX Bot` in the catalog and stays that
way. Nothing about the running dev bot changes either — leave its app registration, client
secret, messaging endpoint, Teams channel, and the `TEAMS_BOT_APP_ID` /
`TEAMS_BOT_APP_PASSWORD` settings on `app-scrum-dev` exactly as they are. The bot app ID is
unchanged, so every conversation reference already stored in the dev database stays valid and
existing users keep receiving dev notifications without reinstalling anything.

What does change is the artwork and description: dev picks up the amber `DEV` icon and an
accent color that tell it apart from production at a glance. With prod named `APEX` and dev
named `APEX Bot`, the icon is the clearest signal of which environment a card came from, so
this step is worth doing rather than skipping.

`dev/manifest.json` keeps the original Teams app ID and bumps `version` to `1.0.2`, so this is
an **update in place**.

1. Open the [Teams Admin Center](https://admin.teams.microsoft.com).
2. Go to **Teams apps → Manage apps** and search for **APEX Bot**.
3. Open the app and use **Update** — *not* **Upload new app** — then select `teams-app-dev.zip`.
   Uploading it as a new app would either be rejected as a duplicate app ID or create a second
   parallel listing.
4. Confirm the listing still reads **APEX Bot** and now shows the amber icon.

#### Optional — Azure display names

Neither of these affects what users see in Teams; they only stop the portal from being
confusing once a second bot exists. The dev Azure Bot resource and its Entra app registration
can be suffixed with `- Dev` so they are not mistaken for the production pair.

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
2. Once uploaded, find **APEX** in the list and set its **Status** to **Allowed**.
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

1. In Teams, confirm **APEX** and **APEX Bot** appear as two separate chats, with the blue and
   amber icons respectively.
2. Trigger a notification in prod (for example, assign yourself as a reviewer) and confirm
   the card arrives from **APEX** and that its **View** button opens an
   `apex.amergis.com` URL.
3. Repeat against dev and confirm the card arrives from **APEX Bot** with an
   `app-scrum-dev.azurewebsites.net` URL.

The **View** link target is the reliable way to tell the two apart if you are unsure which
environment a card came from.

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
| `prod/manifest.json` | Production Teams manifest (`APEX`) |
| `dev/manifest.json` | Development Teams manifest (`APEX Bot`) |
| `prod/color.png`, `prod/outline.png` | Production icons — blue |
| `dev/color.png`, `dev/outline.png` | Development icons — amber with a `DEV` band |
| `create-icons.html` | Browser-based generator, only needed to change the artwork |
| `README.md` | This file |
