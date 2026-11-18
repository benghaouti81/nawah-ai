import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthContext } from '../../shared/types.ts';
import { db } from '../db/index.ts';
import { agents } from '../db/schema.ts';
import {
  GatewayError,
  hydrateAgentExecution,
  isAgentAuthorized,
  type HydratedExecution,
} from '../engine/agent-hydrator.ts';
import {
  AuthorizedMcpSession,
  type McpToolExecutionEvent,
} from '../engine/mcp-manager.ts';
import {
  routeToProvider,
  type ChatContentPart,
  type ChatMessageInput,
} from '../engine/provider-router.ts';
import { recordUsageAndCheckAlerts } from '../engine/usage-logger.ts';
import { requireAuth } from '../middleware/auth.ts';
import { makeId } from '../utils/crypto.ts';

export const openAiRouter = Router();

const chatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
        name: z.string().optional(),
        tool_call_id: z.string().optional(),
        tool_calls: z
          .array(
            z.object({
              id: z.string(),
              type: z.literal('function'),
              function: z.object({
                name: z.string(),
                arguments: z.string(),
              }),
            }),
          )
          .optional(),
      }),
    )
    .min(1),
  stream: z.boolean().optional().default(false),
  stream_options: z
    .object({ include_usage: z.boolean().optional() })
    .optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
});

function normalizeMessages(
  raw: z.infer<typeof chatCompletionRequestSchema>['messages'],
): ChatMessageInput[] {
  return raw.map((m) => {
    let normalizedContent: string | ChatContentPart[] | null = '';
    if (m.content === null) {
      normalizedContent = null;
    } else if (typeof m.content === 'string') {
      normalizedContent = m.content;
    } else if (Array.isArray(m.content)) {
      const parts: ChatContentPart[] = [];
      for (const part of m.content) {
        if (typeof part === 'string') {
          parts.push({ type: 'text', text: part });
        } else if (part && typeof part === 'object') {
          const obj = part as Record<string, unknown>;
          if (obj.type === 'image_url') {
            const rawImg = obj.image_url;
            if (typeof rawImg === 'string' && rawImg.trim()) {
              parts.push({ type: 'image_url', image_url: { url: rawImg.trim() } });
            } else if (
              rawImg &&
              typeof rawImg === 'object' &&
              typeof (rawImg as { url?: unknown }).url === 'string' &&
              (rawImg as { url: string }).url.trim()
            ) {
              const imgObj = rawImg as { url: string; detail?: unknown };
              parts.push({
                type: 'image_url',
                image_url: {
                  url: imgObj.url.trim(),
                  ...(typeof imgObj.detail === 'string' ? { detail: imgObj.detail } : {}),
                },
              });
            }
          } else if ('text' in obj) {
            parts.push({ type: 'text', text: String(obj.text ?? '') });
          }
        }
      }
      const hasImage = parts.some((p) => p.type === 'image_url');
      normalizedContent = hasImage
        ? parts
        : parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    }

    return {
      role: m.role,
      content: normalizedContent,
      name: m.name,
      tool_call_id: m.tool_call_id,
      ...(m.tool_calls && m.tool_calls.length > 0 ? { tool_calls: m.tool_calls } : {}),
    };
  });
}

export async function executeAgentTurn(params: {
  auth: AuthContext;
  model: string;
  messages: ChatMessageInput[];
  temperature?: number;
  maxTokens?: number;
}): Promise<{
  content: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  calculatedCostUsd: number | null;
  latencyMs: number;
  toolEvents: McpToolExecutionEvent[];
}> {
  const started = Date.now();
  let hydrated: HydratedExecution | null = null;
  let mcpSession: AuthorizedMcpSession | null = null;
  let usageRecorded = false;

  try {
    hydrated = hydrateAgentExecution(params.auth, params.model);
    if (hydrated.authorizedMcpServers.length > 0) {
      mcpSession = await AuthorizedMcpSession.create({
        servers: hydrated.authorizedMcpServers,
        allowedTools: hydrated.agent.mcpPermissions.allowedTools,
        readOnly: hydrated.agent.mcpPermissions.readOnly,
      });
    }

    const result = await routeToProvider({
      hydrated,
      messages: params.messages,
      mcpSession,
      stream: false,
      temperatureOverride: params.temperature,
      maxTokens: params.maxTokens,
    });

    const latencyMs = Date.now() - started;
    usageRecorded = true;
    const { calculatedCostUsd } = recordUsageAndCheckAlerts({
      workspaceId: params.auth.workspaceId,
      departmentId: hydrated.department.id,
      agentId: hydrated.agent.id,
      apiKeyId: params.auth.keyId,
      userLabel: params.auth.userLabel,
      providerType: hydrated.provider.type,
      modelUsed: hydrated.model.modelId,
      status: 'success',
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      inputCostPer1mUsd: hydrated.model.inputCostPer1mUsd,
      outputCostPer1mUsd: hydrated.model.outputCostPer1mUsd,
      latencyMs,
    });

    return {
      content: result.content,
      model: `agent/${hydrated.agent.slug}`,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      calculatedCostUsd,
      latencyMs,
      toolEvents: result.toolEvents,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const gwErr =
      err instanceof GatewayError
        ? err
        : new GatewayError(
            502,
            'execution_failed',
            err instanceof Error ? err.message : 'Execution failed',
          );

    if (!usageRecorded) {
      usageRecorded = true;
      recordUsageAndCheckAlerts({
        workspaceId: params.auth.workspaceId,
        departmentId: hydrated?.department.id ?? gwErr.context?.departmentId ?? null,
        agentId: hydrated?.agent.id ?? gwErr.context?.agentId ?? null,
        apiKeyId: params.auth.keyId,
        userLabel: params.auth.userLabel,
        providerType: hydrated?.provider.type ?? gwErr.context?.providerType ?? 'unconfigured',
        modelUsed: hydrated?.model.modelId ?? gwErr.context?.modelUsed ?? params.model,
        status: 'failed',
        errorCode: gwErr.errorCode,
        errorMessage: gwErr.message,
        inputTokens: null,
        outputTokens: null,
        inputCostPer1mUsd: 0,
        outputCostPer1mUsd: 0,
        latencyMs,
      });
    }

    throw gwErr;
  } finally {
    if (mcpSession) {
      await mcpSession.close().catch(() => undefined);
    }
  }
}

openAiRouter.get('/models', requireAuth, (req, res) => {
  const auth = req.auth!;
  const allActive = db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, auth.workspaceId), eq(agents.isActive, true)))
    .all();

  const authorized = allActive.filter((agent) => isAgentAuthorized(auth, agent));

  res.json({
    object: 'list',
    data: authorized.map((agent) => ({
      id: `agent/${agent.slug}`,
      object: 'model',
      created: Math.floor(new Date(agent.createdAt).getTime() / 1000),
      owned_by: 'nawah-ai',
      metadata: {
        name: agent.name,
        description: agent.description,
        department_id: agent.departmentId,
      },
    })),
  });
});

openAiRouter.post('/chat/completions', requireAuth, async (req, res) => {
  const auth = req.auth!;
  const parsed = chatCompletionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: parsed.error.issues[0]?.message || 'Invalid OpenAI chat completion request',
        type: 'invalid_request_error',
        code: 'validation_error',
      },
    });
    return;
  }

  const started = Date.now();
  const completionId = makeId('chatcmpl');
  const createdUnix = Math.floor(Date.now() / 1000);
  const messages = normalizeMessages(parsed.data.messages);
  const includeTrace = req.headers['x-nawah-trace'] === '1';

  const abortController = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) {
      abortController.abort();
    }
  };
  res.on('close', onClose);

  const safeWrite = (chunk: string) => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(chunk);
    }
  };

  let hydrated: HydratedExecution | null = null;
  let mcpSession: AuthorizedMcpSession | null = null;
  let usageRecorded = false;

  const recordOnce = (
    entry: Parameters<typeof recordUsageAndCheckAlerts>[0],
  ): { calculatedCostUsd: number | null } => {
    if (usageRecorded) {
      return { calculatedCostUsd: null };
    }
    usageRecorded = true;
    return recordUsageAndCheckAlerts(entry);
  };

  try {
    hydrated = hydrateAgentExecution(auth, parsed.data.model);

    if (hydrated.authorizedMcpServers.length > 0) {
      mcpSession = await AuthorizedMcpSession.create({
        servers: hydrated.authorizedMcpServers,
        allowedTools: hydrated.agent.mcpPermissions.allowedTools,
        readOnly: hydrated.agent.mcpPermissions.readOnly,
      });
    }

    const modelLabel = `agent/${hydrated.agent.slug}`;

    if (!parsed.data.stream) {
      const result = await routeToProvider({
        hydrated,
        messages,
        mcpSession,
        stream: false,
        temperatureOverride: parsed.data.temperature,
        maxTokens: parsed.data.max_tokens,
        signal: abortController.signal,
      });

      const latencyMs = Date.now() - started;
      const { calculatedCostUsd } = recordOnce({
        workspaceId: auth.workspaceId,
        departmentId: hydrated.department.id,
        agentId: hydrated.agent.id,
        apiKeyId: auth.keyId,
        userLabel: auth.userLabel,
        providerType: hydrated.provider.type,
        modelUsed: hydrated.model.modelId,
        status: 'success',
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        inputCostPer1mUsd: hydrated.model.inputCostPer1mUsd,
        outputCostPer1mUsd: hydrated.model.outputCostPer1mUsd,
        latencyMs,
      });

      if (abortController.signal.aborted || res.writableEnded || res.destroyed) {
        return;
      }

      const usageAvailable = result.inputTokens !== null && result.outputTokens !== null;
      const openAiUsage = usageAvailable
        ? {
            prompt_tokens: result.inputTokens!,
            completion_tokens: result.outputTokens!,
            total_tokens: result.inputTokens! + result.outputTokens!,
          }
        : null;

      res.json({
        id: completionId,
        object: 'chat.completion',
        created: createdUnix,
        model: modelLabel,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.content,
            },
            finish_reason: result.finishReason,
          },
        ],
        usage: openAiUsage,
        ...(includeTrace
          ? {
              nawah: {
                calculated_cost_usd: calculatedCostUsd,
                cost_basis: 'configured_model_pricing',
                usage_available: usageAvailable,
                latency_ms: latencyMs,
                provider_type: hydrated.provider.type,
                upstream_model: hydrated.model.modelId,
                tool_events: result.toolEvents,
              },
            }
          : {}),
      });
      return;
    }

    // Streaming SSE response
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Emit initial role delta
    safeWrite(
      `data: ${JSON.stringify({
        id: completionId,
        object: 'chat.completion.chunk',
        created: createdUnix,
        model: modelLabel,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })}\n\n`,
    );

    const result = await routeToProvider({
      hydrated,
      messages,
      mcpSession,
      stream: true,
      temperatureOverride: parsed.data.temperature,
      maxTokens: parsed.data.max_tokens,
      signal: abortController.signal,
      callbacks: {
        onDelta: (textChunk) => {
          safeWrite(
            `data: ${JSON.stringify({
              id: completionId,
              object: 'chat.completion.chunk',
              created: createdUnix,
              model: modelLabel,
              choices: [
                {
                  index: 0,
                  delta: { content: textChunk },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
        },
        onToolEvent: (ev) => {
          if (includeTrace) {
            safeWrite(`event: nawah_tool\ndata: ${JSON.stringify(ev)}\n\n`);
          }
        },
      },
    });

    const latencyMs = Date.now() - started;
    const { calculatedCostUsd } = recordOnce({
      workspaceId: auth.workspaceId,
      departmentId: hydrated.department.id,
      agentId: hydrated.agent.id,
      apiKeyId: auth.keyId,
      userLabel: auth.userLabel,
      providerType: hydrated.provider.type,
      modelUsed: hydrated.model.modelId,
      status: 'success',
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      inputCostPer1mUsd: hydrated.model.inputCostPer1mUsd,
      outputCostPer1mUsd: hydrated.model.outputCostPer1mUsd,
      latencyMs,
    });

    const usageAvailable = result.inputTokens !== null && result.outputTokens !== null;
    const openAiUsage = usageAvailable
      ? {
          prompt_tokens: result.inputTokens!,
          completion_tokens: result.outputTokens!,
          total_tokens: result.inputTokens! + result.outputTokens!,
        }
      : null;

    safeWrite(
      `data: ${JSON.stringify({
        id: completionId,
        object: 'chat.completion.chunk',
        created: createdUnix,
        model: modelLabel,
        choices: [{ index: 0, delta: {}, finish_reason: result.finishReason }],
        usage: openAiUsage,
      })}\n\n`,
    );

    if (includeTrace) {
      safeWrite(
        `event: nawah_receipt\ndata: ${JSON.stringify({
          calculated_cost_usd: calculatedCostUsd,
          cost_basis: 'configured_model_pricing',
          usage_available: usageAvailable,
          latency_ms: latencyMs,
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
          provider_type: hydrated.provider.type,
          upstream_model: hydrated.model.modelId,
          tool_events: result.toolEvents,
        })}\n\n`,
      );
    }

    safeWrite('data: [DONE]\n\n');
    if (!res.writableEnded) {
      res.end();
    }
  } catch (err) {
    const latencyMs = Date.now() - started;
    const gwErr =
      err instanceof GatewayError
        ? err
        : new GatewayError(
            502,
            'gateway_execution_error',
            err instanceof Error ? err.message : 'Upstream execution error',
          );

    recordOnce({
      workspaceId: auth.workspaceId,
      departmentId: hydrated?.department.id ?? gwErr.context?.departmentId ?? null,
      agentId: hydrated?.agent.id ?? gwErr.context?.agentId ?? null,
      apiKeyId: auth.keyId,
      userLabel: auth.userLabel,
      providerType: hydrated?.provider.type ?? gwErr.context?.providerType ?? 'unconfigured',
      modelUsed: hydrated?.model.modelId ?? gwErr.context?.modelUsed ?? parsed.data.model,
      status: 'failed',
      errorCode: gwErr.errorCode,
      errorMessage: gwErr.message,
      inputTokens: null,
      outputTokens: null,
      inputCostPer1mUsd: 0,
      outputCostPer1mUsd: 0,
      latencyMs,
    });

    if (res.headersSent) {
      if (!res.writableEnded && !res.destroyed) {
        safeWrite(
          `data: ${JSON.stringify({
            error: {
              message: gwErr.message,
              type: 'gateway_error',
              code: gwErr.errorCode,
            },
          })}\n\n`,
        );
        safeWrite('data: [DONE]\n\n');
        res.end();
      }
    } else if (!res.writableEnded && !res.destroyed) {
      res.status(gwErr.statusCode).json({
        error: {
          message: gwErr.message,
          type: 'gateway_error',
          code: gwErr.errorCode,
        },
      });
    }
  } finally {
    res.off('close', onClose);
    if (mcpSession) {
      await mcpSession.close().catch(() => undefined);
    }
  }
});
