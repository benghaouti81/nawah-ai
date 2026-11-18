import {
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';
import type { DiscoveredMcpTool, McpPermissions } from '../../shared/types.ts';

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: text('created_at').notNull(),
});

export const departments = sqliteTable(
  'departments',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    monthlyAlertThresholdUsd: real('monthly_alert_threshold_usd')
      .notNull()
      .default(0),
    allowedModelIds: text('allowed_model_ids', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    allowedMcpServerIds: text('allowed_mcp_server_ids', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('departments_workspace_slug_idx').on(
      table.workspaceId,
      table.slug,
    ),
  ],
);

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    departmentId: text('department_id').references(() => departments.id, {
      onDelete: 'set null',
    }),
    userLabel: text('user_label').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    role: text('role').notNull(), // 'global_admin' | 'department_admin' | 'member'
    allowedAgentIds: text('allowed_agent_ids', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
  },
  (table) => [
    index('api_keys_workspace_idx').on(table.workspaceId),
    index('api_keys_hash_idx').on(table.keyHash),
  ],
);

export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'openai' | 'anthropic' | 'google' | 'ollama' | 'openai_compatible'
  baseUrl: text('base_url'),
  encryptedApiKey: text('encrypted_api_key'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
});

export const providerModels = sqliteTable(
  'provider_models',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    supportsVision: integer('supports_vision', { mode: 'boolean' })
      .notNull()
      .default(false),
    inputCostPer1mUsd: real('input_cost_per_1m_usd').notNull().default(0),
    outputCostPer1mUsd: real('output_cost_per_1m_usd').notNull().default(0),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('provider_models_unique_idx').on(
      table.providerId,
      table.modelId,
    ),
  ],
);

export const mcpServers = sqliteTable(
  'mcp_servers',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    transport: text('transport').notNull(), // 'http_sse' | 'streamable_http' | 'stdio'
    endpointOrCommand: text('endpoint_or_command').notNull(),
    encryptedAuthHeaders: text('encrypted_auth_headers'),
    discoveredTools: text('discovered_tools', { mode: 'json' })
      .$type<DiscoveredMcpTool[]>()
      .notNull()
      .default([]),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('mcp_servers_workspace_slug_idx').on(
      table.workspaceId,
      table.slug,
    ),
  ],
);

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    departmentId: text('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    templateSourceId: text('template_source_id'),
    modelId: text('model_id').references(() => providerModels.id, {
      onDelete: 'set null',
    }),
    systemPrompt: text('system_prompt').notNull(),
    temperature: real('temperature').notNull().default(0.2),
    contextDocs: text('context_docs').notNull().default(''),
    mcpPermissions: text('mcp_permissions', { mode: 'json' })
      .$type<McpPermissions>()
      .notNull()
      .default({ serverIds: [], allowedTools: [], readOnly: true }),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('agents_workspace_slug_idx').on(table.workspaceId, table.slug),
    index('agents_department_idx').on(table.departmentId),
  ],
);

export const agentRevisions = sqliteTable(
  'agent_revisions',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    systemPrompt: text('system_prompt').notNull(),
    contextDocsSnapshot: text('context_docs_snapshot').notNull(),
    changedByKeyId: text('changed_by_key_id').references(() => apiKeys.id, {
      onDelete: 'set null',
    }),
    changeNote: text('change_note').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('agent_revisions_agent_idx').on(table.agentId)],
);

export const usageLogs = sqliteTable(
  'usage_logs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    departmentId: text('department_id').references(() => departments.id, {
      onDelete: 'set null',
    }),
    agentId: text('agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    apiKeyId: text('api_key_id').references(() => apiKeys.id, {
      onDelete: 'set null',
    }),
    userLabel: text('user_label').notNull(),
    providerType: text('provider_type').notNull(),
    modelUsed: text('model_used').notNull(),
    status: text('status').notNull(), // 'success' | 'failed'
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    actualCostUsd: real('actual_cost_usd'),
    latencyMs: integer('latency_ms').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('usage_logs_workspace_created_idx').on(
      table.workspaceId,
      table.createdAt,
    ),
    index('usage_logs_dept_created_idx').on(table.departmentId, table.createdAt),
  ],
);

export const spendingAlerts = sqliteTable(
  'spending_alerts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    departmentId: text('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'cascade' }),
    periodMonth: text('period_month').notNull(), // YYYY-MM
    thresholdUsd: real('threshold_usd').notNull(),
    actualSpentUsd: real('actual_spent_usd').notNull(),
    triggeredAt: text('triggered_at').notNull(),
    acknowledged: integer('acknowledged', { mode: 'boolean' })
      .notNull()
      .default(false),
  },
  (table) => [
    uniqueIndex('spending_alerts_dept_month_idx').on(
      table.departmentId,
      table.periodMonth,
    ),
  ],
);
