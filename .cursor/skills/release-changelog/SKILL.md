---
name: release-changelog
description: Generates an executive-level, platform-aware release changelog in Markdown from the work items (Epics, Features, PBIs, TBIs, and Bugs) associated with a release epic. Use when generating release notes or executive changelogs from Release Management or when asked to summarize a release epic by target platform.
model: composer-2.5
---

# Release Changelog

Generate a concise, executive-ready Markdown changelog for a single release epic from its associated Azure DevOps work items and target platform metadata.

## Audience & Tone

This document goes directly to leadership and stakeholders:

- Keep every bullet brief, high-level, and outcome-focused.
- Write in plain business language. Omit file paths, class names, PR numbers, database table names, and internal developer jargon.
- Lead with what users, customers, or operations gain rather than raw ticket mechanics.
- Do not pad with filler intros, disclaimers, or sign-offs.

## Smart Hierarchical Rollup

Associated items on a release may contain Epics, Features, standalone PBIs, TBIs, Bugs, or a mix:

1. **Epics and Features with child items**
   - Roll child PBIs, TBIs, and Bugs up into **one high-level capability bullet** per Feature (or 1–2 bullets for a broad Epic that spans distinct capabilities).
   - Use the child items to understand what actually shipped under the Feature, especially when the parent Feature is still marked `In Progress` awaiting final post-release closure.
   - Do **not** list every child PBI, TBI, or Bug individually beneath a Feature unless a specific fix or sub-capability warrants a brief clause in that Feature's summary.

2. **Standalone PBIs / User Stories**
   - Summarize each distinct user-facing enhancement in one crisp bullet. Combine closely related small PBIs into a single bullet when they serve one workflow.

3. **Standalone Bugs**
   - Summarize meaningful customer-facing fixes concisely under a **Fixes & Stability** sub-group (or combine minor related fixes into one clean bullet).

4. **Standalone TBIs (Technical Backlog Items)**
   - Translate technical work into business value (performance, reliability, security, deployment readiness). Combine minor internal items into a single **Platform & Reliability** bullet.

## Smart Platform Awareness

Evaluate all platform signals in the input payload:

1. **Explicit & inherited assignments**: Project target platforms assigned in Apex on the release epic, parent Feature/Epic, or individual work items, plus Azure DevOps tags (`Mobile`, `Desktop`, `Platform:Mobile`, etc.).
2. **Split-platform Features**: If a single Feature contains child PBIs targeting different platforms (for example, Desktop PBIs and Mobile PBIs), summarize each platform's deliverable under its respective platform section, or place a unified capability under **Cross-Platform / Shared** when both platforms gain the same capability.
3. **Smart contextual association for unassigned items**: When a project has configured target platforms and an item has no explicit platform assignment or tag, inspect its title and description excerpt:
   - Associate it with a configured platform when the context is unmistakable (for example, *"Mobile offline sync"* or *"iOS push notification fix"* → `Mobile`; *"Desktop installer auto-update"* → `Desktop`).
   - If a release epic itself targets specific platform(s) and an item has no conflicting platform cue, associate it with the release's target platform(s).
   - If an item applies across multiple platforms, place it under **Cross-Platform / Shared**.
   - Never guess a platform when there is no evidence; place genuinely platform-neutral or ambiguous items under **General** (or **Cross-Platform / Shared**).

### Sectioning Rules by Platform Count

- **0 platforms configured on the project**: Omit all platform headings. Group bullets cleanly under `## Highlights` and (when applicable) `## Fixes & Reliability`.
- **1 target platform across the entire release**: Show `**Target Platform:** <Platform Name>` in the header line and use clean `## Highlights` / `## Fixes & Reliability` sections without repeating a redundant platform heading.
- **2+ target platforms involved**: Organize the body with `## <Platform Name>` sections (following the project's platform order), plus `## Cross-Platform / Shared` (for capabilities spanning multiple platforms) or `## General` (only if unassigned platform-neutral items remain). Omit empty sections.

## Markdown Template

Return **only** valid Markdown (no outer ` ```markdown ` code fences, no conversational preamble):

```markdown
# <Release Version> — Release Notes

**Target Date:** <YYYY-MM-DD or TBD> | **Platforms:** <Comma-separated platforms, or omit if no platforms configured>

<1–2 sentence executive summary of what this release delivers.>

## <Section Heading — Platform Name or Highlights>

- **<Short capability or outcome title>** — <One concise sentence explaining what is delivered and why it matters.>
- **<Short capability or outcome title>** — <One concise sentence explaining what is delivered and why it matters.>
```

## Workspace Mode (Optional)

When invoked inside an autonomous workspace with `.ai-pilot/kickoff-context.md`, read `.ai-pilot/kickoff-context.md` and write the finished Markdown to `.ai-pilot/output/release-changelog.md` using the Write tool without asking questions. When invoked inline via prompt, return the raw Markdown directly.
