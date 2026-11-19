import {
  AdapterSpecificationError,
  type AdapterAcquireInput,
  type AdapterSpecification,
  type AgentOptions,
  type LocalAgentOptions,
  type SettingSource,
  type ToolName,
} from './types';
export {
  deriveInteractiveCursorExecutionFields,
  deriveWorkerCursorExecutionFields,
  playbookStepNeedsAzureCli,
  type DerivedCursorSandboxSpecification,
  type ExplicitCursorExecutionFields,
} from '../cursorExecutionSpecification';

export function validateAdapterSpecification(spec: AdapterSpecification): void {
  if (!spec || typeof spec !== 'object') {
    throw new AdapterSpecificationError('Cursor adapter specification is required');
  }
  if (typeof spec.sessionKey !== 'string' || spec.sessionKey.trim().length === 0) {
    throw new AdapterSpecificationError('Cursor adapter specification requires sessionKey');
  }
  if (typeof spec.compatibilityKey !== 'string' || spec.compatibilityKey.trim().length === 0) {
    throw new AdapterSpecificationError('Cursor adapter specification requires compatibilityKey');
  }
  if (
    !spec.model
    || typeof spec.model !== 'object'
    || typeof spec.model.id !== 'string'
    || spec.model.id.trim().length === 0
  ) {
    throw new AdapterSpecificationError('Cursor adapter specification requires model.id');
  }
  if (typeof spec.workspaceRef !== 'string' || spec.workspaceRef.trim().length === 0) {
    throw new AdapterSpecificationError('Cursor adapter specification requires workspaceRef');
  }
  if (typeof spec.requestId !== 'string' || spec.requestId.trim().length === 0) {
    throw new AdapterSpecificationError('Cursor adapter specification requires requestId');
  }
  if (
    spec.toolAllowlist !== null
    && (
      !Array.isArray(spec.toolAllowlist)
      || !spec.toolAllowlist.every((tool) => typeof tool === 'string' && tool.trim().length > 0)
    )
  ) {
    throw new AdapterSpecificationError('Cursor adapter specification requires explicit toolAllowlist');
  }
  if (
    !Array.isArray(spec.disallowedTools)
    || !spec.disallowedTools.every((tool) => typeof tool === 'string' && tool.trim().length > 0)
  ) {
    throw new AdapterSpecificationError('Cursor adapter specification requires explicit disallowedTools');
  }
  if (
    !Array.isArray(spec.settingSources)
    || !spec.settingSources.every((source) => typeof source === 'string')
  ) {
    throw new AdapterSpecificationError('Cursor adapter specification requires explicit settingSources');
  }
  if (
    !spec.sandbox
    || typeof spec.sandbox !== 'object'
    || typeof spec.sandbox.enabled !== 'boolean'
  ) {
    throw new AdapterSpecificationError('Cursor adapter specification requires explicit sandbox');
  }
  if (!spec.mcpServers || typeof spec.mcpServers !== 'object') {
    throw new AdapterSpecificationError('Cursor adapter specification requires mcpServers');
  }
}

export function buildSdkAgentOptions(
  apiKey: string,
  spec: AdapterSpecification,
  input?: AdapterAcquireInput,
): AgentOptions {
  const customTools = input?.customTools;
  const local: LocalAgentOptions = {
    cwd: spec.workspaceRef,
    settingSources: [...spec.settingSources] as SettingSource[],
    ...(spec.sandbox.omitSandbox ? {} : { sandboxOptions: { enabled: spec.sandbox.enabled } }),
    ...(customTools && Object.keys(customTools).length > 0
      ? { customTools: { ...customTools } }
      : {}),
    ...(spec.subagentInherit ? { subagentInherit: spec.subagentInherit } : {}),
  };

  return {
    apiKey,
    model: spec.model,
    local,
    mcpServers: { ...spec.mcpServers },
    ...(spec.disallowedTools.length > 0
      ? { disallowedTools: [...spec.disallowedTools] as ToolName[] }
      : {}),
    ...(spec.toolAllowlist !== null
      ? { tools: [...spec.toolAllowlist] as ToolName[] }
      : {}),
    ...(spec.agents ? { agents: { ...spec.agents } } : {}),
  };
}
