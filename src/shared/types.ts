import { z } from 'zod';

export const ROLES = ['global_admin', 'department_admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

export const PROVIDER_TYPES = [
  'openai',
  'anthropic',
  'google',
  'ollama',
  'openai_compatible',
] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const MCP_TRANSPORTS = ['http_sse', 'streamable_http', 'stdio'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const USAGE_STATUSES = ['success', 'failed'] as const;
export type UsageStatus = (typeof USAGE_STATUSES)[number];

export const mcpPermissionsSchema = z.object({
  serverIds: z.array(z.string()).default([]),
  allowedTools: z.array(z.string()).default([]),
  readOnly: z.boolean().default(true),
});
export type McpPermissions = z.infer<typeof mcpPermissionsSchema>;

export const yamlAgentTemplateSchema = z.object({
  id: z.string().min(1),
  version: z.string().default('0.1'),
  slug: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  name: z.string().min(2).max(120),
  description: z.string().min(4).max(600),
  temperature: z.number().min(0).max(2).default(0.2),
  system_prompt: z.string().min(10),
  context_docs: z.string().default(''),
  mcp_permissions: z
    .object({
      read_only: z.boolean().default(true),
      allowed_tools: z.array(z.string()).default([]),
      server_ids: z.array(z.string()).optional(),
    })
    .default({ read_only: true, allowed_tools: [] }),
});
export type YamlAgentTemplate = z.infer<typeof yamlAgentTemplateSchema>;

export interface AuthContext {
  keyId: string;
  workspaceId: string;
  departmentId: string | null;
  userLabel: string;
  keyPrefix: string;
  role: Role;
  allowedAgentIds: string[];
}

export interface DiscoveredMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface DepartmentDto {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  monthlyAlertThresholdUsd: number;
  allowedModelIds: string[];
  allowedMcpServerIds: string[];
  createdAt: string;
}

export interface ProviderModelDto {
  id: string;
  providerId: string;
  modelId: string;
  supportsVision: boolean;
  inputCostPer1mUsd: number;
  outputCostPer1mUsd: number;
  isActive: boolean;
  createdAt: string;
}

export interface ProviderDto {
  id: string;
  workspaceId: string;
  name: string;
  type: ProviderType;
  baseUrl: string | null;
  hasApiKey: boolean;
  isActive: boolean;
  createdAt: string;
  models: ProviderModelDto[];
}

export interface McpServerDto {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  transport: McpTransport;
  endpointOrCommand: string;
  hasAuthHeaders: boolean;
  discoveredTools: DiscoveredMcpTool[];
  isActive: boolean;
  createdAt: string;
}

export interface AgentDto {
  id: string;
  workspaceId: string;
  departmentId: string;
  departmentName?: string;
  slug: string;
  name: string;
  description: string;
  templateSourceId: string | null;
  modelId: string | null;
  modelName?: string | null;
  providerName?: string | null;
  systemPrompt: string;
  temperature: number;
  contextDocs: string;
  mcpPermissions: McpPermissions;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRevisionDto {
  id: string;
  agentId: string;
  systemPrompt: string;
  contextDocsSnapshot: string;
  changedByKeyId: string | null;
  changedByLabel?: string | null;
  changeNote: string;
  createdAt: string;
}

export interface ApiKeyDto {
  id: string;
  workspaceId: string;
  departmentId: string | null;
  departmentName?: string | null;
  userLabel: string;
  keyPrefix: string;
  role: Role;
  allowedAgentIds: string[];
  isActive: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface UsageLogDto {
  id: string;
  workspaceId: string;
  departmentId: string | null;
  departmentName?: string | null;
  agentId: string | null;
  agentSlug?: string | null;
  agentName?: string | null;
  apiKeyId: string | null;
  userLabel: string;
  providerType: string;
  modelUsed: string;
  status: UsageStatus;
  errorCode: string | null;
  errorMessage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  calculatedCostUsd: number | null;
  usageAvailable: boolean;
  latencyMs: number;
  createdAt: string;
}

export interface SpendingAlertDto {
  id: string;
  workspaceId: string;
  departmentId: string;
  departmentName?: string;
  periodMonth: string;
  thresholdUsd: number;
  calculatedSpentUsd: number;
  triggeredAt: string;
  acknowledged: boolean;
}

export interface UsageSummaryDto {
  totalCalculatedCostUsd: number | null;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  unavailableUsageRequests: number;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  byDepartment: Array<{
    departmentId: string;
    departmentName: string;
    calculatedCostUsd: number | null;
    requests: number;
    thresholdUsd: number;
    unavailableUsageRequests: number;
  }>;
  byAgent: Array<{
    agentId: string;
    agentSlug: string;
    agentName: string;
    calculatedCostUsd: number | null;
    requests: number;
    tokens: number | null;
    unavailableUsageRequests: number;
  }>;
  byProvider: Array<{
    providerType: string;
    calculatedCostUsd: number | null;
    requests: number;
    inputTokens: number | null;
    outputTokens: number | null;
    unavailableUsageRequests: number;
  }>;
  byModel: Array<{
    providerType: string;
    modelUsed: string;
    calculatedCostUsd: number | null;
    requests: number;
    inputTokens: number | null;
    outputTokens: number | null;
    unavailableUsageRequests: number;
  }>;
  byUser: Array<{
    userLabel: string;
    calculatedCostUsd: number | null;
    requests: number;
    tokens: number | null;
    unavailableUsageRequests: number;
  }>;
}
