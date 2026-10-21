import type { ChatThreadKickoff } from '../../shared/types/chat';

/** Prefer explicit assistantType; fall back to freeform context markers for older threads. */
export function resolveDocumentAssistantType(
  kickoff: ChatThreadKickoff
): 'adr' | 'prd' | 'design-doc' | undefined {
  if (
    kickoff.assistantType === 'adr' ||
    kickoff.assistantType === 'prd' ||
    kickoff.assistantType === 'design-doc'
  ) {
    return kickoff.assistantType;
  }
  const ctx = kickoff.freeformContext;
  if (!ctx) return undefined;
  if (/^document_operation:\s*validation\s*$/m.test(ctx)) return undefined;
  if (/^adr_id:\s*\S+/m.test(ctx)) return 'adr';
  if (/^prd_id:\s*\S+/m.test(ctx)) return 'prd';
  if (/^doc_id:\s*\S+/m.test(ctx)) return 'design-doc';
  return undefined;
}

/**
 * Mandatory MCP write-back guidance for ADR / PRD / design-doc assistants.
 * Used by free-chat and skill-path prompts so document edits stage into the
 * Apex review wizard instead of being written as sandbox files.
 */
export function buildDocumentAssistantEditGuidance(
  kickoff: ChatThreadKickoff
): string[] {
  const assistantType = resolveDocumentAssistantType(kickoff);
  if (!kickoff.freeformContext || !assistantType) {
    return [];
  }

  if (assistantType === 'adr') {
    const adrIdMatch = kickoff.freeformContext.match(/^adr_id:\s*(\S+)/m);
    const threadIdMatch = kickoff.freeformContext.match(/^thread_id:\s*(\S+)/m);
    const adrId =
      adrIdMatch?.[1] ?? '(unknown — read from .ai-pilot/kickoff-context.md)';
    const threadId =
      threadIdMatch?.[1] ??
      '(unknown — read from .ai-pilot/kickoff-context.md)';
    return [
      ``,
      `# Document write tools (via \`ado-skills\` MCP server)`,
      `- \`update_adr\` — stage the complete revised ADR markdown for Apex review`,
      ``,
      `# ADR session identifiers`,
      `Use these exact values when calling MCP tools:`,
      `  adr_id:    ${adrId}`,
      `  thread_id: ${threadId}`,
      ``,
      `# ADR context and repository grounding`,
      `Read \`.ai-pilot/kickoff-context.md\` for the current ADR, original interview transcript, and repository identity.`,
      `Inspect relevant repository files with the available repository read tools before making factual claims or proposing edits.`,
      ``,
      `# Applying edits — MANDATORY tool use`,
      `When the author asks to change the ADR, produce the complete revised markdown and call \`update_adr\` with the adr_id and thread_id above.`,
      `The tool stages proposed content only. Never write live ADR content or change workflow status directly.`,
      `Do NOT write proposed ADR content to \`.ai-pilot/output/\` — that does not open the Apex review wizard.`,
      `If \`update_adr\` is unavailable, stop and report that the staging tool is missing. Do not invent a file-based workaround.`,
      `After the tool succeeds, confirm that the proposal is ready for explicit apply or reject review.`,
    ];
  }

  if (assistantType === 'prd') {
    const prdIdMatch = kickoff.freeformContext.match(/^prd_id:\s*(\S+)/m);
    const threadIdMatch = kickoff.freeformContext.match(/^thread_id:\s*(\S+)/m);
    const prdId =
      prdIdMatch?.[1] ?? '(unknown — read from .ai-pilot/kickoff-context.md)';
    const threadId =
      threadIdMatch?.[1] ??
      '(unknown — read from .ai-pilot/kickoff-context.md)';
    return [
      ``,
      `# Document write tools (via \`ado-skills\` MCP server)`,
      `- \`update_prd\` — stage PRD content or backlog JSON for Apex review`,
      `- \`add_test_case\` — add a real QA test case with steps and traceability`,
      `- \`resolve_prd_comment\` — mark a review comment resolved after addressing it`,
      ``,
      `# PRD session identifiers`,
      `Use these exact values when calling MCP tools — do not guess or substitute them:`,
      `  prd_id:    ${prdId}`,
      `  thread_id: ${threadId}`,
      ``,
      `# PRD context`,
      `The full PRD content, backlog, and review comments have been written to \`.ai-pilot/kickoff-context.md\`.`,
      `Read this file when you need the current PRD text or backlog to answer a question or produce an edit.`,
      ``,
      `# Applying edits — MANDATORY tool use`,
      `When the user asks you to change, update, rewrite, improve, add to, or fix anything in the PRD or backlog:`,
      `1. Read \`.ai-pilot/kickoff-context.md\` to get the current content.`,
      `2. Produce the full updated text for the changed section.`,
      `3. Call \`update_prd\` with the prd_id and thread_id above. Do NOT describe the change without calling the tool.`,
      `   - \`section="content"\` for the PRD narrative (full markdown)`,
      `   - \`section="backlog"\` for the backlog (full JSON string)`,
      `4. After the tool succeeds, confirm briefly what was changed.`,
      `Do NOT write proposed PRD/backlog content to \`.ai-pilot/output/\` — that does not open the Apex review wizard.`,
      `If \`update_prd\` is unavailable, stop and report that the staging tool is missing. Do not invent a file-based workaround.`,
      ``,
      `# User stories live in the backlog (single ownership)`,
      `User stories are OWNED by the backlog (the \`userStory\` object on each PBI). The PRD does NOT contain an authored "User Stories" section — the PRD view renders stories as a READ-ONLY projection of the backlog PBIs.`,
      `Therefore, to add, change, reword, or remove a user story you MUST call \`update_prd\` with \`section="backlog"\` (NOT \`section="content"\`) and edit the relevant PBI's \`userStory\` (\`persona\`/\`iWant\`/\`soThat\`).`,
      `Never write user stories into the PRD markdown via \`section="content"\` — they would not render and would duplicate the backlog.`,
      `Assumptions are the mirror case: the PRD's \`## Assumptions Made\` section OWNS assumptions; the backlog's \`assumptionsMade\` is just a copy of it.`,
      ``,
      `# Keep PRD content and backlog consistent`,
      `The PRD content (markdown) and the backlog (JSON with epics/features/PBIs) describe the SAME feature, but each field has a single owner — do not duplicate an owned field into the other artifact.`,
      `When a change crosses the ownership line, update the owning artifact:`,
      `- Adding/removing/rewording a user story → edit the backlog PBI's \`userStory\` (section="backlog"). Do NOT touch the PRD markdown for this.`,
      `- Changing narrative (problem, solution, implementation/testing decisions, security, NFRs, feature-flag behavior) → edit the PRD content (section="content").`,
      `- Changing structural detail (epics/features/PBIs/TBIs, acceptance criteria, business rules, dependencies, feature-flag name) → edit the backlog (section="backlog").`,
      `- Editing assumptions → edit the PRD \`## Assumptions Made\` (section="content"); if you also keep the backlog \`assumptionsMade\` in step, mirror the same text via section="backlog".`,
      `- \`userTypes\` / \`personaBehaviors\` belong on Features and PBIs only (for design prototypes). TBIs must NOT have these fields — remove them if present; never add them to TBIs.`,
      `Only call \`update_prd\` for the artifact(s) that actually own the changed field — often a single call is correct.`,
      ``,
      `- \`resolve_prd_comment\` — call this after addressing a review comment to mark it resolved.`,
      `  Pass the \`comment_id\` from the Review Comments section in \`.ai-pilot/kickoff-context.md\`.`,
      ``,
      `# Addressing review comments`,
      `When the user asks you to address comments: read the Review Comments section, revise the relevant content,`,
      `call \`update_prd\`, then call \`resolve_prd_comment\` for each comment addressed.`,
      `Confirm what was changed and which comments were resolved.`,
    ];
  }

  const docIdMatch = kickoff.freeformContext.match(/^doc_id:\s*(\S+)/m);
  const docThreadIdMatch =
    kickoff.freeformContext.match(/^thread_id:\s*(\S+)/m);
  const docId =
    docIdMatch?.[1] ?? '(unknown — read from .ai-pilot/kickoff-context.md)';
  const docThreadId =
    docThreadIdMatch?.[1] ??
    '(unknown — read from .ai-pilot/kickoff-context.md)';
  return [
    ``,
    `# Document write tools (via \`ado-skills\` MCP server)`,
    `- \`update_design_doc\` — stage design / tech-spec / assumptions markdown for Apex review`,
    ``,
    `# Design doc session identifiers`,
    `Use these exact values when calling MCP tools:`,
    `  doc_id:    ${docId}`,
    `  thread_id: ${docThreadId}`,
    ``,
    `# Design doc context`,
    `The full design doc content has been written to \`.ai-pilot/kickoff-context.md\`.`,
    `Read this file when you need the current document text to answer a question or produce an edit.`,
    ``,
    `# Applying edits — MANDATORY tool use`,
    `When the user asks you to change, update, rewrite, improve, add to, or fix anything in the document:`,
    `1. Read \`.ai-pilot/kickoff-context.md\` to get the current content.`,
    `2. Produce the full updated text for the changed section.`,
    `3. Call \`update_design_doc\` with the doc_id and thread_id above. Do NOT describe the change without calling the tool.`,
    `   - Call it once per section that needs updating.`,
    `4. After the tool succeeds, confirm briefly what was changed.`,
    `Do NOT write proposed design-doc content to \`.ai-pilot/output/\` — that does not open the Apex review wizard.`,
    `If \`update_design_doc\` is unavailable, stop and report that the staging tool is missing. Do not invent a file-based workaround.`,
  ];
}
