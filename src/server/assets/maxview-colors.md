# Maxview Colors — Light Theme

> Canonical color palette for the Maxview design system. AI agents and developers **must** use these exact values when generating UI for this project. Do not invent hex/rgba values; pick the closest semantic token from the tables below.
>
> Machine-readable companion: [`maxview-colors.json`](./maxview-colors.json)
> Source: Figma — `MaxviewColorsStylesLight`

## How to use this file

- Pick by **semantic role**, not visual similarity. Use `error.main` for errors, not `#e43443`.
- The `*p` suffix denotes alpha overlays (e.g. `4p` = 4% opacity of the base). Use them for hover / selected / focus states.
- `*.contrast` is always the foreground color guaranteed to pass AA contrast on top of `*.main`.
- `160p` = 60% black over the base (Alert content). `190p` = 90% white over the base (Alert background).

---

## Text

| Token            | Value                       | Usage                                       |
|------------------|-----------------------------|---------------------------------------------|
| `text.primary`   | `#0a0d1a`                   | Default body and heading text               |
| `text.secondary` | `#3e4c5f`                   | Supporting text, captions, labels           |
| `text.disabled`  | `rgba(62,76,95,0.38)`       | Disabled controls and inactive labels       |
| `text.muted`     | `#bebebe`                   | Mobile-only muted text                      |

## Background

| Token                | Value                                                          | Usage                              |
|----------------------|----------------------------------------------------------------|------------------------------------|
| `background.paper`   | `#ffffff`                                                      | Card / surface background          |
| `background.default` | `linear-gradient(-14.8deg, #dee9f7 45.9%, #ffffff 43.6%)`      | Page-level background gradient     |
| `background.gray`    | `#f1f3f5`                                                      | Subtle gray surface                |

## UI Surfaces & Borders

| Token                          | Value                       | Usage                                                      |
|--------------------------------|-----------------------------|------------------------------------------------------------|
| `ui.chipDefault`               | `#e7eaed`                   | Default Chip background                                    |
| `ui.divider`                   | `#e7eaed`                   | Dividers separating content                                |
| `ui.outlineBorder`             | `#919aa5`                   | Outlined components at rest (TextField, Select, Chip)      |
| `ui.standardInputLine`         | `#919aa5`                   | Underline for standard variant TextField & Select          |
| `ui.backdropOverlay`           | `rgba(136,153,175,0.5)`     | Modal/dialog backdrop overlay                              |
| `ui.ratingActive`              | `#fcd757`                   | Active state for Rating component                          |
| `ui.snackbarBackground`        | `#3e4c5f`                   | Snackbar background                                        |
| `ui.cardHeader`                | `#e7eaed`                   | Card header background                                     |
| `ui.tooltipDefault`            | `#4a4e60`                   | Default tooltip background                                 |
| `ui.quickActionButtonBorder`   | `#8995b4`                   | Quick Action button border                                 |

## Primary

| Token              | Value                       | Usage                                  |
|--------------------|-----------------------------|----------------------------------------|
| `primary.main`     | `#323695`                   | Primary buttons, key UI accents        |
| `primary.dark`     | `#181c6c`                   | Primary hover state                    |
| `primary.light`    | `#b1b3d3`                   | Soft primary tint backgrounds          |
| `primary.contrast` | `#ffffff`                   | Text/icons on primary.main             |
| `primary.4p`       | `rgba(50,54,149,0.04)`      | Subtle hover background                |
| `primary.8p`       | `rgba(50,54,149,0.08)`      | Selected row / DataGrid hover          |
| `primary.12p`      | `rgba(50,54,149,0.12)`      | Button hover state                     |
| `primary.30p`      | `rgba(103,119,239,0.30)`    | Focus-visible ring                     |
| `primary.50p`      | `rgba(50,54,149,0.50)`      | Enabled outline state                  |

## Secondary

| Token                | Value                       | Usage                          |
|----------------------|-----------------------------|--------------------------------|
| `secondary.main`     | `#6777ef`                   | Secondary accents, buttons     |
| `secondary.dark`     | `#3e51c2`                   | Secondary hover state          |
| `secondary.light`    | `#c3c9fa`                   | Soft secondary tint            |
| `secondary.contrast` | `#ffffff`                   | Text/icons on secondary.main   |
| `secondary.4p`       | `rgba(103,119,239,0.04)`    | Hover background               |
| `secondary.8p`       | `rgba(50,54,149,0.08)`      | Selected state                 |
| `secondary.12p`      | `rgba(50,54,149,0.12)`      | Focus visible                  |
| `secondary.30p`      | `rgba(103,119,239,0.30)`    | Focus-visible ring             |
| `secondary.50p`      | `rgba(103,119,239,0.50)`    | Enabled state                  |

## Tertiary

| Token               | Value      | Usage                          |
|---------------------|------------|--------------------------------|
| `tertiary.main`     | `#a46bff`  | Tertiary accent                |
| `tertiary.dark`     | `#703dcb`  | Tertiary hover state           |
| `tertiary.light`    | `#d9c6ff`  | Soft tertiary tint             |
| `tertiary.contrast` | `#ffffff`  | Text/icons on tertiary.main    |

## Action (neutral interactive states)

| Token                       | Value                       | Usage                                  |
|-----------------------------|-----------------------------|----------------------------------------|
| `action.active`             | `#8899af`                   | Default icon / active control color    |
| `action.hover`              | `rgba(136,153,175,0.12)`    | Hover overlay on neutral controls      |
| `action.selected`           | `rgba(136,153,175,0.70)`    | Selected state                         |
| `action.disabled`           | `rgba(136,153,175,0.40)`    | Disabled icon / control                |
| `action.disabledBackground` | `rgba(136,153,175,0.12)`    | Disabled background fill               |
| `action.focus`              | `rgba(136,153,175,0.12)`    | Focus overlay                          |

## Error

| Token            | Value                       | Usage                                   |
|------------------|-----------------------------|-----------------------------------------|
| `error.main`     | `#e43443`                   | Error icons and bold text               |
| `error.dark`     | `#871c1c`                   | Error text and hover state              |
| `error.light`    | `#e9b9b9`                   | Error backgrounds only                  |
| `error.contrast` | `#ffffff`                   | Text/icons on error.main                |
| `error.4p`       | `rgba(228,52,67,0.04)`      | Hover background                        |
| `error.12p`      | `rgba(228,52,67,0.12)`      | Focus visible                           |
| `error.30p`      | `rgba(228,52,67,0.30)`      | Focus-visible ring                      |
| `error.50p`      | `rgba(228,52,67,0.50)`      | Enabled state                           |
| `error.160p`     | `#660202`                   | Alert content text                      |
| `error.190p`     | `#ffe6e6`                   | Alert background                        |

## Info

| Token           | Value                       | Usage                                    |
|-----------------|-----------------------------|------------------------------------------|
| `info.main`     | `#3363f5`                   | Info icons and bold text                 |
| `info.dark`     | `#193151`                   | Info text and hover state                |
| `info.light`    | `#7c9cff`                   | Info backgrounds                         |
| `info.contrast` | `#ffffff`                   | Text/icons on info.main                  |
| `info.4p`       | `rgba(51,99,245,0.04)`      | Hover background                         |
| `info.12p`      | `rgba(51,99,245,0.12)`      | Focus visible                            |
| `info.30p`      | `rgba(51,99,245,0.30)`      | Focus-visible ring                       |
| `info.50p`      | `rgba(51,99,245,0.50)`      | Enabled state                            |
| `info.160p`     | `#152858`                   | Alert content text                       |
| `info.190p`     | `#ebf0fe`                   | Alert background                         |

## Warning

| Token              | Value                        | Usage                                  |
|--------------------|------------------------------|----------------------------------------|
| `warning.main`     | `#ec7d22`                    | Warning icons and bold text            |
| `warning.dark`     | `#b84900`                    | Warning text and hover state           |
| `warning.light`    | `#ffecd6`                    | Warning backgrounds                    |
| `warning.contrast` | `#ffffff`                    | Text/icons on warning.main             |
| `warning.4p`       | `rgba(236,125,34,0.04)`      | Hover background                       |
| `warning.12p`      | `rgba(236,125,34,0.12)`      | Focus visible                          |
| `warning.30p`      | `rgba(236,125,34,0.30)`      | Focus-visible ring                     |
| `warning.50p`      | `rgba(236,125,34,0.50)`      | Enabled state                          |
| `warning.160p`     | `#5f2c01`                    | Alert content text                     |
| `warning.190p`     | `#fdf0e1`                    | Alert background                       |

## Success

| Token              | Value                       | Usage                                       |
|--------------------|-----------------------------|---------------------------------------------|
| `success.main`     | `#39c164`                   | Success icons and bold text                 |
| `success.dark`     | `#1c6232`                   | Success text and hover state                |
| `success.light`    | `#97dbac`                   | Success backgrounds only                    |
| `success.contrast` | `#ffffff`                   | Text/icons on success.main                  |
| `success.4p`       | `rgba(57,193,100,0.04)`     | Hover background                            |
| `success.12p`      | `rgba(57,193,100,0.12)`     | Hover state                                 |
| `success.20p`      | `rgba(57,193,100,0.20)`     | Success background on Alerts/Toasts         |
| `success.30p`      | `rgba(57,193,100,0.30)`     | Focus-visible ring                          |
| `success.50p`      | `rgba(38,208,124,0.50)`     | Enabled state                               |
| `success.160p`     | `#0f4d28`                   | Alert content text                          |
| `success.190p`     | `#e9faf2`                   | Alert background                            |

---

Canonical values live in [`maxview-colors.json`](./maxview-colors.json). If this Markdown drifts, the JSON wins.
