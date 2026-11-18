import { and, eq, inArray } from 'drizzle-orm';
import type { AuthContext, McpPermissions, ProviderType } from '../../shared/types.ts';
import { db } from '../db/index.ts';
import {
  agents,
  departments,
  mcpServers,
  providerModels,
  providers,
} from '../db/schema.ts';
import { decryptSecret } from '../utils/crypto.ts';
import type { McpServerRecord } from './mcp-manager.ts';

export class GatewayError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: string;
  public readonly context?: {
    departmentId?: string | null;
    agentId?: string | null;
    providerType?: string;
    modelUsed?: string;
  };

  constructor(
    statusCode: number,
    errorCode: string,
    message: string,
    context?: GatewayError['context'],
  ) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.context = context;
  }
}

export interface HydratedExecution {
  agent: {
    id: string;
    workspaceId: string;
    departmentId: string;
    slug: string;
    name: string;
    temperature: number;
    assembledSystemPrompt: string;
    mcpPermissions: McpPermissions;
  };
  department: {
    id: string;
    name: string;
    monthlyAlertThresholdUsd: number;
    allowedModelIds: string[];
    allowedMcpServerIds: string[];
  };
  provider: {
    id: string;
    name: string;
    type: ProviderType;
    baseUrl: string | null;
    apiKey: string | null;
  };
  model: {
    id: string;
    modelId: string;
    supportsVision: boolean;
    inputCostPer1mUsd: number;
    outputCostPer1mUsd: number;
  };
  authorizedMcpServers: McpServerRecord[];
}

export function normalizeAgentSlug(requestedModel: string): string {
  const trimmed = requestedModel.trim();
  if (trimmed.startsWith('agent/')) {
    return trimmed.slice('agent/'.length);
  }
  return trimmed;
}

export function isAgentAuthorized(
  auth: AuthContext,
  agent: {
    id: string;
    workspaceId?: string;
    departmentId: string;
    isActive: boolean;
  },
): boolean {
  if (agent.workspaceId && agent.workspaceId !== auth.workspaceId) {
    return false;
  }
  if (!agent.isActive) {
    return false;
  }
  if (auth.allowedAgentIds.length > 0 && !auth.allowedAgentIds.includes(agent.id)) {
    return false;
  }
  if (auth.role === 'global_admin') {
    return true;
  }
  if (auth.role === 'department_admin') {
    return Boolean(auth.departmentId) && auth.departmentId === agent.departmentId;
  }
  // member: must match assigned department when present, or have explicit allowedAgentIds
  if (auth.departmentId) {
    return auth.departmentId === agent.departmentId;
  }
  return auth.allowedAgentIds.length > 0;
}

export function hydrateAgentExecution(
  auth: AuthContext,
  requestedModel: string,
): HydratedExecution {
  const slug = normalizeAgentSlug(requestedModel);

  const agent = db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, auth.workspaceId),
        eq(agents.slug, slug),
      ),
    )
    .get();

  if (!agent) {
    throw new GatewayError(
      404,
      'agent_not_found',
      `Agent "agent/${slug}" does not exist in this workspace.`,
      { modelUsed: requestedModel },
    );
  }

  if (!agent.isActive) {
    throw new GatewayError(
      403,
      'agent_inactive',
      `Agent "agent/${slug}" is currently disabled.`,
      { departmentId: agent.departmentId, agentId: agent.id, modelUsed: requestedModel },
    );
  }

  // Authorize caller access to this agent (fail closed on missing scope)
  if (!isAgentAuthorized(auth, agent)) {
    const isExplicitListDeny =
      auth.allowedAgentIds.length > 0 && !auth.allowedAgentIds.includes(agent.id);
    throw new GatewayError(
      403,
      isExplicitListDeny ? 'agent_access_denied' : 'department_access_denied',
      isExplicitListDeny
        ? `Your access key is not authorized to invoke "agent/${slug}".`
        : `Your access key does not have department or agent scope for "agent/${slug}".`,
      { departmentId: agent.departmentId, agentId: agent.id, modelUsed: requestedModel },
    );
  }

  const department = db
    .select()
    .from(departments)
    .where(
      and(
        eq(departments.id, agent.departmentId),
        eq(departments.workspaceId, auth.workspaceId),
      ),
    )
    .get();

  if (!department) {
    throw new GatewayError(
      500,
      'department_missing',
      'Agent department record could not be resolved.',
      { departmentId: agent.departmentId, agentId: agent.id, modelUsed: requestedModel },
    );
  }

  if (!agent.modelId) {
    throw new GatewayError(
      422,
      'agent_model_unassigned',
      `Agent "agent/${slug}" has no provider model assigned. Assign an active model in the Agents console.`,
      { departmentId: department.id, agentId: agent.id, modelUsed: requestedModel },
    );
  }

  if (
    department.allowedModelIds.length > 0 &&
    !department.allowedModelIds.includes(agent.modelId)
  ) {
    throw new GatewayError(
      403,
      'model_blocked_by_guardrail',
      `The model assigned to "agent/${slug}" is outside department "${department.name}" guardrails.`,
      { departmentId: department.id, agentId: agent.id, modelUsed: requestedModel },
    );
  }

  const providerModel = db
    .select()
    .from(providerModels)
    .where(eq(providerModels.id, agent.modelId))
    .get();

  if (!providerModel || !providerModel.isActive) {
    throw new GatewayError(
      422,
      'provider_model_unavailable',
      `The assigned model for "agent/${slug}" is missing or disabled.`,
      { departmentId: department.id, agentId: agent.id, modelUsed: requestedModel },
    );
  }

  const provider = db
    .select()
    .from(providers)
    .where(
      and(
        eq(providers.id, providerModel.providerId),
        eq(providers.workspaceId, auth.workspaceId),
      ),
    )
    .get();

  if (!provider || !provider.isActive) {
    throw new GatewayError(
      422,
      'provider_unavailable',
      `The upstream provider for "${providerModel.modelId}" is disabled or missing.`,
      {
        departmentId: department.id,
        agentId: agent.id,
        providerType: provider?.type || 'unknown',
        modelUsed: providerModel.modelId,
      },
    );
  }

  let decryptedKey: string | null = null;
  if (provider.encryptedApiKey) {
    try {
      decryptedKey = decryptSecret(provider.encryptedApiKey);
    } catch {
      throw new GatewayError(
        500,
        'provider_key_decrypt_failed',
        `Failed to decrypt API key for provider "${provider.name}". Verify NAWAH_MASTER_KEY.`,
        {
          departmentId: department.id,
          agentId: agent.id,
          providerType: provider.type,
          modelUsed: providerModel.modelId,
        },
      );
    }
  }

  const requiresApiKey =
    provider.type === 'openai' ||
    provider.type === 'anthropic' ||
    provider.type === 'google';

  if (requiresApiKey && !decryptedKey) {
    throw new GatewayError(
      422,
      'provider_key_missing',
      `Provider "${provider.name}" (${provider.type}) requires an API key before executing requests.`,
      {
        departmentId: department.id,
        agentId: agent.id,
        providerType: provider.type,
        modelUsed: providerModel.modelId,
      },
    );
  }

  // Assemble system prompt + context docs
  const assembledSystemPrompt = agent.contextDocs.trim()
    ? `${agent.systemPrompt.trim()}\n\n---\n\n## Department & Operational Context\n${agent.contextDocs.trim()}`
    : agent.systemPrompt.trim();

  // Resolve permitted MCP servers (intersection of agent permissions and department guardrails)
  const deptAllowedMcp = new Set(department.allowedMcpServerIds || []);
  const requestedServerIds = (agent.mcpPermissions?.serverIds || []).filter((id) =>
    deptAllowedMcp.has(id),
  );

  let authorizedMcpServers: McpServerRecord[] = [];
  if (requestedServerIds.length > 0) {
    authorizedMcpServers = db
      .select()
      .from(mcpServers)
      .where(
        and(
          eq(mcpServers.workspaceId, auth.workspaceId),
          inArray(mcpServers.id, requestedServerIds),
          eq(mcpServers.isActive, true),
        ),
      )
      .all();
  }

  return {
    agent: {
      id: agent.id,
      workspaceId: agent.workspaceId,
      departmentId: agent.departmentId,
      slug: agent.slug,
      name: agent.name,
      temperature: agent.temperature,
      assembledSystemPrompt,
      mcpPermissions: agent.mcpPermissions,
    },
    department: {
      id: department.id,
      name: department.name,
      monthlyAlertThresholdUsd: department.monthlyAlertThresholdUsd,
      allowedModelIds: department.allowedModelIds,
      allowedMcpServerIds: department.allowedMcpServerIds,
    },
    provider: {
      id: provider.id,
      name: provider.name,
      type: provider.type as ProviderType,
      baseUrl: provider.baseUrl,
      apiKey: decryptedKey,
    },
    model: {
      id: providerModel.id,
      modelId: providerModel.modelId,
      supportsVision: providerModel.supportsVision,
      inputCostPer1mUsd: providerModel.inputCostPer1mUsd,
      outputCostPer1mUsd: providerModel.outputCostPer1mUsd,
    },
    authorizedMcpServers,
  };
}
