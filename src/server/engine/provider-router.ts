import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from '@google/genai';
import type { ProviderType } from '../../shared/types.ts';
import { GatewayError, type HydratedExecution } from './agent-hydrator.ts';
import type { AuthorizedMcpSession, McpToolExecutionEvent } from './mcp-manager.ts';

const MAX_MCP_STEPS = 5;
const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;
const DEFAULT_TEST_TIMEOUT_MS = 10_000;

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

export interface ChatMessageInput {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface ProviderExecutionResult {
  content: string;
  finishReason: string;
  inputTokens: number | null;
  outputTokens: number | null;
  toolEvents: McpToolExecutionEvent[];
}

function asFiniteTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function accumulateNullableTokens(
  current: number | null,
  stepValue: number | null,
): number | null {
  if (current === null || stepValue === null) return null;
  return current + stepValue;
}

export interface StreamCallbacks {
  onDelta: (textChunk: string) => void;
  onToolEvent?: (event: McpToolExecutionEvent) => void;
}

function getTimeoutMs(envName: string, fallbackMs: number): number {
  const raw = process.env[envName];
  if (!raw) return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallbackMs;
}

function createRequestSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Upstream provider request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason ?? new Error('Client aborted request'));
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      controller.abort(externalSignal.reason ?? new Error('Client aborted request'));
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function toProviderGatewayError(
  err: unknown,
  hydrated: HydratedExecution,
  didTimeout: boolean,
  externalSignal?: AbortSignal,
  timeoutMs?: number,
): GatewayError {
  if (err instanceof GatewayError) return err;
  const context = {
    departmentId: hydrated.department.id,
    agentId: hydrated.agent.id,
    providerType: hydrated.provider.type,
    modelUsed: hydrated.model.modelId,
  };
  if (didTimeout) {
    return new GatewayError(
      504,
      'upstream_provider_timeout',
      `${hydrated.provider.name} timed out after ${timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS}ms.`,
      context,
    );
  }
  if (externalSignal?.aborted) {
    return new GatewayError(499, 'client_aborted', 'Client closed the connection.', context);
  }
  const message = err instanceof Error ? err.message : 'Upstream provider request failed.';
  return new GatewayError(
    502,
    'upstream_provider_error',
    `${hydrated.provider.name}: ${message}`,
    context,
  );
}

function resolveOpenAiCompatibleBaseUrl(
  type: ProviderType,
  baseUrl: string | null,
): string {
  const cleaned = baseUrl?.trim().replace(/\/+$/, '');
  if (cleaned) return cleaned;
  if (type === 'openai') return 'https://api.openai.com/v1';
  if (type === 'ollama') return 'http://localhost:11434/v1';
  throw new GatewayError(
    422,
    'provider_base_url_missing',
    'OpenAI-compatible provider requires a valid base URL.',
  );
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (
          part &&
          typeof part === 'object' &&
          'text' in part &&
          (!('type' in part) || (part as { type?: unknown }).type === 'text')
        ) {
          return String((part as { text: unknown }).text ?? '');
        }
        return '';
      })
      .join('');
  }
  return '';
}

function messageHasImageParts(messages: ChatMessageInput[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((part) => part.type === 'image_url'),
  );
}

type ParsedImageUrl =
  | { kind: 'base64'; mediaType: string; data: string }
  | { kind: 'url'; url: string };

function parseImageUrl(url: string): ParsedImageUrl {
  const trimmed = url.trim();
  if (trimmed.startsWith('data:')) {
    const match = trimmed.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match || !match[1] || !match[2]) {
      throw new GatewayError(
        400,
        'invalid_image_url',
        'Invalid base64 image data URI.',
      );
    }
    return { kind: 'base64', mediaType: match[1], data: match[2] };
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return { kind: 'url', url: trimmed };
  }
  throw new GatewayError(
    400,
    'invalid_image_url',
    'Image URL must be a base64 data URI or an http(s) URL.',
  );
}

function inferImageMimeType(url: string): string {
  const clean = url.split('?')[0].toLowerCase();
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

function safeJsonParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function parseErrorResponse(res: Response, providerName: string): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const json = JSON.parse(text) as { error?: { message?: string }; message?: string };
    const msg = json?.error?.message || json?.message || text;
    return `${providerName} HTTP ${res.status}: ${msg.slice(0, 400)}`;
  } catch {
    return `${providerName} HTTP ${res.status}: ${(text || res.statusText).slice(0, 400)}`;
  }
}

async function executeOpenAiCompatible(params: {
  hydrated: HydratedExecution;
  messages: ChatMessageInput[];
  mcpSession: AuthorizedMcpSession | null;
  stream: boolean;
  temperatureOverride?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  callbacks?: StreamCallbacks;
}): Promise<ProviderExecutionResult> {
  const { hydrated, mcpSession, stream } = params;
  const timeoutMs = getTimeoutMs('NAWAH_PROVIDER_TIMEOUT_MS', DEFAULT_PROVIDER_TIMEOUT_MS);
  const baseUrl = resolveOpenAiCompatibleBaseUrl(
    hydrated.provider.type,
    hydrated.provider.baseUrl,
  );
  const endpoint = baseUrl.endsWith('/chat/completions')
    ? baseUrl
    : `${baseUrl}/chat/completions`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (hydrated.provider.apiKey) {
    headers['Authorization'] = `Bearer ${hydrated.provider.apiKey}`;
  }

  const toolsPayload =
    mcpSession && mcpSession.tools.length > 0
      ? mcpSession.tools.map((t) => ({
          type: 'function' as const,
          function: {
            name: t.qualifiedName,
            description: t.description,
            parameters: t.inputSchema,
          },
        }))
      : undefined;

  const nonSystemMessages: ChatMessageInput[] = params.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.name ? { name: m.name } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.tool_calls && m.tool_calls.length > 0 ? { tool_calls: m.tool_calls } : {}),
    }));

  const callerSystems = params.messages
    .filter((m) => m.role === 'system' && m.content)
    .map((m) => extractTextContent(m.content))
    .filter(Boolean)
    .join('\n\n');

  const systemContent = callerSystems
    ? `${hydrated.agent.assembledSystemPrompt}\n\n${callerSystems}`
    : hydrated.agent.assembledSystemPrompt;

  const conversation: ChatMessageInput[] = [
    { role: 'system', content: systemContent },
    ...nonSystemMessages,
  ];

  let totalInputTokens: number | null = 0;
  let totalOutputTokens: number | null = 0;
  let fullContent = '';
  let lastFinishReason = 'stop';
  const toolEvents: McpToolExecutionEvent[] = [];

  for (let step = 1; step <= MAX_MCP_STEPS; step++) {
    const body: Record<string, unknown> = {
      model: hydrated.model.modelId,
      messages: conversation,
      temperature: params.temperatureOverride ?? hydrated.agent.temperature,
      stream,
    };
    if (params.maxTokens !== undefined) {
      body.max_tokens = params.maxTokens;
    }
    if (toolsPayload) {
      body.tools = toolsPayload;
      body.tool_choice = 'auto';
    }
    if (stream) {
      body.stream_options = { include_usage: true };
    }

    const reqSignal = createRequestSignal(params.signal, timeoutMs);
    try {
      let res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: reqSignal.signal,
      });

      if (
        !res.ok &&
        res.status === 400 &&
        stream &&
        'stream_options' in body &&
        (hydrated.provider.type === 'ollama' || hydrated.provider.type === 'openai_compatible')
      ) {
        await res.body?.cancel().catch(() => undefined);
        delete body.stream_options;
        res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: reqSignal.signal,
        });
      }

      if (!res.ok) {
        const msg = await parseErrorResponse(res, hydrated.provider.name);
        throw new GatewayError(502, 'upstream_provider_error', msg, {
          departmentId: hydrated.department.id,
          agentId: hydrated.agent.id,
          providerType: hydrated.provider.type,
          modelUsed: hydrated.model.modelId,
        });
      }

      if (!stream) {
        const data = (await res.json()) as {
          error?: { message?: string };
          choices?: Array<{
            message?: {
              content?: unknown;
              tool_calls?: Array<{
                id: string;
                type: 'function';
                function: { name: string; arguments: string };
              }>;
            };
            finish_reason?: string;
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            input_tokens?: number;
            output_tokens?: number;
          };
        };

        if (data.error) {
          throw new GatewayError(
            502,
            'upstream_provider_error',
            `${hydrated.provider.name}: ${data.error.message || 'Upstream provider error'}`,
            {
              departmentId: hydrated.department.id,
              agentId: hydrated.agent.id,
              providerType: hydrated.provider.type,
              modelUsed: hydrated.model.modelId,
            },
          );
        }

        const stepInput = asFiniteTokenCount(
          data.usage?.prompt_tokens ?? data.usage?.input_tokens,
        );
        const stepOutput = asFiniteTokenCount(
          data.usage?.completion_tokens ?? data.usage?.output_tokens,
        );
        totalInputTokens = accumulateNullableTokens(totalInputTokens, stepInput);
        totalOutputTokens = accumulateNullableTokens(totalOutputTokens, stepOutput);

        const choice = data.choices?.[0];
        const text = extractTextContent(choice?.message?.content);
        const calls = choice?.message?.tool_calls ?? [];
        lastFinishReason = choice?.finish_reason || 'stop';

        if (text) {
          fullContent += text;
        }

        if (calls.length > 0 && mcpSession && step < MAX_MCP_STEPS) {
          conversation.push({
            role: 'assistant',
            content: text || null,
            tool_calls: calls,
          });

          for (const call of calls) {
            const parsedArgs = safeJsonParseObject(call.function.arguments || '{}');
            const result = await mcpSession.invokeTool(call.function.name, parsedArgs);
            const ev: McpToolExecutionEvent = {
              step,
              serverSlug: result.serverSlug,
              toolName: result.toolName,
              arguments: parsedArgs,
              result: result.resultText,
              isError: result.isError,
            };
            toolEvents.push(ev);
            params.callbacks?.onToolEvent?.(ev);

            conversation.push({
              role: 'tool',
              tool_call_id: call.id,
              content: result.resultText,
            });
          }
          continue;
        }

        return {
          content: fullContent,
          finishReason: lastFinishReason,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          toolEvents,
        };
      }

      if (!res.body) {
        throw new GatewayError(
          502,
          'upstream_empty_stream',
          `${hydrated.provider.name} returned an empty response stream.`,
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let stepText = '';
      let stepInputTokens: number | null = null;
      let stepOutputTokens: number | null = null;
      const toolCallMap = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();

      const processSseLine = (rawLine: string) => {
        const line = rawLine.trim();
        if (!line) return;

        if (!line.startsWith('data:')) {
          if (line.startsWith('{')) {
            try {
              const rawErr = JSON.parse(line) as { error?: { message?: string } };
              if (rawErr.error) {
                throw new GatewayError(
                  502,
                  'upstream_provider_error',
                  `${hydrated.provider.name} stream error: ${rawErr.error.message || 'Upstream error'}`,
                  {
                    departmentId: hydrated.department.id,
                    agentId: hydrated.agent.id,
                    providerType: hydrated.provider.type,
                    modelUsed: hydrated.model.modelId,
                  },
                );
              }
            } catch (e) {
              if (e instanceof GatewayError) throw e;
            }
          }
          return;
        }

        const payload = line.slice(5).trim();
        if (payload === '[DONE]' || !payload) return;

        let parsed: {
          error?: { message?: string };
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            input_tokens?: number;
            output_tokens?: number;
          } | null;
        };

        try {
          parsed = JSON.parse(payload);
        } catch {
          return;
        }

        if (parsed.error) {
          throw new GatewayError(
            502,
            'upstream_provider_error',
            `${hydrated.provider.name} stream error: ${parsed.error.message || 'Upstream error'}`,
            {
              departmentId: hydrated.department.id,
              agentId: hydrated.agent.id,
              providerType: hydrated.provider.type,
              modelUsed: hydrated.model.modelId,
            },
          );
        }

        if (parsed.usage) {
          const inTok = asFiniteTokenCount(
            parsed.usage.prompt_tokens ?? parsed.usage.input_tokens,
          );
          const outTok = asFiniteTokenCount(
            parsed.usage.completion_tokens ?? parsed.usage.output_tokens,
          );
          if (inTok !== null) {
            stepInputTokens = inTok;
          }
          if (outTok !== null) {
            stepOutputTokens = outTok;
          }
        }

        const choice = parsed.choices?.[0];
        if (choice?.finish_reason) {
          lastFinishReason = choice.finish_reason;
        }

        const deltaContent = choice?.delta?.content;
        if (typeof deltaContent === 'string' && deltaContent.length > 0) {
          stepText += deltaContent;
          fullContent += deltaContent;
          params.callbacks?.onDelta(deltaContent);
        }

        if (Array.isArray(choice?.delta?.tool_calls)) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index ?? 0;
            const existing = toolCallMap.get(idx) ?? {
              id: tc.id || `call_${step}_${idx}`,
              name: '',
              arguments: '',
            };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name += tc.function.name;
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;
            toolCallMap.set(idx, existing);
          }
        }
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            if (buffer.trim()) {
              processSseLine(buffer);
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const rawLine of lines) {
            processSseLine(rawLine);
          }
        }
      } finally {
        reader.cancel().catch(() => undefined);
      }

      totalInputTokens = accumulateNullableTokens(totalInputTokens, stepInputTokens);
      totalOutputTokens = accumulateNullableTokens(totalOutputTokens, stepOutputTokens);

      const calls = Array.from(toolCallMap.values()).filter((c) => c.name);
      if (calls.length > 0 && mcpSession && step < MAX_MCP_STEPS) {
        conversation.push({
          role: 'assistant',
          content: stepText || null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          })),
        });

        for (const call of calls) {
          const parsedArgs = safeJsonParseObject(call.arguments || '{}');
          const result = await mcpSession.invokeTool(call.name, parsedArgs);
          const ev: McpToolExecutionEvent = {
            step,
            serverSlug: result.serverSlug,
            toolName: result.toolName,
            arguments: parsedArgs,
            result: result.resultText,
            isError: result.isError,
          };
          toolEvents.push(ev);
          params.callbacks?.onToolEvent?.(ev);

          conversation.push({
            role: 'tool',
            tool_call_id: call.id,
            content: result.resultText,
          });
        }
        continue;
      }

      return {
        content: fullContent,
        finishReason: lastFinishReason,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        toolEvents,
      };
    } catch (err) {
      throw toProviderGatewayError(err, hydrated, reqSignal.didTimeout(), params.signal, timeoutMs);
    } finally {
      reqSignal.cleanup();
    }
  }

  return {
    content: fullContent,
    finishReason: 'stop',
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    toolEvents,
  };
}

function toAnthropicBlocks(
  content: ChatMessageInput['content'],
): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text.length > 0) {
        blocks.push({ type: 'text', text: part.text });
      }
    } else if (part.type === 'image_url') {
      const parsed = parseImageUrl(part.image_url.url);
      if (parsed.kind === 'base64') {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: parsed.mediaType,
            data: parsed.data,
          },
        });
      } else {
        blocks.push({
          type: 'image',
          source: {
            type: 'url',
            url: parsed.url,
          },
        });
      }
    }
  }
  return blocks;
}

function buildAnthropicMessages(
  messages: ChatMessageInput[],
): Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> {
  const result: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [];

  const pushMessage = (role: 'user' | 'assistant', blocks: Array<Record<string, unknown>>) => {
    if (blocks.length === 0) return;
    const prev = result[result.length - 1];
    if (prev && prev.role === role) {
      prev.content.push(...blocks);
    } else {
      result.push({ role, content: blocks });
    }
  };

  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      pushMessage('user', toAnthropicBlocks(m.content));
    } else if (m.role === 'assistant') {
      const blocks = toAnthropicBlocks(m.content);
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: safeJsonParseObject(tc.function.arguments || '{}'),
          });
        }
      }
      pushMessage('assistant', blocks);
    } else if (m.role === 'tool') {
      pushMessage('user', [
        {
          type: 'tool_result',
          tool_use_id: m.tool_call_id || 'tool_call',
          content: extractTextContent(m.content),
        },
      ]);
    }
  }

  return result;
}

function mapAnthropicStopReason(stopReason?: string): string {
  if (stopReason === 'tool_use') return 'tool_calls';
  if (stopReason === 'max_tokens') return 'length';
  return 'stop';
}

async function executeAnthropic(params: {
  hydrated: HydratedExecution;
  messages: ChatMessageInput[];
  mcpSession: AuthorizedMcpSession | null;
  stream: boolean;
  temperatureOverride?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  callbacks?: StreamCallbacks;
}): Promise<ProviderExecutionResult> {
  const { hydrated, mcpSession, stream } = params;
  const timeoutMs = getTimeoutMs('NAWAH_PROVIDER_TIMEOUT_MS', DEFAULT_PROVIDER_TIMEOUT_MS);
  const baseUrl = (hydrated.provider.baseUrl || 'https://api.anthropic.com/v1')
    .trim()
    .replace(/\/+$/, '');
  const endpoint = baseUrl.endsWith('/messages') ? baseUrl : `${baseUrl}/messages`;

  if (!hydrated.provider.apiKey) {
    throw new GatewayError(
      422,
      'provider_key_missing',
      `Provider "${hydrated.provider.name}" (anthropic) requires an API key.`,
    );
  }

  const toolsPayload =
    mcpSession && mcpSession.tools.length > 0
      ? mcpSession.tools.map((t) => ({
          name: t.qualifiedName,
          description: t.description,
          input_schema: t.inputSchema,
        }))
      : undefined;

  const callerSystems = params.messages
    .filter((m) => m.role === 'system' && m.content)
    .map((m) => extractTextContent(m.content))
    .filter(Boolean)
    .join('\n\n');
  const systemText = callerSystems
    ? `${hydrated.agent.assembledSystemPrompt}\n\n${callerSystems}`
    : hydrated.agent.assembledSystemPrompt;

  type AnthropicMessage = {
    role: 'user' | 'assistant';
    content: Array<Record<string, unknown>>;
  };

  const conversation: AnthropicMessage[] = buildAnthropicMessages(params.messages);

  let totalInputTokens: number | null = 0;
  let totalOutputTokens: number | null = 0;
  let fullContent = '';
  let lastFinishReason = 'stop';
  const toolEvents: McpToolExecutionEvent[] = [];

  for (let step = 1; step <= MAX_MCP_STEPS; step++) {
    const body: Record<string, unknown> = {
      model: hydrated.model.modelId,
      system: systemText,
      messages: conversation,
      max_tokens: params.maxTokens ?? 4096,
      temperature: params.temperatureOverride ?? hydrated.agent.temperature,
      stream,
    };
    if (toolsPayload) {
      body.tools = toolsPayload;
    }

    const reqSignal = createRequestSignal(params.signal, timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': hydrated.provider.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: reqSignal.signal,
      });

      if (!res.ok) {
        const msg = await parseErrorResponse(res, hydrated.provider.name);
        throw new GatewayError(502, 'upstream_provider_error', msg, {
          departmentId: hydrated.department.id,
          agentId: hydrated.agent.id,
          providerType: hydrated.provider.type,
          modelUsed: hydrated.model.modelId,
        });
      }

      if (!stream) {
        const data = (await res.json()) as {
          error?: { message?: string };
          content?: Array<{
            type: string;
            text?: string;
            id?: string;
            name?: string;
            input?: Record<string, unknown>;
          }>;
          stop_reason?: string;
          usage?: { input_tokens?: number; output_tokens?: number };
        };

        if (data.error) {
          throw new GatewayError(
            502,
            'upstream_provider_error',
            `${hydrated.provider.name}: ${data.error.message || 'Upstream error'}`,
            {
              departmentId: hydrated.department.id,
              agentId: hydrated.agent.id,
              providerType: hydrated.provider.type,
              modelUsed: hydrated.model.modelId,
            },
          );
        }

        const stepInput = asFiniteTokenCount(data.usage?.input_tokens);
        const stepOutput = asFiniteTokenCount(data.usage?.output_tokens);
        totalInputTokens = accumulateNullableTokens(totalInputTokens, stepInput);
        totalOutputTokens = accumulateNullableTokens(totalOutputTokens, stepOutput);
        lastFinishReason = mapAnthropicStopReason(data.stop_reason);

        const blocks = data.content ?? [];
        const text = blocks
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text)
          .join('');
        if (text) fullContent += text;

        const toolUses = blocks.filter((b) => b.type === 'tool_use' && b.id && b.name);
        if (toolUses.length > 0 && mcpSession && step < MAX_MCP_STEPS) {
          conversation.push({ role: 'assistant', content: blocks });
          const toolResults: Array<Record<string, unknown>> = [];

          for (const tu of toolUses) {
            const result = await mcpSession.invokeTool(tu.name!, tu.input || {});
            const ev: McpToolExecutionEvent = {
              step,
              serverSlug: result.serverSlug,
              toolName: result.toolName,
              arguments: tu.input || {},
              result: result.resultText,
              isError: result.isError,
            };
            toolEvents.push(ev);
            params.callbacks?.onToolEvent?.(ev);

            toolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: result.resultText,
              is_error: result.isError,
            });
          }
          conversation.push({ role: 'user', content: toolResults });
          continue;
        }

        return {
          content: fullContent,
          finishReason: lastFinishReason,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          toolEvents,
        };
      }

      // Anthropic SSE streaming
      if (!res.body) {
        throw new GatewayError(502, 'upstream_empty_stream', 'Empty Anthropic stream.');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let stepInputTokens: number | null = null;
      let stepOutputTokens: number | null = null;
      const assistantBlocks: Array<Record<string, unknown>> = [];
      const blockPartialJson = new Map<number, string>();

      const processSseLine = (rawLine: string) => {
        const line = rawLine.trim();
        if (!line) return;
        if (!line.startsWith('data:')) {
          if (line.startsWith('{')) {
            try {
              const rawErr = JSON.parse(line) as { error?: { message?: string } };
              if (rawErr.error) {
                throw new GatewayError(
                  502,
                  'upstream_provider_error',
                  `${hydrated.provider.name} stream error: ${rawErr.error.message || 'Upstream error'}`,
                  {
                    departmentId: hydrated.department.id,
                    agentId: hydrated.agent.id,
                    providerType: hydrated.provider.type,
                    modelUsed: hydrated.model.modelId,
                  },
                );
              }
            } catch (e) {
              if (e instanceof GatewayError) throw e;
            }
          }
          return;
        }
        const payload = line.slice(5).trim();
        if (!payload) return;

        let ev: {
          type: string;
          index?: number;
          error?: { type?: string; message?: string };
          message?: { usage?: { input_tokens?: number; output_tokens?: number } };
          usage?: { input_tokens?: number; output_tokens?: number };
          content_block?: Record<string, unknown>;
          delta?: {
            type?: string;
            text?: string;
            partial_json?: string;
            stop_reason?: string;
          };
        };
        try {
          ev = JSON.parse(payload);
        } catch {
          return;
        }

        if (ev.type === 'error') {
          throw new GatewayError(
            502,
            'upstream_provider_error',
            `${hydrated.provider.name} stream error: ${ev.error?.message || 'Anthropic stream failed'}`,
            {
              departmentId: hydrated.department.id,
              agentId: hydrated.agent.id,
              providerType: hydrated.provider.type,
              modelUsed: hydrated.model.modelId,
            },
          );
        } else if (ev.type === 'message_start' && ev.message?.usage) {
          const inTok = asFiniteTokenCount(ev.message.usage.input_tokens);
          const outTok = asFiniteTokenCount(ev.message.usage.output_tokens);
          if (inTok !== null) {
            stepInputTokens = inTok;
          }
          if (outTok !== null) {
            stepOutputTokens = outTok;
          }
        } else if (ev.type === 'message_delta') {
          const inTok = asFiniteTokenCount(ev.usage?.input_tokens);
          const outTok = asFiniteTokenCount(ev.usage?.output_tokens);
          if (inTok !== null) {
            stepInputTokens = inTok;
          }
          // Anthropic reports cumulative output_tokens for the message on message_delta
          if (outTok !== null) {
            stepOutputTokens = outTok;
          }
          if (ev.delta?.stop_reason) {
            lastFinishReason = mapAnthropicStopReason(ev.delta.stop_reason);
          }
        } else if (
          ev.type === 'content_block_start' &&
          typeof ev.index === 'number' &&
          ev.content_block
        ) {
          assistantBlocks[ev.index] = ev.content_block;
          if (ev.content_block.type === 'tool_use') {
            blockPartialJson.set(ev.index, '');
          }
        } else if (ev.type === 'content_block_delta' && typeof ev.index === 'number') {
          if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            fullContent += ev.delta.text;
            params.callbacks?.onDelta(ev.delta.text);
            const blk = assistantBlocks[ev.index];
            if (blk && blk.type === 'text') {
              blk.text = String(blk.text ?? '') + ev.delta.text;
            }
          } else if (
            ev.delta?.type === 'input_json_delta' &&
            typeof ev.delta.partial_json === 'string'
          ) {
            blockPartialJson.set(
              ev.index,
              (blockPartialJson.get(ev.index) ?? '') + ev.delta.partial_json,
            );
          }
        } else if (ev.type === 'content_block_stop' && typeof ev.index === 'number') {
          const blk = assistantBlocks[ev.index];
          if (blk && blk.type === 'tool_use') {
            const rawJson = blockPartialJson.get(ev.index) ?? '{}';
            try {
              blk.input = rawJson ? JSON.parse(rawJson) : {};
            } catch {
              blk.input = {};
            }
          }
        }
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            if (buffer.trim()) {
              processSseLine(buffer);
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const rawLine of lines) {
            processSseLine(rawLine);
          }
        }
      } finally {
        reader.cancel().catch(() => undefined);
      }

      totalInputTokens = accumulateNullableTokens(totalInputTokens, stepInputTokens);
      totalOutputTokens = accumulateNullableTokens(totalOutputTokens, stepOutputTokens);

      const toolUses = assistantBlocks.filter(
        (b) => b && b.type === 'tool_use' && b.id && b.name,
      );
      if (toolUses.length > 0 && mcpSession && step < MAX_MCP_STEPS) {
        conversation.push({ role: 'assistant', content: assistantBlocks });
        const toolResults: Array<Record<string, unknown>> = [];

        for (const tu of toolUses) {
          const inputArgs = (tu.input as Record<string, unknown>) || {};
          const result = await mcpSession.invokeTool(String(tu.name), inputArgs);
          const toolEv: McpToolExecutionEvent = {
            step,
            serverSlug: result.serverSlug,
            toolName: result.toolName,
            arguments: inputArgs,
            result: result.resultText,
            isError: result.isError,
          };
          toolEvents.push(toolEv);
          params.callbacks?.onToolEvent?.(toolEv);

          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: result.resultText,
            is_error: result.isError,
          });
        }
        conversation.push({ role: 'user', content: toolResults });
        continue;
      }

      return {
        content: fullContent,
        finishReason: lastFinishReason,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        toolEvents,
      };
    } catch (err) {
      throw toProviderGatewayError(err, hydrated, reqSignal.didTimeout(), params.signal, timeoutMs);
    } finally {
      reqSignal.cleanup();
    }
  }

  return {
    content: fullContent,
    finishReason: 'stop',
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    toolEvents,
  };
}

function toGeminiParts(content: ChatMessageInput['content']): Part[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: Part[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text.length > 0) {
        parts.push({ text: part.text });
      }
    } else if (part.type === 'image_url') {
      const parsed = parseImageUrl(part.image_url.url);
      if (parsed.kind === 'base64') {
        parts.push({
          inlineData: {
            mimeType: parsed.mediaType,
            data: parsed.data,
          },
        });
      } else {
        parts.push({
          fileData: {
            fileUri: parsed.url,
            mimeType: inferImageMimeType(parsed.url),
          },
        });
      }
    }
  }
  return parts;
}

function buildGeminiContents(messages: ChatMessageInput[]): Content[] {
  const contents: Content[] = [];
  const toolCallIdToName = new Map<string, string>();

  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.id && tc.function?.name) {
          toolCallIdToName.set(tc.id, tc.function.name);
        }
      }
    }
  }

  const pushContent = (role: 'user' | 'model', parts: Part[]) => {
    if (parts.length === 0) return;
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role && Array.isArray(prev.parts)) {
      prev.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  };

  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      pushContent('user', toGeminiParts(m.content));
    } else if (m.role === 'assistant') {
      const parts = toGeminiParts(m.content);
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: safeJsonParseObject(tc.function.arguments || '{}'),
            },
          });
        }
      }
      pushContent('model', parts);
    } else if (m.role === 'tool') {
      const fnName =
        (m.tool_call_id ? toolCallIdToName.get(m.tool_call_id) : undefined) ||
        m.name ||
        'tool';
      pushContent('user', [
        {
          functionResponse: {
            name: fnName,
            response: { result: extractTextContent(m.content) },
          },
        },
      ]);
    }
  }

  return contents;
}

function mapGeminiFinishReason(reason?: string): string {
  if (reason === 'MAX_TOKENS') return 'length';
  if (reason === 'SAFETY' || reason === 'RECITATION') return 'content_filter';
  return 'stop';
}

async function executeGoogle(params: {
  hydrated: HydratedExecution;
  messages: ChatMessageInput[];
  mcpSession: AuthorizedMcpSession | null;
  stream: boolean;
  temperatureOverride?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  callbacks?: StreamCallbacks;
}): Promise<ProviderExecutionResult> {
  const { hydrated, mcpSession, stream } = params;
  const timeoutMs = getTimeoutMs('NAWAH_PROVIDER_TIMEOUT_MS', DEFAULT_PROVIDER_TIMEOUT_MS);

  if (!hydrated.provider.apiKey) {
    throw new GatewayError(
      422,
      'provider_key_missing',
      `Provider "${hydrated.provider.name}" (google) requires an API key.`,
    );
  }

  const cleanBaseUrl = hydrated.provider.baseUrl?.trim().replace(/\/+$/, '');
  const ai = new GoogleGenAI({
    apiKey: hydrated.provider.apiKey,
    httpOptions: {
      ...(cleanBaseUrl ? { baseUrl: cleanBaseUrl } : {}),
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const callerSystems = params.messages
    .filter((m) => m.role === 'system' && m.content)
    .map((m) => extractTextContent(m.content))
    .filter(Boolean)
    .join('\n\n');
  const systemInstruction = callerSystems
    ? `${hydrated.agent.assembledSystemPrompt}\n\n${callerSystems}`
    : hydrated.agent.assembledSystemPrompt;

  const contents: Content[] = buildGeminiContents(params.messages);

  const functionDeclarations: FunctionDeclaration[] | undefined =
    mcpSession && mcpSession.tools.length > 0
      ? mcpSession.tools.map((t) => ({
          name: t.qualifiedName,
          description: t.description,
          parametersJsonSchema: t.inputSchema,
        }))
      : undefined;

  const isGemini4Series = hydrated.model.modelId.startsWith('gemini-4-');

  let totalInputTokens: number | null = 0;
  let totalOutputTokens: number | null = 0;
  let fullContent = '';
  let lastFinishReason = 'stop';
  const toolEvents: McpToolExecutionEvent[] = [];

  for (let step = 1; step <= MAX_MCP_STEPS; step++) {
    const reqSignal = createRequestSignal(params.signal, timeoutMs);
    const config: Record<string, unknown> = {
      systemInstruction,
      abortSignal: reqSignal.signal,
    };
    if (!isGemini4Series) {
      config.temperature = params.temperatureOverride ?? hydrated.agent.temperature;
    }
    if (params.maxTokens !== undefined) {
      config.maxOutputTokens = params.maxTokens;
    }
    if (functionDeclarations && functionDeclarations.length > 0) {
      config.tools = [{ functionDeclarations }];
    }

    try {
      if (!stream) {
        const response = await ai.models.generateContent({
          model: hydrated.model.modelId,
          contents,
          config,
        });

        const stepInput = asFiniteTokenCount(response.usageMetadata?.promptTokenCount);
        const stepOutput = asFiniteTokenCount(response.usageMetadata?.candidatesTokenCount);
        totalInputTokens = accumulateNullableTokens(totalInputTokens, stepInput);
        totalOutputTokens = accumulateNullableTokens(totalOutputTokens, stepOutput);

        const candidateReason = response.candidates?.[0]?.finishReason;
        if (candidateReason) {
          lastFinishReason = mapGeminiFinishReason(candidateReason);
        }

        const text = response.text ?? '';
        if (text) fullContent += text;

        const calls = response.functionCalls ?? [];
        if (calls.length > 0 && mcpSession && step < MAX_MCP_STEPS) {
          const modelParts: Part[] = [];
          if (text) modelParts.push({ text });
          for (const c of calls) {
            modelParts.push({ functionCall: { name: c.name, args: c.args } });
          }
          contents.push({ role: 'model', parts: modelParts });

          const responseParts: Part[] = [];
          for (const call of calls) {
            const toolName = call.name || '';
            const args = (call.args as Record<string, unknown>) || {};
            const result = await mcpSession.invokeTool(toolName, args);
            const ev: McpToolExecutionEvent = {
              step,
              serverSlug: result.serverSlug,
              toolName: result.toolName,
              arguments: args,
              result: result.resultText,
              isError: result.isError,
            };
            toolEvents.push(ev);
            params.callbacks?.onToolEvent?.(ev);

            responseParts.push({
              functionResponse: {
                name: toolName,
                response: { result: result.resultText, isError: result.isError },
              },
            });
          }
          contents.push({ role: 'user', parts: responseParts });
          continue;
        }

        return {
          content: fullContent,
          finishReason: calls.length > 0 ? 'tool_calls' : lastFinishReason,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          toolEvents,
        };
      }

      // Streaming Gemini execution
      const responseStream = await ai.models.generateContentStream({
        model: hydrated.model.modelId,
        contents,
        config,
      });

      let stepInput: number | null = null;
      let stepOutput: number | null = null;
      let stepText = '';
      const collectedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

      for await (const chunk of responseStream) {
        if (chunk.usageMetadata) {
          const inTok = asFiniteTokenCount(chunk.usageMetadata.promptTokenCount);
          const outTok = asFiniteTokenCount(chunk.usageMetadata.candidatesTokenCount);
          if (inTok !== null) stepInput = inTok;
          if (outTok !== null) stepOutput = outTok;
        }
        const chunkReason = chunk.candidates?.[0]?.finishReason;
        if (chunkReason) {
          lastFinishReason = mapGeminiFinishReason(chunkReason);
        }
        const chunkText = chunk.text;
        if (chunkText) {
          stepText += chunkText;
          fullContent += chunkText;
          params.callbacks?.onDelta(chunkText);
        }
        if (chunk.functionCalls && chunk.functionCalls.length > 0) {
          for (const fc of chunk.functionCalls) {
            if (fc.name) {
              collectedCalls.push({
                name: fc.name,
                args: (fc.args as Record<string, unknown>) || {},
              });
            }
          }
        }
      }

      totalInputTokens = accumulateNullableTokens(totalInputTokens, stepInput);
      totalOutputTokens = accumulateNullableTokens(totalOutputTokens, stepOutput);

      if (collectedCalls.length > 0 && mcpSession && step < MAX_MCP_STEPS) {
        const modelParts: Part[] = [];
        if (stepText) modelParts.push({ text: stepText });
        for (const c of collectedCalls) {
          modelParts.push({ functionCall: { name: c.name, args: c.args } });
        }
        contents.push({ role: 'model', parts: modelParts });

        const responseParts: Part[] = [];
        for (const call of collectedCalls) {
          const result = await mcpSession.invokeTool(call.name, call.args);
          const ev: McpToolExecutionEvent = {
            step,
            serverSlug: result.serverSlug,
            toolName: result.toolName,
            arguments: call.args,
            result: result.resultText,
            isError: result.isError,
          };
          toolEvents.push(ev);
          params.callbacks?.onToolEvent?.(ev);

          responseParts.push({
            functionResponse: {
              name: call.name,
              response: { result: result.resultText, isError: result.isError },
            },
          });
        }
        contents.push({ role: 'user', parts: responseParts });
        continue;
      }

      return {
        content: fullContent,
        finishReason: collectedCalls.length > 0 ? 'tool_calls' : lastFinishReason,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        toolEvents,
      };
    } catch (err) {
      throw toProviderGatewayError(err, hydrated, reqSignal.didTimeout(), params.signal, timeoutMs);
    } finally {
      reqSignal.cleanup();
    }
  }

  return {
    content: fullContent,
    finishReason: 'stop',
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    toolEvents,
  };
}

export async function routeToProvider(params: {
  hydrated: HydratedExecution;
  messages: ChatMessageInput[];
  mcpSession: AuthorizedMcpSession | null;
  stream: boolean;
  temperatureOverride?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  callbacks?: StreamCallbacks;
}): Promise<ProviderExecutionResult> {
  if (messageHasImageParts(params.messages) && !params.hydrated.model.supportsVision) {
    throw new GatewayError(
      400,
      'vision_not_supported',
      `Model "${params.hydrated.model.modelId}" does not have vision enabled.`,
      {
        departmentId: params.hydrated.department.id,
        agentId: params.hydrated.agent.id,
        providerType: params.hydrated.provider.type,
        modelUsed: params.hydrated.model.modelId,
      },
    );
  }

  const { type } = params.hydrated.provider;

  if (type === 'openai' || type === 'openai_compatible' || type === 'ollama') {
    return executeOpenAiCompatible(params);
  }
  if (type === 'anthropic') {
    return executeAnthropic(params);
  }
  if (type === 'google') {
    return executeGoogle(params);
  }

  throw new GatewayError(400, 'unsupported_provider_type', `Unsupported provider type: ${type}`);
}

export async function testProviderConnection(params: {
  type: ProviderType;
  baseUrl: string | null;
  apiKey: string | null;
}): Promise<{ ok: boolean; latencyMs: number; modelsCount?: number; error?: string }> {
  const started = Date.now();
  const timeoutMs = getTimeoutMs('NAWAH_PROVIDER_TEST_TIMEOUT_MS', DEFAULT_TEST_TIMEOUT_MS);
  const reqSignal = createRequestSignal(undefined, timeoutMs);

  try {
    if (params.type === 'google') {
      if (!params.apiKey) {
        return { ok: false, latencyMs: Date.now() - started, error: 'Google API key is missing.' };
      }
      const cleanBaseUrl = params.baseUrl?.trim().replace(/\/+$/, '');
      const ai = new GoogleGenAI({
        apiKey: params.apiKey,
        httpOptions: {
          ...(cleanBaseUrl ? { baseUrl: cleanBaseUrl } : {}),
          timeout: timeoutMs,
          headers: { 'User-Agent': 'aistudio-build' },
        },
      });
      const pager = await ai.models.list({
        config: { pageSize: 10, abortSignal: reqSignal.signal },
      });
      let count = 0;
      for await (const _m of pager) {
        count++;
        if (count >= 10) break;
      }
      return { ok: true, latencyMs: Date.now() - started, modelsCount: count };
    }

    if (params.type === 'anthropic') {
      if (!params.apiKey) {
        return { ok: false, latencyMs: Date.now() - started, error: 'Anthropic API key is missing.' };
      }
      const base = (params.baseUrl || 'https://api.anthropic.com/v1').trim().replace(/\/+$/, '');
      const res = await fetch(`${base}/models`, {
        headers: {
          'x-api-key': params.apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: reqSignal.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        return { ok: false, latencyMs: Date.now() - started, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      const json = (await res.json()) as { data?: unknown[] };
      return {
        ok: true,
        latencyMs: Date.now() - started,
        modelsCount: Array.isArray(json.data) ? json.data.length : undefined,
      };
    }

    const base = resolveOpenAiCompatibleBaseUrl(params.type, params.baseUrl);
    const headers: Record<string, string> = {};
    if (params.apiKey) {
      headers['Authorization'] = `Bearer ${params.apiKey}`;
    }
    const res = await fetch(`${base}/models`, { headers, signal: reqSignal.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      return { ok: false, latencyMs: Date.now() - started, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const json = (await res.json()) as { data?: unknown[] };
    return {
      ok: true,
      latencyMs: Date.now() - started,
      modelsCount: Array.isArray(json.data) ? json.data.length : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: reqSignal.didTimeout()
        ? `Connection timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : 'Connection failed',
    };
  } finally {
    reqSignal.cleanup();
  }
}
