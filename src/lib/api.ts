import type {
  AgentDto,
  AgentRevisionDto,
  ApiKeyDto,
  AuthContext,
  DepartmentDto,
  McpServerDto,
  ProviderDto,
  SpendingAlertDto,
  UsageLogDto,
  UsageSummaryDto,
  YamlAgentTemplate,
} from '../shared/types';

const TOKEN_STORAGE_KEY = 'nawah_access_key';

export function getStoredToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  overrideToken?: string,
): Promise<T> {
  const token = overrideToken ?? getStoredToken();
  const headers: Record<string, string> = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // non-json response
  }

  if (!res.ok) {
    const errObj = json.error as { code?: string; message?: string } | undefined;
    throw new ApiError(
      res.status,
      errObj?.code || `http_${res.status}`,
      errObj?.message || res.statusText || 'Request failed',
    );
  }

  return json as T;
}

export interface SessionInfo extends AuthContext {
  departmentName: string | null;
  workspaceName: string;
}

export const api = {
  getAuthStatus: () =>
    apiRequest<{ needsSetup: boolean; workspaceName: string }>('/api/auth/status'),

  setupFirstAdmin: (userLabel: string) =>
    apiRequest<{ rawKey: string; key: ApiKeyDto }>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ userLabel }),
    }),

  getMe: (token?: string) => apiRequest<SessionInfo>('/api/auth/me', {}, token),

  // Providers & Models
  getProviders: () => apiRequest<ProviderDto[]>('/api/admin/providers'),
  createProvider: (data: {
    name: string;
    type: string;
    baseUrl?: string | null;
    apiKey?: string | null;
    isActive?: boolean;
  }) =>
    apiRequest<ProviderDto>('/api/admin/providers', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateProvider: (
    id: string,
    data: {
      name?: string;
      baseUrl?: string | null;
      apiKey?: string | null;
      clearApiKey?: boolean;
      isActive?: boolean;
    },
  ) =>
    apiRequest<{ ok: boolean }>(`/api/admin/providers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteProvider: (id: string) =>
    apiRequest<{ ok: boolean }>(`/api/admin/providers/${id}`, { method: 'DELETE' }),
  testProvider: (id: string) =>
    apiRequest<{ ok: boolean; latencyMs: number; modelsCount?: number; error?: string }>(
      `/api/admin/providers/${id}/test`,
      { method: 'POST' },
    ),
  createModel: (
    providerId: string,
    data: {
      modelId: string;
      supportsVision: boolean;
      inputCostPer1mUsd: number;
      outputCostPer1mUsd: number;
    },
  ) =>
    apiRequest(`/api/admin/providers/${providerId}/models`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateModel: (
    id: string,
    data: {
      supportsVision?: boolean;
      inputCostPer1mUsd?: number;
      outputCostPer1mUsd?: number;
      isActive?: boolean;
    },
  ) =>
    apiRequest<{ ok: boolean }>(`/api/admin/models/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteModel: (id: string) =>
    apiRequest<{ ok: boolean }>(`/api/admin/models/${id}`, { method: 'DELETE' }),

  // Departments
  getDepartments: () => apiRequest<DepartmentDto[]>('/api/admin/departments'),
  createDepartment: (data: {
    name: string;
    slug: string;
    monthlyAlertThresholdUsd: number;
    allowedModelIds: string[];
    allowedMcpServerIds: string[];
  }) =>
    apiRequest<DepartmentDto>('/api/admin/departments', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateDepartment: (
    id: string,
    data: Partial<{
      name: string;
      monthlyAlertThresholdUsd: number;
      allowedModelIds: string[];
      allowedMcpServerIds: string[];
    }>,
  ) =>
    apiRequest<DepartmentDto>(`/api/admin/departments/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteDepartment: (id: string) =>
    apiRequest<{ ok: boolean }>(`/api/admin/departments/${id}`, { method: 'DELETE' }),

  // MCP Servers
  getMcpServers: () => apiRequest<McpServerDto[]>('/api/admin/mcp-servers'),
  createMcpServer: (data: {
    name: string;
    slug: string;
    transport: string;
    endpointOrCommand: string;
    authHeadersJson?: string | null;
    isActive?: boolean;
  }) =>
    apiRequest<McpServerDto>('/api/admin/mcp-servers', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateMcpServer: (
    id: string,
    data: {
      name?: string;
      transport?: string;
      endpointOrCommand?: string;
      authHeadersJson?: string | null;
      clearAuthHeaders?: boolean;
      isActive?: boolean;
    },
  ) =>
    apiRequest<{ ok: boolean }>(`/api/admin/mcp-servers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteMcpServer: (id: string) =>
    apiRequest<{ ok: boolean }>(`/api/admin/mcp-servers/${id}`, { method: 'DELETE' }),
  discoverMcpTools: (id: string) =>
    apiRequest<{ ok: boolean; tools: McpServerDto['discoveredTools'] }>(
      `/api/admin/mcp-servers/${id}/discover`,
      { method: 'POST' },
    ),

  // Access Keys
  getApiKeys: () => apiRequest<ApiKeyDto[]>('/api/admin/api-keys'),
  createApiKey: (data: {
    userLabel: string;
    role: string;
    departmentId: string | null;
    allowedAgentIds: string[];
  }) =>
    apiRequest<{ rawKey: string; key: ApiKeyDto }>('/api/admin/api-keys', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateApiKey: (
    id: string,
    data: { isActive?: boolean; allowedAgentIds?: string[] },
  ) =>
    apiRequest<{ ok: boolean }>(`/api/admin/api-keys/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteApiKey: (id: string) =>
    apiRequest<{ ok: boolean }>(`/api/admin/api-keys/${id}`, { method: 'DELETE' }),

  // Agents & Revisions
  getAgents: () => apiRequest<AgentDto[]>('/api/admin/agents'),
  createAgent: (data: {
    departmentId: string;
    slug: string;
    name: string;
    description: string;
    modelId: string | null;
    systemPrompt: string;
    temperature: number;
    contextDocs: string;
    mcpPermissions: {
      serverIds: string[];
      allowedTools: string[];
      readOnly: boolean;
    };
    changeNote?: string;
  }) =>
    apiRequest<AgentDto>('/api/admin/agents', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateAgent: (
    id: string,
    data: Partial<{
      name: string;
      description: string;
      modelId: string | null;
      systemPrompt: string;
      temperature: number;
      contextDocs: string;
      mcpPermissions: {
        serverIds: string[];
        allowedTools: string[];
        readOnly: boolean;
      };
      isActive: boolean;
      changeNote: string;
    }>,
  ) =>
    apiRequest<AgentDto>(`/api/admin/agents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteAgent: (id: string) =>
    apiRequest<{ ok: boolean }>(`/api/admin/agents/${id}`, { method: 'DELETE' }),
  getAgentRevisions: (id: string) =>
    apiRequest<AgentRevisionDto[]>(`/api/admin/agents/${id}/revisions`),
  rollbackAgentRevision: (agentId: string, revId: string) =>
    apiRequest<AgentDto>(`/api/admin/agents/${agentId}/revisions/${revId}/rollback`, {
      method: 'POST',
    }),

  // Templates & YAML
  getTemplates: () => apiRequest<YamlAgentTemplate[]>('/api/admin/templates'),
  getTemplateYaml: (id: string) =>
    apiRequest<{ yaml: string }>(`/api/admin/templates/${id}/yaml`),
  installTemplate: (
    id: string,
    data: { departmentId: string; slug?: string; modelId?: string | null },
  ) =>
    apiRequest<AgentDto>(`/api/admin/templates/${id}/install`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  exportAgentYaml: (id: string) =>
    apiRequest<{ slug: string; yaml: string }>(`/api/admin/agents/${id}/export-yaml`),
  importAgentYaml: (data: {
    departmentId: string;
    yamlContent: string;
    modelId?: string | null;
  }) =>
    apiRequest<AgentDto>('/api/admin/agents/import-yaml', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Usage & Alerts
  getUsage: (days = 30) =>
    apiRequest<{
      summary: UsageSummaryDto;
      logs: UsageLogDto[];
      alerts: SpendingAlertDto[];
    }>(`/api/admin/usage?days=${days}`),
  acknowledgeAlert: (id: string) =>
    apiRequest<{ ok: boolean }>(`/api/admin/alerts/${id}/acknowledge`, {
      method: 'POST',
    }),

  // Deploy & Webhooks
  getDeployFiles: () =>
    apiRequest<{
      originUrl: string;
      files: Array<{ name: string; category: string; content: string }>;
    }>('/api/deploy/files'),
  downloadDeployBundle: async () => {
    const token = getStoredToken();
    const res = await fetch('/api/deploy/bundle.zip', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      throw new ApiError(res.status, 'download_failed', 'Failed to download deploy bundle');
    }
    return res.blob();
  },
  testGitPrWebhook: (data: {
    agentSlug: string;
    repository: string;
    prNumber: string;
    title: string;
    diff: string;
  }) =>
    apiRequest<{
      ok: boolean;
      reviewMarkdown: string;
      usage: {
        inputTokens: number | null;
        outputTokens: number | null;
        calculatedCostUsd: number | null;
        costBasis: string;
        latencyMs: number;
      };
    }>('/api/webhooks/git-pr', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  testSlackWebhook: (data: {
    agentSlug: string;
    channel: string;
    userName: string;
    text: string;
  }) =>
    apiRequest<{
      ok: boolean;
      text: string;
      usage: {
        inputTokens: number | null;
        outputTokens: number | null;
        calculatedCostUsd: number | null;
        costBasis: string;
        latencyMs: number;
      };
    }>('/api/webhooks/slack', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

export interface StreamTraceToolEvent {
  step: number;
  serverSlug: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result: string;
  isError: boolean;
}

export interface StreamReceipt {
  calculated_cost_usd: number | null;
  cost_basis: string;
  usage_available: boolean;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  provider_type: string;
  upstream_model: string;
  tool_events: StreamTraceToolEvent[];
}

export async function streamChatCompletion(params: {
  model: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
  onDelta: (text: string) => void;
  onToolEvent: (ev: StreamTraceToolEvent) => void;
  onReceipt: (receipt: StreamReceipt) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const token = getStoredToken();
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'x-nawah-trace': '1',
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    }),
    signal: params.signal,
  });

  if (!res.ok) {
    const errJson = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    throw new ApiError(
      res.status,
      errJson.error?.code || `http_${res.status}`,
      errJson.error?.message || res.statusText || 'Chat completion failed',
    );
  }

  if (!res.body) {
    throw new ApiError(502, 'empty_stream', 'Server returned an empty SSE stream.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = 'message';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (line === '') {
        currentEvent = 'message';
        continue;
      }
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (parsed.error && typeof parsed.error === 'object') {
        const errObj = parsed.error as { code?: string; message?: string };
        throw new ApiError(
          502,
          errObj.code || 'stream_error',
          errObj.message || 'Streaming error occurred',
        );
      }

      if (currentEvent === 'nawah_tool') {
        params.onToolEvent(parsed as unknown as StreamTraceToolEvent);
        continue;
      }

      if (currentEvent === 'nawah_receipt') {
        params.onReceipt(parsed as unknown as StreamReceipt);
        continue;
      }

      const choices = parsed.choices as
        | Array<{ delta?: { content?: string } }>
        | undefined;
      const content = choices?.[0]?.delta?.content;
      if (typeof content === 'string' && content.length > 0) {
        params.onDelta(content);
      }
    }
  }
}
