/**
 * Answers Promptfoo grading prompts for the document worker with Bedrock.
 *
 * The Promptfoo child sends each llm-rubric grading prompt to the worker over
 * IPC; this module makes the call with the worker's own AWS credentials, using
 * the model and region the specification carries. Usage is not recorded here:
 * the worker has no database.
 */
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { WorkflowEvaluationPromptfooGrader } from '../../../shared/types/aiRunV2EvaluationSpec';

export type GradePrompt = (
  prompt: string,
  grader: WorkflowEvaluationPromptfooGrader,
  signal: AbortSignal,
) => Promise<string>;

type SendableClient = Pick<BedrockRuntimeClient, 'send'>;

type ChatMessage = Readonly<{ role: 'user' | 'assistant'; content: string }>;

/**
 * Promptfoo's rubric prompt is a JSON chat (`[{ role, content }]`) with a system
 * turn; anything else is sent as one user message.
 */
export function toAnthropicMessages(prompt: string): { system?: string; messages: ChatMessage[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(prompt);
  } catch {
    return { messages: [{ role: 'user', content: prompt }] };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return { messages: [{ role: 'user', content: prompt }] };
  const system: string[] = [];
  const messages: ChatMessage[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') return { messages: [{ role: 'user', content: prompt }] };
    const { role, content } = item as { role?: unknown; content?: unknown };
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    if (role === 'system') system.push(text);
    else if (role === 'assistant') messages.push({ role: 'assistant', content: text });
    else messages.push({ role: 'user', content: text });
  }
  if (messages.length === 0) return { messages: [{ role: 'user', content: system.join('\n\n') }] };
  return { ...(system.length > 0 ? { system: system.join('\n\n') } : {}), messages };
}

export function createBedrockPromptfooGrader(options?: { client?: SendableClient }): GradePrompt {
  const clientsByRegion = new Map<string, SendableClient>();
  const clientFor = (region: string): SendableClient => {
    if (options?.client) return options.client;
    let client = clientsByRegion.get(region);
    if (!client) {
      client = new BedrockRuntimeClient({ region });
      clientsByRegion.set(region, client);
    }
    return client;
  };

  return async (prompt, grader, signal) => {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), grader.timeoutMs);
    try {
      const response = await clientFor(grader.region).send(new InvokeModelCommand({
        modelId: grader.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: grader.maxTokens,
          ...toAnthropicMessages(prompt),
        }),
      }), { abortSignal: controller.signal });
      const decoded = JSON.parse(new TextDecoder().decode(response.body as Uint8Array)) as {
        content?: Array<{ type: string; text?: string }>;
      };
      return (decoded.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
    } catch (error) {
      if (controller.signal.aborted && !signal.aborted) {
        throw new Error(`Grading timed out after ${Math.round(grader.timeoutMs / 1000)}s (model=${grader.modelId})`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  };
}
