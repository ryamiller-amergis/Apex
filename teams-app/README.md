# Scrum App — Teams Notification Bot Manifest

This folder contains the Teams app manifest package for the Scrum notification bot.
The bot sends proactive messages to users in Teams when they are assigned to interviews or reviews.

---

## Step 1 — Generate the icons

The manifest references two PNG icons that must be present in this folder before zipping.

1. Open `create-icons.html` in any modern browser (double-click the file or drag it into Chrome/Edge).
2. Click **Download color.png (192×192)** and save it as `color.png` in this folder.
3. Click **Download outline.png (32×32)** and save it as `outline.png` in this folder.

---

## Step 2 — Zip the package

The zip file must contain `manifest.json`, `color.png`, and `outline.png` **at the root** (not inside a sub-folder).

Run this from the **workspace root** in PowerShell:

```powershell
Compress-Archive -Path teams-app\manifest.json, teams-app\color.png, teams-app\outline.png -DestinationPath teams-app.zip -Force
```

Verify the zip contents before uploading:

```powershell
[System.IO.Compression.ZipFile]::OpenRead((Resolve-Path teams-app.zip)).Entries | Select-Object Name
```

You should see exactly three files: `manifest.json`, `color.png`, `outline.png`.

---

## Step 3 — Sideload in Teams

1. Open **Microsoft Teams**.
2. In the left rail, click **Apps**.
3. Click **Manage your apps** (bottom-left).
4. Click **Upload a custom app**.
5. Choose **Upload to me** (installs the bot for your personal use only).
6. Select `teams-app.zip`.
7. Click **Add** on the app details dialog.

After installation, the bot will appear in your **Chat** list. The Scrum app server will use your stored conversation reference to send you proactive notifications.

> **Note:** If **Upload a custom app** is not visible, a Teams administrator needs to enable it:
> Teams Admin Center → **Teams apps** → **Setup policies** → **Global (Org-wide default)** → turn on **Upload custom apps** → Save.

---

## Files in this folder

| File | Description |
|---|---|
| `manifest.json` | Teams app manifest (v1.17) |
| `color.png` | 192×192 color icon (generate with create-icons.html) |
| `outline.png` | 32×32 outline icon (generate with create-icons.html) |
| `create-icons.html` | Browser-based icon generator |
| `README.md` | This file |

---

## Bot details

| Field | Value |
|---|---|
| Bot App ID | `1d3382ad-f82f-4ea2-9cfe-56f2fbbb539f` |
| Scope | `personal` only |
| Notification only | `true` |
| Valid domain | `app-scrum-dev.azurewebsites.net` |
