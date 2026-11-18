import { Router } from 'express';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  MCP_TRANSPORTS,
  PROVIDER_TYPES,
  ROLES,
  mcpPermissionsSchema,
  type McpPermissions,
  type ProviderType,
  type Role,
  type UsageSummaryDto,
} from '../../shared/types.ts';
import { db } from '../db/index.ts';
import {
  agentRevisions,
  agents,
  apiKeys,
  departments,
  mcpServers,
  providerModels,
  providers,
  spendingAlerts,
  usageLogs,
} from '../db/schema.ts';
import { isAgentAuthorized } from '../engine/agent-hydrator.ts';
import { discoverServerTools } from '../engine/mcp-manager.ts';
import { testProviderConnection } from '../engine/provider-router.ts';
import { requireAuth, requireRole } from '../middleware/auth.ts';
import {
  getDiskTemplateRaw,
  loadDiskTemplates,
  parseAndValidateAgentYaml,
  serializeAgentToYaml,
} from '../templates/loader.ts';
import {
  decryptSecret,
  encryptSecret,
  generateApiKey,
  makeId,
} from '../utils/crypto.ts';

export const adminRouter = Router();
adminRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Providers & Models
// ---------------------------------------------------------------------------

const createProviderSchema = z.object({
  name: z.string().trim().min(2).max(100),
  type: z.enum(PROVIDER_TYPES),
  baseUrl: z.string().trim().optional().nullable(),
  apiKey: z.string().trim().optional().nullable(),
  isActive: z.boolean().optional().default(true),
});

const updateProviderSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  baseUrl: z.string().trim().optional().nullable(),
  apiKey: z.string().trim().optional().nullable(),
  clearApiKey: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const createModelSchema = z.object({
  modelId: z.string().trim().min(1).max(160),
  supportsVision: z.boolean().optional().default(false),
  inputCostPer1mUsd: z.number().min(0).default(0),
  outputCostPer1mUsd: z.number().min(0).default(0),
  isActive: z.boolean().optional().default(true),
});

const updateModelSchema = z.object({
  supportsVision: z.boolean().optional(),
  inputCostPer1mUsd: z.number().min(0).optional(),
  outputCostPer1mUsd: z.number().min(0).optional(),
  isActive: z.boolean().optional(),
});

adminRouter.get('/providers', requireRole('global_admin', 'department_admin'), (req, res) => {
  const auth = req.auth!;
  const allProviders = db
    .select()
    .from(providers)
    .where(eq(providers.workspaceId, auth.workspaceId))
    .all();
  const allModels = db.select().from(providerModels).all();

  const modelsByProvider = new Map<string, typeof allModels>();
  for (const m of allModels) {
    const list = modelsByProvider.get(m.providerId) ?? [];
    list.push(m);
    modelsByProvider.set(m.providerId, list);
  }

  res.json(
    allProviders.map((p) => ({
      id: p.id,
      workspaceId: p.workspaceId,
      name: p.name,
      type: p.type,
      baseUrl: p.baseUrl,
      hasApiKey: Boolean(p.encryptedApiKey),
      isActive: p.isActive,
      createdAt: p.createdAt,
      models: modelsByProvider.get(p.id) ?? [],
    })),
  );
});

adminRouter.post('/providers', requireRole('global_admin'), (req, res) => {
  const auth = req.auth!;
  const parsed = createProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: parsed.error.issues[0]?.message || 'Invalid provider payload',
      },
    });
    return;
  }

  const { name, type, baseUrl, apiKey, isActive } = parsed.data;
  if (type === 'openai_compatible' && !baseUrl) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'OpenAI-compatible providers require a baseUrl.',
      },
    });
    return;
  }

  const id = makeId('prov');
  const now = new Date().toISOString();
  const encryptedApiKey = apiKey ? encryptSecret(apiKey) : null;

  db.insert(providers)
    .values({
      id,
      workspaceId: auth.workspaceId,
      name,
      type,
      baseUrl: baseUrl || null,
      encryptedApiKey,
      isActive,
      createdAt: now,
    })
    .run();

  res.status(201).json({
    id,
    workspaceId: auth.workspaceId,
    name,
    type,
    baseUrl: baseUrl || null,
    hasApiKey: Boolean(encryptedApiKey),
    isActive,
    createdAt: now,
    models: [],
  });
});

adminRouter.patch('/providers/:id', requireRole('global_admin'), (req, res) => {
  const auth = req.auth!;
  const existing = db
    .select()
    .from(providers)
    .where(and(eq(providers.id, req.params.id), eq(providers.workspaceId, auth.workspaceId)))
    .get();
  if (!existing) {
    res.status(404).json({ error: { code: 'not_found', message: 'Provider not found' } });
    return;
  }

  const parsed = updateProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: parsed.error.issues[0]?.message || 'Invalid provider update',
      },
    });
    return;
  }

  let nextEncryptedKey = existing.encryptedApiKey;
  if (parsed.data.clearApiKey) {
    nextEncryptedKey = null;
  } else if (parsed.data.apiKey && parsed.data.apiKey.length > 0) {
    nextEncryptedKey = encryptSecret(parsed.data.apiKey);
  }

  db.update(providers)
    .set({
      name: parsed.data.name ?? existing.name,
      baseUrl:
        parsed.data.baseUrl !== undefined ? parsed.data.baseUrl || null : existing.baseUrl,
      encryptedApiKey: nextEncryptedKey,
      isActive: parsed.data.isActive ?? existing.isActive,
    })
    .where(eq(providers.id, existing.id))
    .run();

  res.json({ ok: true });
});

adminRouter.delete('/providers/:id', requireRole('global_admin'), (req, res) => {
  const auth = req.auth!;
  const existing = db
    .select()
    .from(providers)
    .where(and(eq(providers.id, req.params.id), eq(providers.workspaceId, auth.workspaceId)))
    .get();
  if (!existing) {
    res.status(404).json({ error: { code: 'not_found', message: 'Provider not found' } });
    return;
  }
  db.delete(providers).where(eq(providers.id, existing.id)).run();
  res.json({ ok: true });
});

adminRouter.post('/providers/:id/test', requireRole('global_admin'), async (req, res) => {
  const auth = req.auth!;
  const provider = db
    .select()
    .from(providers)
    .where(and(eq(providers.id, req.params.id), eq(providers.workspaceId, auth.workspaceId)))
    .get();
  if (!provider) {
    res.status(404).json({ error: { code: 'not_found', message: 'Provider not found' } });
    return;
  }

  let apiKey: string | null = null;
  if (provider.encryptedApiKey) {
    try {
      apiKey = decryptSecret(provider.encryptedApiKey);
    } catch {
      res.status(500).json({
        ok: false,
        latencyMs: 0,
        error: 'Failed to decrypt stored provider key.',
      });
      return;
    }
  }

  const result = await testProviderConnection({
    type: provider.type as ProviderType,
    baseUrl: provider.baseUrl,
    apiKey,
  });
  res.json(result);
});

adminRouter.post('/providers/:id/models', requireRole('global_admin'), (req, res) => {
  const auth = req.auth!;
  const provider = db
    .select()
    .from(providers)
    .where(and(eq(providers.id, req.params.id), eq(providers.workspaceId, auth.workspaceId)))
    .get();
  if (!provider) {
    res.status(404).json({ error: { code: 'not_found', message: 'Provider not found' } });
    return;
  }

  const parsed = createModelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: parsed.error.issues[0]?.message || 'Invalid model payload',
      },
    });
    return;
  }

  const id = makeId('mdl');
  const now = new Date().toISOString();
  try {
    db.insert(providerModels)
      .values({
        id,
        providerId: provider.id,
        modelId: parsed.data.modelId,
        supportsVision: parsed.data.supportsVision,
        inputCostPer1mUsd: parsed.data.inputCostPer1mUsd,
        outputCostPer1mUsd: parsed.data.outputCostPer1mUsd,
        isActive: parsed.data.isActive,
        createdAt: now,
      })
      .run();
  } catch (err) {
    res.status(409).json({
      error: {
        code: 'duplicate_model',
        message:
          err instanceof Error ? err.message : 'Model ID already exists for provider',
      },
    });
    return;
  }

  res.status(201).json({
    id,
    providerId: provider.id,
    modelId: parsed.data.modelId,
    supportsVision: parsed.data.supportsVision,
    inputCostPer1mUsd: parsed.data.inputCostPer1mUsd,
    outputCostPer1mUsd: parsed.data.outputCostPer1mUsd,
    isActive: parsed.data.isActive,
    createdAt: now,
  });
});

adminRouter.patch('/models/:id', requireRole('global_admin'), (req, res) => {
  const auth = req.auth!;
  const existing = db
    .select()
    .from(providerModels)
    .where(eq(providerModels.id, req.params.id))
    .get();
  const ownerProvider = existing
    ? db
        .select()
        .from(providers)
        .where(
          and(
            eq(providers.id, existing.providerId),
            eq(providers.workspaceId, auth.workspaceId),
          ),
        )
        .get()
    : undefined;
  if (!existing || !ownerProvider) {
    res.status(404).json({ error: { code: 'not_found', message: 'Model not found' } });
    return;
  }
  const parsed = updateModelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'validation_error', message: 'Invalid model update' } });
    return;
  }
  db.update(providerModels)
    .set({
      supportsVision: parsed.data.supportsVision ?? existing.supportsVision,
      inputCostPer1mUsd: parsed.data.inputCostPer1mUsd ?? existing.inputCostPer1mUsd,
      outputCostPer1mUsd: parsed.data.outputCostPer1mUsd ?? existing.outputCostPer1mUsd,
      isActive: parsed.data.isActive ?? existing.isActive,
    })
    .where(eq(providerModels.id, existing.id))
    .run();
  res.json({ ok: true });
});

adminRouter.delete('/models/:id', requireRole('global_admin'), (req, res) => {
  const auth = req.auth!;
  const existing = db
    .select()
    .from(providerModels)
    .where(eq(providerModels.id, req.params.id))
    .get();
  const ownerProvider = existing
    ? db
        .select()
        .from(providers)
        .where(
          and(
            eq(providers.id, existing.providerId),
            eq(providers.workspaceId, auth.workspaceId),
          ),
        )
        .get()
    : undefined;
  if (!existing || !ownerProvider) {
    res.status(404).json({ error: { code: 'not_found', message: 'Model not found' } });
    return;
  }
  db.delete(providerModels).where(eq(providerModels.id, existing.id)).run();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Departments & Guardrails
// ---------------------------------------------------------------------------

const createDeptSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  monthlyAlertThresholdUsd: z.number().min(0).default(0),
  allowedModelIds: z.array(z.string()).default([]),
  allowedMcpServerIds: z.array(z.string()).default([]),
});

const updateDeptSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  monthlyAlertThresholdUsd: z.number().min(0).optional(),
  allowedModelIds: z.array(z.string()).optional(),
  allowedMcpServerIds: z.array(z.string()).optional(),
});

adminRouter.get('/departments', requireRole('global_admin', 'department_admin'), (req, res) => {
  const auth = req.auth!;
  if (auth.role === 'global_admin') {
    const rows = db
      .select()
      .from(departments)
      .where(eq(departments.workspaceId, auth.workspaceId))
      .all();
    res.json(rows);
    return;
  }
  if (!auth.departmentId) {
    res.json([]);
    return;
  }
  const rows = db
    .select()
    .from(departments)
    .where(
      and(
        eq(departments.workspaceId, auth.workspaceId),
        eq(departments.id, auth.departmentId),
      ),
    )
    .all();
  res.json(rows);
});

adminRouter.post('/departments', requireRole('global_admin'), (req, res) => {
  const auth = req.auth!;
  const parsed = createDeptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: parsed.error.issues[0]?.message || 'Invalid department payload',
      },
    });
    return;
  }

  const id = makeId('dept');
  const now = new Date().toISOString();
  try {
    db.insert(departments)
      .values({
        id,
        workspaceId: auth.workspaceId,
        name: parsed.data.name,
        slug: parsed.data.slug,
        monthlyAlertThresholdUsd: parsed.data.monthlyAlertThresholdUsd,
        allowedModelIds: parsed.data.allowedModelIds,
        allowedMcpServerIds: parsed.data.allowedMcpServerIds,
        createdAt: now,
      })
      .run();
  } catch (err) {
    res.status(409).json({
      error: {
        code: 'duplicate_slug',
        message:
          err instanceof Error ? err.message : 'Department slug already exists',
      },
    });
    return;
  }

  const created = db.select().from(departments).where(eq(departments.id, id)).get();
  res.status(201).json(created);
});

adminRouter.patch(
  '/departments/:id',
  requireRole('global_admin', 'department_admin'),
  (req, res) => {
    const auth = req.auth!;
    const existing = db
      .select()
      .from(departments)
      .where(
        and(
          eq(departments.id, req.params.id),
          eq(departments.workspaceId, auth.workspaceId),
        ),
      )
      .get();

    if (!existing) {
      res.status(404).json({ error: { code: 'not_found', message: 'Department not found' } });
      return;
    }

    if (auth.role === 'department_admin' && auth.departmentId !== existing.id) {
      res.status(403).json({
        error: {
          code: 'forbidden',
          message: 'Department admins can only manage their own department.',
        },
      });
      return;
    }

    const parsed = updateDeptSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'validation_error',
          message: parsed.error.issues[0]?.message || 'Invalid department update',
        },
      });
      return;
    }

    // Department admin can only update monthlyAlertThresholdUsd; global_admin controls guardrails
    if (
      auth.role === 'department_admin' &&
      (parsed.data.allowedModelIds !== undefined ||
        parsed.data.allowedMcpServerIds !== undefined ||
        parsed.data.name !== undefined)
    ) {
      res.status(403).json({
        error: {
          code: 'forbidden',
          message:
            'Only global_admin can modify department model or MCP server guardrails.',
        },
      });
      return;
    }

    db.update(departments)
      .set({
        name: parsed.data.name ?? existing.name,
        monthlyAlertThresholdUsd:
          parsed.data.monthlyAlertThresholdUsd ?? existing.monthlyAlertThresholdUsd,
        allowedModelIds: parsed.data.allowedModelIds ?? existing.allowedModelIds,
        allowedMcpServerIds:
          parsed.data.allowedMcpServerIds ?? existing.allowedMcpServerIds,
      })
      .where(eq(departments.id, existing.id))
      .run();

    const updated = db
      .select()
      .from(departments)
      .where(eq(departments.id, existing.id))
      .get();
    res.json(updated);
  },
);

adminRouter.delete('/departments/:id', requireRole('global_admin'), (req, res) => {
  const auth = req.auth!;
  db.delete(departments)
    .where(
      and(
        eq(departments.id, req.params.id),
        eq(departments.workspaceId, auth.workspaceId),
      ),
    )
    .run();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// MCP Servers (stdio restricted strictly to global_admin)
// ---------------------------------------------------------------------------

const createMcpSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  transport: z.enum(MCP_TRANSPORTS),
  endpointOrCommand: z.string().trim().min(1),
  authHeadersJson: z.string().optional().nullable(),
  isActive: z.boolean().optional().default(true),
});

const updateMcpSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  transport: z.enum(MCP_TRANSPORTS).optional(),
  endpointOrCommand: z.string().trim().min(1).optional(),
  authHeadersJson: z.string().optional().nullable(),
  clearAuthHeaders: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

adminRouter.get('/mcp-servers', requireRole('global_admin', 'department_admin'), (req, res) => {
  const auth = req.auth!;
  let rows = db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.workspaceId, auth.workspaceId))
    .all();

  if (auth.role !== 'global_admin') {
    if (!auth.departmentId) {
      res.json([]);
      return;
    }
    const dept = db
      .select()
      .from(departments)
      .where(eq(departments.id, auth.departmentId))
      .get();
    const allowedSet = new Set(dept?.allowedMcpServerIds ?? []);
    rows = rows.filter((r) => allowedSet.has(r.id));
  }

  res.json(
    rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      name: r.name,
      slug: r.slug,
      transport: r.transport,
      endpointOrCommand: r.endpointOrCommand,
      hasAuthHeaders: Boolean(r.encryptedAuthHeaders),
      discoveredTools: r.discoveredTools ?? [],
      isActive: r.isActive,
      createdAt: r.createdAt,
    })),
  );
});

adminRouter.post('/mcp-servers', requireRole('global_admin'), (req, res) => {
  const auth = req.auth!;
  const parsed = createMcpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: parsed.error.issues[0]?.message || 'Invalid MCP server payload',
      },
    });
    return;
  }

  if (parsed.data.transport !== 'stdio') {
    try {
      new URL(parsed.data.endpointOrCommand);
    } catch {
      res.status(400).json({
        error: {
          code: 'validation_error',
          message: 'HTTP/SSE MCP transports require a valid URL.',
        },
      });
      return;
    }
  }

  let encryptedAuthHeaders: string | null = null;
  if (parsed.data.authHeadersJson?.trim()) {
    try {
      const obj = JSON.parse(parsed.data.authHeadersJson);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new Error('Must be JSON object');
      }
      encryptedAuthHeaders = encryptSecret(JSON.stringify(obj));
    } catch {
      res.status(400).json({
        error: {
          code: 'validation_error',
          message: 'authHeadersJson must be a valid JSON object of header key/value pairs.',
        },
      });
      return;
    }
  }

  const id = makeId('mcp');
  const now = new Date().toISOString();
  try {
    db.insert(mcpServers)
      .values({
        id,
        workspaceId: auth.workspaceId,
        name: parsed.data.name,
        slug: parsed.data.slug,
        transport: parsed.data.transport,
        endpointOrCommand: parsed.data.endpointOrCommand,
        encryptedAuthHeaders,
        discoveredTools: [],
        isActive: parsed.data.isActive,
        createdAt: now,
      })
      .run();
  } catch (err) {
    res.status(409).json({
      error: {
        code: 'duplicate_slug',
        message: err instanceof Error ? err.message : 'MCP server slug already exists',
      },
    });
    return;
  }

  res.status(201).json({
    id,
    workspaceId: auth.workspaceId,
    name: parsed.data.name,
    slug: parsed.data.slug,
    transport: parsed.data.transport,
    endpointOrCommand: parsed.data.endpointOrCommand,
    hasAuthHeaders: Boolean(encryptedAuthHeaders),
    discoveredTools: [],
    isActive: parsed.data.isActive,
    createdAt: now,
  });
});

adminRouter.patch('/mcp-servers/:id', requireRole('global_admin'), (req, res) => {
  const auth = req.auth!;
  const existing = db
    .select()
    .from(mcpServers)
    .where(
      and(
        eq(mcpServers.id, req.params.id),
        eq(mcpServers.workspaceId, auth.workspaceId),
      ),
    )
    .get();
  if (!existing) {
    res.status(404).json({ error: { code: 'not_found', message: 'MCP server not found' } });
    return;
  }

  const parsed = updateMcpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'validation_error', message: 'Invalid MCP update' } });
    return;
  }

  let nextEncryptedHeaders = existing.encryptedAuthHeaders;
  if (parsed.data.clearAuthHeaders) {
    nextEncryptedHeaders = null;
  } else if (parsed.data.authHeadersJson?.trim()) {
    try {
      const obj = JSON.parse(parsed.data.authHeadersJson);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new Error('Must be JSON object');
      }
      nextEncryptedHeaders = encryptSecret(JSON.stringify(obj));
    } catch {
      res.status(400).json({
        error: {
          code: 'validation_error',
          message: 'authHeadersJson must be a valid JSON object.',
        },
      });
      return;
    }
  }

  db.update(mcpServers)
    .set({
      name: parsed.data.name ?? existing.name,
      transport: parsed.data.transport ?? existing.transport,
      endpointOrCommand: parsed.data.endpointOrCommand ?? existing.endpointOrCommand,
      encryptedAuthHeaders: nextEncryptedHeaders,
      isActive: parsed.data.isActive ?? existing.isActive,
    })
    .where(eq(mcpServers.id, existing.id))
    .run();

  res.json({ ok: true });
});

adminRouter.delete('/mcp-servers/:id', requireRole('global_admin'), (req, res) => {
  const auth = req.auth!;
  db.delete(mcpServers)
    .where(
      and(
        eq(mcpServers.id, req.params.id),
        eq(mcpServers.workspaceId, auth.workspaceId),
      ),
    )
    .run();
  res.json({ ok: true });
});

adminRouter.post(
  '/mcp-servers/:id/discover',
  requireRole('global_admin'),
  async (req, res) => {
    const auth = req.auth!;
    const server = db
      .select()
      .from(mcpServers)
      .where(
        and(
          eq(mcpServers.id, req.params.id),
          eq(mcpServers.workspaceId, auth.workspaceId),
        ),
      )
      .get();
    if (!server) {
      res.status(404).json({ error: { code: 'not_found', message: 'MCP server not found' } });
      return;
    }

    try {
      const tools = await discoverServerTools(server);
      db.update(mcpServers)
        .set({ discoveredTools: tools })
        .where(eq(mcpServers.id, server.id))
        .run();
      res.json({ ok: true, tools });
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: {
          code: 'mcp_discovery_failed',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to connect and list MCP tools',
        },
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Access Keys (global_admin only)
// ---------------------------------------------------------------------------

const createApiKeySchema = z.object({
  userLabel: z.string().trim().min(2).max(120),
  role: z.enum(ROLES),
  departmentId: z.string().nullable().optional(),
  allowedAgentIds: z.array(z.string()).default([]),
});

const updateApiKeySchema = z.object({
  isActive: z.boolean().optional(),
  allowedAgentIds: z.array(z.string()).optional(),
});

adminRouter.get('/api-keys', requireRole('global_admin'), (req, res) => {
  const auth = req.auth!;
  const keys = db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.workspaceId, auth.workspaceId))
    .orderBy(desc(apiKeys.createdAt))
    .all();
  const depts = db
    .select()
    .from(departments)
    .where(eq(departments.workspaceId, auth.workspaceId))
    .all();
  const deptMap = new Map(depts.map((d) => [d.id, d.name]));

  res.json(
    keys.map((k) => ({
      id: k.id,
      workspaceId: k.workspaceId,
      departmentId: k.departmentId,
      departmentName: k.departmentId ? deptMap.get(k.departmentId) ?? null : null,
      userLabel: k.userLabel,
      keyPrefix: k.keyPrefix,
      role: k.role,
      allowedAgentIds: k.allowedAgentIds,
      isActive: k.isActive,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
    })),
  );
});

function validateApiKeyScope(params: {
  workspaceId: string;
  role: Role;
  departmentId: string | null;
  allowedAgentIds: string[];
}): { error?: string; normalizedAgentIds: string[] } {
  const uniqueIds = Array.from(new Set(params.allowedAgentIds.filter(Boolean)));

  if (params.role === 'department_admin' && !params.departmentId) {
    return { error: 'department_admin keys must be scoped to a department.', normalizedAgentIds: [] };
  }

  if (params.role === 'member' && !params.departmentId && uniqueIds.length === 0) {
    return {
      error: 'member keys must be scoped to a department or at least one allowed agent.',
      normalizedAgentIds: [],
    };
  }

  if (uniqueIds.length > 0) {
    const foundAgents = db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, params.workspaceId),
          inArray(agents.id, uniqueIds),
        ),
      )
      .all();

    if (foundAgents.length !== uniqueIds.length) {
      return {
        error: 'One or more allowedAgentIds do not exist in this workspace.',
        normalizedAgentIds: [],
      };
    }

    if (params.role !== 'global_admin' && params.departmentId) {
      const crossDept = foundAgents.find((a) => a.departmentId !== params.departmentId);
      if (crossDept) {
        return {
          error: `Agent "${crossDept.slug}" belongs to a different department than this key.`,
          normalizedAgentIds: [],
        };
      }
    }
  }

  return { normalizedAgentIds: uniqueIds };
}

adminRouter.post('/api-keys', requireRole('global_admin'), (req, res) => {
  const auth = req.auth!;
  const parsed = createApiKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: parsed.error.issues[0]?.message || 'Invalid access key payload',
      },
    });
    return;
  }

  const targetDeptId = parsed.data.departmentId ?? null;
  if (targetDeptId) {
    const dept = db
      .select()
      .from(departments)
      .where(
        and(
          eq(departments.id, targetDeptId),
          eq(departments.workspaceId, auth.workspaceId),
        ),
      )
      .get();
    if (!dept) {
      res.status(404).json({
        error: { code: 'not_found', message: 'Selected department does not exist.' },
      });
      return;
    }
  }

  const scopeCheck = validateApiKeyScope({
    workspaceId: auth.workspaceId,
    role: parsed.data.role as Role,
    departmentId: targetDeptId,
    allowedAgentIds: parsed.data.allowedAgentIds,
  });
  if (scopeCheck.error) {
    res.status(400).json({
      error: { code: 'validation_error', message: scopeCheck.error },
    });
    return;
  }

  const generated = generateApiKey(parsed.data.role as Role);
  const id = makeId('key');
  const now = new Date().toISOString();

  db.insert(apiKeys)
    .values({
      id,
      workspaceId: auth.workspaceId,
      departmentId: targetDeptId,
      userLabel: parsed.data.userLabel,
      keyPrefix: generated.keyPrefix,
      keyHash: generated.keyHash,
      role: parsed.data.role,
      allowedAgentIds: scopeCheck.normalizedAgentIds,
      isActive: true,
      createdAt: now,
      lastUsedAt: null,
    })
    .run();

  res.status(201).json({
    rawKey: generated.rawKey,
    key: {
      id,
      workspaceId: auth.workspaceId,
      departmentId: targetDeptId,
      userLabel: parsed.data.userLabel,
      keyPrefix: generated.keyPrefix,
      role: parsed.data.role,
      allowedAgentIds: scopeCheck.normalizedAgentIds,
      isActive: true,
      createdAt: now,
      lastUsedAt: null,
    },
  });
});

adminRouter.patch('/api-keys/:id', requireRole('global_admin'), (req, res) => {
  const auth = req.auth!;
  const existing = db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, req.params.id), eq(apiKeys.workspaceId, auth.workspaceId)))
    .get();
  if (!existing) {
    res.status(404).json({ error: { code: 'not_found', message: 'Access key not found' } });
    return;
  }

  const parsed = updateApiKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'validation_error', message: 'Invalid update' } });
    return;
  }

  if (existing.id === auth.keyId && parsed.data.isActive === false) {
    res.status(400).json({
      error: {
        code: 'cannot_revoke_self',
        message: 'You cannot revoke the access key you are currently authenticated with.',
      },
    });
    return;
  }

  let nextAllowedAgentIds = existing.allowedAgentIds;
  if (parsed.data.allowedAgentIds !== undefined) {
    const scopeCheck = validateApiKeyScope({
      workspaceId: auth.workspaceId,
      role: existing.role as Role,
      departmentId: existing.departmentId,
      allowedAgentIds: parsed.data.allowedAgentIds,
    });
    if (scopeCheck.error) {
      res.status(400).json({
        error: { code: 'validation_error', message: scopeCheck.error },
      });
      return;
    }
    nextAllowedAgentIds = scopeCheck.normalizedAgentIds;
  }

  db.update(apiKeys)
    .set({
      isActive: parsed.data.isActive ?? existing.isActive,
      allowedAgentIds: nextAllowedAgentIds,
    })
    .where(eq(apiKeys.id, existing.id))
    .run();

  res.json({ ok: true });
});

adminRouter.delete('/api-keys/:id', requireRole('global_admin'), (req, res) => {
  const auth = req.auth!;
  if (req.params.id === auth.keyId) {
    res.status(400).json({
      error: {
        code: 'cannot_delete_self',
        message: 'You cannot delete the access key currently in use.',
      },
    });
    return;
  }
  db.delete(apiKeys)
    .where(and(eq(apiKeys.id, req.params.id), eq(apiKeys.workspaceId, auth.workspaceId)))
    .run();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Agents, Revisions & Rollback
// ---------------------------------------------------------------------------

const createAgentSchema = z.object({
  departmentId: z.string().min(1),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().min(4).max(600),
  modelId: z.string().nullable().optional(),
  systemPrompt: z.string().min(10),
  temperature: z.number().min(0).max(2).default(0.2),
  contextDocs: z.string().default(''),
  mcpPermissions: mcpPermissionsSchema.default({
    serverIds: [],
    allowedTools: [],
    readOnly: true,
  }),
  isActive: z.boolean().optional().default(true),
  changeNote: z.string().trim().optional().default('Initial agent creation'),
});

const updateAgentSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().min(4).max(600).optional(),
  modelId: z.string().nullable().optional(),
  systemPrompt: z.string().min(10).optional(),
  temperature: z.number().min(0).max(2).optional(),
  contextDocs: z.string().optional(),
  mcpPermissions: mcpPermissionsSchema.optional(),
  isActive: z.boolean().optional(),
  changeNote: z.string().trim().optional(),
});

function validateDepartmentGuardrails(params: {
  workspaceId: string;
  departmentId: string;
  modelId?: string | null;
  mcpPermissions?: McpPermissions;
}): { status: number; code: string; message: string } | null {
  const dept = db
    .select()
    .from(departments)
    .where(
      and(
        eq(departments.id, params.departmentId),
        eq(departments.workspaceId, params.workspaceId),
      ),
    )
    .get();
  if (!dept) {
    return { status: 404, code: 'not_found', message: 'Department not found in this workspace.' };
  }

  if (params.modelId) {
    const model = db
      .select()
      .from(providerModels)
      .where(eq(providerModels.id, params.modelId))
      .get();
    const provider = model
      ? db
          .select()
          .from(providers)
          .where(
            and(
              eq(providers.id, model.providerId),
              eq(providers.workspaceId, params.workspaceId),
            ),
          )
          .get()
      : undefined;

    if (!model || !provider) {
      return {
        status: 400,
        code: 'validation_error',
        message: 'Selected model does not exist in this workspace.',
      };
    }

    if (
      dept.allowedModelIds.length > 0 &&
      !dept.allowedModelIds.includes(params.modelId)
    ) {
      return {
        status: 403,
        code: 'guardrail_violation',
        message: `Selected model is outside department "${dept.name}" allowed models guardrail.`,
      };
    }
  }

  if (params.mcpPermissions && params.mcpPermissions.serverIds.length > 0) {
    const uniqueServerIds = Array.from(new Set(params.mcpPermissions.serverIds));
    const foundServers = db
      .select()
      .from(mcpServers)
      .where(
        and(
          eq(mcpServers.workspaceId, params.workspaceId),
          inArray(mcpServers.id, uniqueServerIds),
        ),
      )
      .all();

    if (foundServers.length !== uniqueServerIds.length) {
      return {
        status: 400,
        code: 'validation_error',
        message: 'One or more MCP servers do not exist in this workspace.',
      };
    }

    const allowedSet = new Set(dept.allowedMcpServerIds);
    for (const sid of uniqueServerIds) {
      if (!allowedSet.has(sid)) {
        return {
          status: 403,
          code: 'guardrail_violation',
          message: `MCP server "${sid}" is not permitted by department "${dept.name}" guardrails.`,
        };
      }
    }
  }

  return null;
}

adminRouter.get('/agents', (req, res) => {
  const auth = req.auth!;
  let rows = db
    .select()
    .from(agents)
    .where(eq(agents.workspaceId, auth.workspaceId))
    .orderBy(desc(agents.updatedAt))
    .all();

  if (auth.role === 'department_admin') {
    rows = rows.filter(
      (a) =>
        Boolean(auth.departmentId) &&
        a.departmentId === auth.departmentId &&
        (auth.allowedAgentIds.length === 0 || auth.allowedAgentIds.includes(a.id)),
    );
  } else if (auth.role === 'member') {
    rows = rows.filter((a) => isAgentAuthorized(auth, a));
  }

  const depts = db
    .select()
    .from(departments)
    .where(eq(departments.workspaceId, auth.workspaceId))
    .all();
  const deptMap = new Map(depts.map((d) => [d.id, d.name]));

  const allModels = db.select().from(providerModels).all();
  const modelMap = new Map(allModels.map((m) => [m.id, m]));
  const allProviders = db
    .select()
    .from(providers)
    .where(eq(providers.workspaceId, auth.workspaceId))
    .all();
  const provMap = new Map(allProviders.map((p) => [p.id, p]));

  res.json(
    rows.map((a) => {
      const mdl = a.modelId ? modelMap.get(a.modelId) : undefined;
      const prov = mdl ? provMap.get(mdl.providerId) : undefined;
      const base = {
        ...a,
        departmentName: deptMap.get(a.departmentId) ?? 'Unknown',
        modelName: mdl?.modelId ?? null,
        providerName: prov?.name ?? null,
      };
      if (auth.role === 'member') {
        return {
          ...base,
          systemPrompt: '',
          contextDocs: '',
          mcpPermissions: { serverIds: [], allowedTools: [], readOnly: true },
        };
      }
      return base;
    }),
  );
});

adminRouter.post(
  '/agents',
  requireRole('global_admin', 'department_admin'),
  (req, res) => {
    const auth = req.auth!;
    const parsed = createAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'validation_error',
          message: parsed.error.issues[0]?.message || 'Invalid agent payload',
        },
      });
      return;
    }

    if (
      auth.role === 'department_admin' &&
      parsed.data.departmentId !== auth.departmentId
    ) {
      res.status(403).json({
        error: {
          code: 'forbidden',
          message: 'Department admins can only create agents in their own department.',
        },
      });
      return;
    }

    const guardrailError = validateDepartmentGuardrails({
      workspaceId: auth.workspaceId,
      departmentId: parsed.data.departmentId,
      modelId: parsed.data.modelId,
      mcpPermissions: parsed.data.mcpPermissions,
    });
    if (guardrailError) {
      res.status(guardrailError.status).json({
        error: { code: guardrailError.code, message: guardrailError.message },
      });
      return;
    }

    const id = makeId('agt');
    const now = new Date().toISOString();

    try {
      db.insert(agents)
        .values({
          id,
          workspaceId: auth.workspaceId,
          departmentId: parsed.data.departmentId,
          slug: parsed.data.slug,
          name: parsed.data.name,
          description: parsed.data.description,
          templateSourceId: null,
          modelId: parsed.data.modelId ?? null,
          systemPrompt: parsed.data.systemPrompt,
          temperature: parsed.data.temperature,
          contextDocs: parsed.data.contextDocs,
          mcpPermissions: parsed.data.mcpPermissions,
          isActive: parsed.data.isActive,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      db.insert(agentRevisions)
        .values({
          id: makeId('rev'),
          agentId: id,
          systemPrompt: parsed.data.systemPrompt,
          contextDocsSnapshot: parsed.data.contextDocs,
          changedByKeyId: auth.keyId,
          changeNote: parsed.data.changeNote,
          createdAt: now,
        })
        .run();
    } catch (err) {
      res.status(409).json({
        error: {
          code: 'duplicate_slug',
          message: err instanceof Error ? err.message : 'Agent slug already exists',
        },
      });
      return;
    }

    const created = db.select().from(agents).where(eq(agents.id, id)).get();
    res.status(201).json(created);
  },
);

adminRouter.patch(
  '/agents/:id',
  requireRole('global_admin', 'department_admin'),
  (req, res) => {
    const auth = req.auth!;
    const existing = db
      .select()
      .from(agents)
      .where(and(eq(agents.id, req.params.id), eq(agents.workspaceId, auth.workspaceId)))
      .get();
    if (!existing) {
      res.status(404).json({ error: { code: 'not_found', message: 'Agent not found' } });
      return;
    }

    if (
      auth.role === 'department_admin' &&
      existing.departmentId !== auth.departmentId
    ) {
      res.status(403).json({
        error: {
          code: 'forbidden',
          message: 'Department admins can only edit agents in their own department.',
        },
      });
      return;
    }

    const parsed = updateAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'validation_error',
          message: parsed.error.issues[0]?.message || 'Invalid agent update',
        },
      });
      return;
    }

    const nextModelId =
      parsed.data.modelId !== undefined ? parsed.data.modelId : existing.modelId;
    const nextMcpPermissions = parsed.data.mcpPermissions ?? existing.mcpPermissions;

    const guardrailError = validateDepartmentGuardrails({
      workspaceId: auth.workspaceId,
      departmentId: existing.departmentId,
      modelId: nextModelId,
      mcpPermissions: nextMcpPermissions,
    });
    if (guardrailError) {
      res.status(guardrailError.status).json({
        error: { code: guardrailError.code, message: guardrailError.message },
      });
      return;
    }

    const now = new Date().toISOString();
    const nextSystemPrompt = parsed.data.systemPrompt ?? existing.systemPrompt;
    const nextContextDocs = parsed.data.contextDocs ?? existing.contextDocs;

    db.update(agents)
      .set({
        name: parsed.data.name ?? existing.name,
        description: parsed.data.description ?? existing.description,
        modelId: nextModelId,
        systemPrompt: nextSystemPrompt,
        temperature: parsed.data.temperature ?? existing.temperature,
        contextDocs: nextContextDocs,
        mcpPermissions: nextMcpPermissions,
        isActive: parsed.data.isActive ?? existing.isActive,
        updatedAt: now,
      })
      .where(eq(agents.id, existing.id))
      .run();

    const promptOrContextChanged =
      nextSystemPrompt !== existing.systemPrompt ||
      nextContextDocs !== existing.contextDocs;

    if (promptOrContextChanged || parsed.data.changeNote) {
      db.insert(agentRevisions)
        .values({
          id: makeId('rev'),
          agentId: existing.id,
          systemPrompt: nextSystemPrompt,
          contextDocsSnapshot: nextContextDocs,
          changedByKeyId: auth.keyId,
          changeNote: parsed.data.changeNote || 'Updated agent instructions',
          createdAt: now,
        })
        .run();
    }

    const updated = db.select().from(agents).where(eq(agents.id, existing.id)).get();
    res.json(updated);
  },
);

adminRouter.delete(
  '/agents/:id',
  requireRole('global_admin', 'department_admin'),
  (req, res) => {
    const auth = req.auth!;
    const existing = db
      .select()
      .from(agents)
      .where(and(eq(agents.id, req.params.id), eq(agents.workspaceId, auth.workspaceId)))
      .get();
    if (!existing) {
      res.status(404).json({ error: { code: 'not_found', message: 'Agent not found' } });
      return;
    }
    if (
      auth.role === 'department_admin' &&
      existing.departmentId !== auth.departmentId
    ) {
      res.status(403).json({
        error: { code: 'forbidden', message: 'Cannot delete another department agent.' },
      });
      return;
    }
    db.delete(agents).where(eq(agents.id, existing.id)).run();
    res.json({ ok: true });
  },
);

adminRouter.get(
  '/agents/:id/revisions',
  requireRole('global_admin', 'department_admin'),
  (req, res) => {
    const auth = req.auth!;
    const existing = db
      .select()
      .from(agents)
      .where(and(eq(agents.id, req.params.id), eq(agents.workspaceId, auth.workspaceId)))
      .get();
    if (!existing) {
      res.status(404).json({ error: { code: 'not_found', message: 'Agent not found' } });
      return;
    }
    if (
      auth.role === 'department_admin' &&
      existing.departmentId !== auth.departmentId
    ) {
      res.status(403).json({
        error: { code: 'forbidden', message: 'Cannot inspect another department agent.' },
      });
      return;
    }

    const revs = db
      .select()
      .from(agentRevisions)
      .where(eq(agentRevisions.agentId, existing.id))
      .orderBy(desc(agentRevisions.createdAt))
      .all();
    const keys = db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.workspaceId, auth.workspaceId))
      .all();
    const keyMap = new Map(keys.map((k) => [k.id, k.userLabel]));

    res.json(
      revs.map((r) => ({
        ...r,
        changedByLabel: r.changedByKeyId ? keyMap.get(r.changedByKeyId) ?? 'Revoked key' : 'System',
      })),
    );
  },
);

adminRouter.post(
  '/agents/:id/revisions/:revId/rollback',
  requireRole('global_admin', 'department_admin'),
  (req, res) => {
    const auth = req.auth!;
    const existing = db
      .select()
      .from(agents)
      .where(and(eq(agents.id, req.params.id), eq(agents.workspaceId, auth.workspaceId)))
      .get();
    if (!existing) {
      res.status(404).json({ error: { code: 'not_found', message: 'Agent not found' } });
      return;
    }
    if (
      auth.role === 'department_admin' &&
      existing.departmentId !== auth.departmentId
    ) {
      res.status(403).json({
        error: { code: 'forbidden', message: 'Cannot roll back another department agent.' },
      });
      return;
    }

    const targetRev = db
      .select()
      .from(agentRevisions)
      .where(
        and(
          eq(agentRevisions.id, req.params.revId),
          eq(agentRevisions.agentId, existing.id),
        ),
      )
      .get();
    if (!targetRev) {
      res.status(404).json({ error: { code: 'not_found', message: 'Revision not found' } });
      return;
    }

    const now = new Date().toISOString();
    db.update(agents)
      .set({
        systemPrompt: targetRev.systemPrompt,
        contextDocs: targetRev.contextDocsSnapshot,
        updatedAt: now,
      })
      .where(eq(agents.id, existing.id))
      .run();

    db.insert(agentRevisions)
      .values({
        id: makeId('rev'),
        agentId: existing.id,
        systemPrompt: targetRev.systemPrompt,
        contextDocsSnapshot: targetRev.contextDocsSnapshot,
        changedByKeyId: auth.keyId,
        changeNote: `Rolled back to revision ${targetRev.id.slice(0, 10)}`,
        createdAt: now,
      })
      .run();

    const updated = db.select().from(agents).where(eq(agents.id, existing.id)).get();
    res.json(updated);
  },
);

// ---------------------------------------------------------------------------
// YAML Templates Catalog, Install, Export & Import
// ---------------------------------------------------------------------------

adminRouter.get('/templates', requireRole('global_admin', 'department_admin'), (_req, res) => {
  res.json(loadDiskTemplates());
});

adminRouter.get('/templates/:id/yaml', requireRole('global_admin', 'department_admin'), (req, res) => {
  const raw = getDiskTemplateRaw(req.params.id);
  if (!raw) {
    res.status(404).json({ error: { code: 'not_found', message: 'Template not found' } });
    return;
  }
  res.json({ yaml: raw });
});

const installTemplateSchema = z.object({
  departmentId: z.string().min(1),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  modelId: z.string().nullable().optional(),
});

adminRouter.post(
  '/templates/:id/install',
  requireRole('global_admin', 'department_admin'),
  (req, res) => {
    const auth = req.auth!;
    const templates = loadDiskTemplates();
    const tpl = templates.find(
      (t) => t.id === req.params.id || t.slug === req.params.id,
    );
    if (!tpl) {
      res.status(404).json({ error: { code: 'not_found', message: 'Template not found' } });
      return;
    }

    const parsed = installTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'validation_error',
          message: parsed.error.issues[0]?.message || 'Invalid install payload',
        },
      });
      return;
    }

    if (
      auth.role === 'department_admin' &&
      parsed.data.departmentId !== auth.departmentId
    ) {
      res.status(403).json({
        error: {
          code: 'forbidden',
          message: 'Department admins can only install templates into their own department.',
        },
      });
      return;
    }

    const guardrailError = validateDepartmentGuardrails({
      workspaceId: auth.workspaceId,
      departmentId: parsed.data.departmentId,
      modelId: parsed.data.modelId,
    });
    if (guardrailError) {
      res.status(guardrailError.status).json({
        error: { code: guardrailError.code, message: guardrailError.message },
      });
      return;
    }

    const targetSlug = parsed.data.slug || tpl.slug;
    const id = makeId('agt');
    const now = new Date().toISOString();

    try {
      db.insert(agents)
        .values({
          id,
          workspaceId: auth.workspaceId,
          departmentId: parsed.data.departmentId,
          slug: targetSlug,
          name: tpl.name,
          description: tpl.description,
          templateSourceId: tpl.id,
          modelId: parsed.data.modelId ?? null,
          systemPrompt: tpl.system_prompt.trim(),
          temperature: tpl.temperature,
          contextDocs: tpl.context_docs.trim(),
          mcpPermissions: {
            serverIds: tpl.mcp_permissions.server_ids ?? [],
            allowedTools: tpl.mcp_permissions.allowed_tools ?? [],
            readOnly: tpl.mcp_permissions.read_only ?? true,
          },
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      db.insert(agentRevisions)
        .values({
          id: makeId('rev'),
          agentId: id,
          systemPrompt: tpl.system_prompt.trim(),
          contextDocsSnapshot: tpl.context_docs.trim(),
          changedByKeyId: auth.keyId,
          changeNote: `Installed from template "${tpl.id}" (v${tpl.version})`,
          createdAt: now,
        })
        .run();
    } catch (err) {
      res.status(409).json({
        error: {
          code: 'duplicate_slug',
          message:
            err instanceof Error
              ? err.message
              : `Agent slug "${targetSlug}" already exists`,
        },
      });
      return;
    }

    const created = db.select().from(agents).where(eq(agents.id, id)).get();
    res.status(201).json(created);
  },
);

adminRouter.get(
  '/agents/:id/export-yaml',
  requireRole('global_admin', 'department_admin'),
  (req, res) => {
    const auth = req.auth!;
    const agent = db
      .select()
      .from(agents)
      .where(and(eq(agents.id, req.params.id), eq(agents.workspaceId, auth.workspaceId)))
      .get();
    if (!agent) {
      res.status(404).json({ error: { code: 'not_found', message: 'Agent not found' } });
      return;
    }
    if (
      auth.role === 'department_admin' &&
      agent.departmentId !== auth.departmentId
    ) {
      res.status(403).json({
        error: { code: 'forbidden', message: 'Cannot export another department agent.' },
      });
      return;
    }

    const yamlText = serializeAgentToYaml(agent);
    res.json({ slug: agent.slug, yaml: yamlText });
  },
);

const importYamlSchema = z.object({
  departmentId: z.string().min(1),
  yamlContent: z.string().min(10),
  modelId: z.string().nullable().optional(),
});

adminRouter.post(
  '/agents/import-yaml',
  requireRole('global_admin', 'department_admin'),
  (req, res) => {
    const auth = req.auth!;
    const parsed = importYamlSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: 'validation_error', message: 'Invalid import payload' },
      });
      return;
    }

    if (
      auth.role === 'department_admin' &&
      parsed.data.departmentId !== auth.departmentId
    ) {
      res.status(403).json({
        error: {
          code: 'forbidden',
          message: 'Department admins can only import agents into their own department.',
        },
      });
      return;
    }

    let tpl;
    try {
      tpl = parseAndValidateAgentYaml(parsed.data.yamlContent);
    } catch (err) {
      res.status(400).json({
        error: {
          code: 'yaml_validation_error',
          message:
            err instanceof Error ? err.message : 'YAML failed Zod template schema',
        },
      });
      return;
    }

    const mcpPermissions: McpPermissions = {
      serverIds: tpl.mcp_permissions.server_ids ?? [],
      allowedTools: tpl.mcp_permissions.allowed_tools ?? [],
      readOnly: tpl.mcp_permissions.read_only ?? true,
    };

    const guardrailError = validateDepartmentGuardrails({
      workspaceId: auth.workspaceId,
      departmentId: parsed.data.departmentId,
      modelId: parsed.data.modelId,
      mcpPermissions,
    });
    if (guardrailError) {
      res.status(guardrailError.status).json({
        error: { code: guardrailError.code, message: guardrailError.message },
      });
      return;
    }

    const id = makeId('agt');
    const now = new Date().toISOString();

    try {
      db.insert(agents)
        .values({
          id,
          workspaceId: auth.workspaceId,
          departmentId: parsed.data.departmentId,
          slug: tpl.slug,
          name: tpl.name,
          description: tpl.description,
          templateSourceId: tpl.id,
          modelId: parsed.data.modelId ?? null,
          systemPrompt: tpl.system_prompt.trim(),
          temperature: tpl.temperature,
          contextDocs: tpl.context_docs.trim(),
          mcpPermissions,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      db.insert(agentRevisions)
        .values({
          id: makeId('rev'),
          agentId: id,
          systemPrompt: tpl.system_prompt.trim(),
          contextDocsSnapshot: tpl.context_docs.trim(),
          changedByKeyId: auth.keyId,
          changeNote: `Imported from YAML (${tpl.id})`,
          createdAt: now,
        })
        .run();
    } catch (err) {
      res.status(409).json({
        error: {
          code: 'duplicate_slug',
          message: err instanceof Error ? err.message : 'Agent slug already exists',
        },
      });
      return;
    }

    const created = db.select().from(agents).where(eq(agents.id, id)).get();
    res.status(201).json(created);
  },
);

// ---------------------------------------------------------------------------
// Usage Logs, Cost Analytics & Spending Alerts
// ---------------------------------------------------------------------------

adminRouter.get('/usage', (req, res) => {
  const auth = req.auth!;
  const days = Number(req.query.days ?? 30);
  const cutoff =
    Number.isFinite(days) && days > 0
      ? new Date(Date.now() - days * 86_400_000).toISOString()
      : '1970-01-01T00:00:00.000Z';

  const conditions = [
    eq(usageLogs.workspaceId, auth.workspaceId),
    gte(usageLogs.createdAt, cutoff),
  ];

  if (auth.role === 'department_admin') {
    if (!auth.departmentId) {
      res.json({
        summary: {
          totalCalculatedCostUsd: 0,
          totalRequests: 0,
          successfulRequests: 0,
          failedRequests: 0,
          unavailableUsageRequests: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          byDepartment: [],
          byAgent: [],
          byProvider: [],
          byModel: [],
          byUser: [],
        },
        logs: [],
        alerts: [],
      });
      return;
    }
    conditions.push(eq(usageLogs.departmentId, auth.departmentId));
  } else if (auth.role === 'member') {
    conditions.push(eq(usageLogs.apiKeyId, auth.keyId));
  }

  const allWindowLogs = db
    .select()
    .from(usageLogs)
    .where(and(...conditions))
    .orderBy(desc(usageLogs.createdAt))
    .all();

  const logs = allWindowLogs.slice(0, 200);

  const depts = db
    .select()
    .from(departments)
    .where(eq(departments.workspaceId, auth.workspaceId))
    .all();
  const deptMap = new Map(depts.map((d) => [d.id, d]));

  const allAgents = db
    .select()
    .from(agents)
    .where(eq(agents.workspaceId, auth.workspaceId))
    .all();
  const agentMap = new Map(allAgents.map((a) => [a.id, a]));

  let totalCostAcc = 0;
  let hasAnyReportedCost = false;
  let totalInputAcc = 0;
  let hasAnyReportedInput = false;
  let totalOutputAcc = 0;
  let hasAnyReportedOutput = false;

  let successfulRequests = 0;
  let failedRequests = 0;
  let unavailableUsageRequests = 0;

  const deptAgg = new Map<
    string,
    {
      departmentId: string;
      departmentName: string;
      costAcc: number;
      hasCost: boolean;
      requests: number;
      thresholdUsd: number;
      unavailableUsageRequests: number;
    }
  >();
  const agentAgg = new Map<
    string,
    {
      agentId: string;
      agentSlug: string;
      agentName: string;
      costAcc: number;
      hasCost: boolean;
      requests: number;
      tokensAcc: number;
      hasTokens: boolean;
      unavailableUsageRequests: number;
    }
  >();
  const providerAgg = new Map<
    string,
    {
      providerType: string;
      costAcc: number;
      hasCost: boolean;
      requests: number;
      inputAcc: number;
      hasInput: boolean;
      outputAcc: number;
      hasOutput: boolean;
      unavailableUsageRequests: number;
    }
  >();
  const modelAgg = new Map<
    string,
    {
      providerType: string;
      modelUsed: string;
      costAcc: number;
      hasCost: boolean;
      requests: number;
      inputAcc: number;
      hasInput: boolean;
      outputAcc: number;
      hasOutput: boolean;
      unavailableUsageRequests: number;
    }
  >();
  const userAgg = new Map<
    string,
    {
      userLabel: string;
      costAcc: number;
      hasCost: boolean;
      requests: number;
      tokensAcc: number;
      hasTokens: boolean;
      unavailableUsageRequests: number;
    }
  >();

  for (const log of allWindowLogs) {
    const hasInput = typeof log.inputTokens === 'number';
    const hasOutput = typeof log.outputTokens === 'number';
    const hasTokens = hasInput && hasOutput;
    const hasCost = typeof log.actualCostUsd === 'number';

    if (hasCost) {
      totalCostAcc += log.actualCostUsd!;
      hasAnyReportedCost = true;
    }
    if (hasInput) {
      totalInputAcc += log.inputTokens!;
      hasAnyReportedInput = true;
    }
    if (hasOutput) {
      totalOutputAcc += log.outputTokens!;
      hasAnyReportedOutput = true;
    }
    if (!hasTokens) {
      unavailableUsageRequests++;
    }
    if (log.status === 'success') successfulRequests++;
    else failedRequests++;

    if (log.departmentId) {
      const dept = deptMap.get(log.departmentId);
      const cur = deptAgg.get(log.departmentId) ?? {
        departmentId: log.departmentId,
        departmentName: dept?.name ?? 'Unknown',
        costAcc: 0,
        hasCost: false,
        requests: 0,
        thresholdUsd: dept?.monthlyAlertThresholdUsd ?? 0,
        unavailableUsageRequests: 0,
      };
      if (hasCost) {
        cur.costAcc += log.actualCostUsd!;
        cur.hasCost = true;
      }
      if (!hasTokens) cur.unavailableUsageRequests += 1;
      cur.requests += 1;
      deptAgg.set(log.departmentId, cur);
    }

    if (log.agentId) {
      const ag = agentMap.get(log.agentId);
      const cur = agentAgg.get(log.agentId) ?? {
        agentId: log.agentId,
        agentSlug: ag?.slug ?? 'deleted',
        agentName: ag?.name ?? 'Deleted Agent',
        costAcc: 0,
        hasCost: false,
        requests: 0,
        tokensAcc: 0,
        hasTokens: false,
        unavailableUsageRequests: 0,
      };
      if (hasCost) {
        cur.costAcc += log.actualCostUsd!;
        cur.hasCost = true;
      }
      if (hasTokens) {
        cur.tokensAcc += log.inputTokens! + log.outputTokens!;
        cur.hasTokens = true;
      } else {
        cur.unavailableUsageRequests += 1;
      }
      cur.requests += 1;
      agentAgg.set(log.agentId, cur);
    }

    const curProvider = providerAgg.get(log.providerType) ?? {
      providerType: log.providerType,
      costAcc: 0,
      hasCost: false,
      requests: 0,
      inputAcc: 0,
      hasInput: false,
      outputAcc: 0,
      hasOutput: false,
      unavailableUsageRequests: 0,
    };
    if (hasCost) {
      curProvider.costAcc += log.actualCostUsd!;
      curProvider.hasCost = true;
    }
    if (hasInput) {
      curProvider.inputAcc += log.inputTokens!;
      curProvider.hasInput = true;
    }
    if (hasOutput) {
      curProvider.outputAcc += log.outputTokens!;
      curProvider.hasOutput = true;
    }
    if (!hasTokens) curProvider.unavailableUsageRequests += 1;
    curProvider.requests += 1;
    providerAgg.set(log.providerType, curProvider);

    const modelKey = `${log.providerType}:${log.modelUsed}`;
    const curModel = modelAgg.get(modelKey) ?? {
      providerType: log.providerType,
      modelUsed: log.modelUsed,
      costAcc: 0,
      hasCost: false,
      requests: 0,
      inputAcc: 0,
      hasInput: false,
      outputAcc: 0,
      hasOutput: false,
      unavailableUsageRequests: 0,
    };
    if (hasCost) {
      curModel.costAcc += log.actualCostUsd!;
      curModel.hasCost = true;
    }
    if (hasInput) {
      curModel.inputAcc += log.inputTokens!;
      curModel.hasInput = true;
    }
    if (hasOutput) {
      curModel.outputAcc += log.outputTokens!;
      curModel.hasOutput = true;
    }
    if (!hasTokens) curModel.unavailableUsageRequests += 1;
    curModel.requests += 1;
    modelAgg.set(modelKey, curModel);

    const curUser = userAgg.get(log.userLabel) ?? {
      userLabel: log.userLabel,
      costAcc: 0,
      hasCost: false,
      requests: 0,
      tokensAcc: 0,
      hasTokens: false,
      unavailableUsageRequests: 0,
    };
    if (hasCost) {
      curUser.costAcc += log.actualCostUsd!;
      curUser.hasCost = true;
    }
    if (hasTokens) {
      curUser.tokensAcc += log.inputTokens! + log.outputTokens!;
      curUser.hasTokens = true;
    } else {
      curUser.unavailableUsageRequests += 1;
    }
    curUser.requests += 1;
    userAgg.set(log.userLabel, curUser);
  }

  const sortByCostDesc = <T extends { calculatedCostUsd: number | null; requests: number }>(
    items: T[],
  ): T[] =>
    items.sort(
      (a, b) =>
        (b.calculatedCostUsd ?? -1) - (a.calculatedCostUsd ?? -1) ||
        b.requests - a.requests,
    );

  const summary: UsageSummaryDto = {
    totalCalculatedCostUsd:
      allWindowLogs.length === 0
        ? 0
        : hasAnyReportedCost
          ? Number(totalCostAcc.toFixed(6))
          : null,
    totalRequests: allWindowLogs.length,
    successfulRequests,
    failedRequests,
    unavailableUsageRequests,
    totalInputTokens:
      allWindowLogs.length === 0 ? 0 : hasAnyReportedInput ? totalInputAcc : null,
    totalOutputTokens:
      allWindowLogs.length === 0 ? 0 : hasAnyReportedOutput ? totalOutputAcc : null,
    byDepartment: sortByCostDesc(
      Array.from(deptAgg.values()).map((d) => ({
        departmentId: d.departmentId,
        departmentName: d.departmentName,
        calculatedCostUsd: d.hasCost ? Number(d.costAcc.toFixed(6)) : null,
        requests: d.requests,
        thresholdUsd: d.thresholdUsd,
        unavailableUsageRequests: d.unavailableUsageRequests,
      })),
    ),
    byAgent: sortByCostDesc(
      Array.from(agentAgg.values()).map((a) => ({
        agentId: a.agentId,
        agentSlug: a.agentSlug,
        agentName: a.agentName,
        calculatedCostUsd: a.hasCost ? Number(a.costAcc.toFixed(6)) : null,
        requests: a.requests,
        tokens: a.hasTokens ? a.tokensAcc : null,
        unavailableUsageRequests: a.unavailableUsageRequests,
      })),
    ),
    byProvider: sortByCostDesc(
      Array.from(providerAgg.values()).map((p) => ({
        providerType: p.providerType,
        calculatedCostUsd: p.hasCost ? Number(p.costAcc.toFixed(6)) : null,
        requests: p.requests,
        inputTokens: p.hasInput ? p.inputAcc : null,
        outputTokens: p.hasOutput ? p.outputAcc : null,
        unavailableUsageRequests: p.unavailableUsageRequests,
      })),
    ),
    byModel: sortByCostDesc(
      Array.from(modelAgg.values()).map((m) => ({
        providerType: m.providerType,
        modelUsed: m.modelUsed,
        calculatedCostUsd: m.hasCost ? Number(m.costAcc.toFixed(6)) : null,
        requests: m.requests,
        inputTokens: m.hasInput ? m.inputAcc : null,
        outputTokens: m.hasOutput ? m.outputAcc : null,
        unavailableUsageRequests: m.unavailableUsageRequests,
      })),
    ),
    byUser: sortByCostDesc(
      Array.from(userAgg.values()).map((u) => ({
        userLabel: u.userLabel,
        calculatedCostUsd: u.hasCost ? Number(u.costAcc.toFixed(6)) : null,
        requests: u.requests,
        tokens: u.hasTokens ? u.tokensAcc : null,
        unavailableUsageRequests: u.unavailableUsageRequests,
      })),
    ),
  };

  let alertRows: Array<typeof spendingAlerts.$inferSelect> = [];
  if (auth.role === 'global_admin') {
    alertRows = db
      .select()
      .from(spendingAlerts)
      .where(eq(spendingAlerts.workspaceId, auth.workspaceId))
      .orderBy(desc(spendingAlerts.triggeredAt))
      .all();
  } else if (auth.role === 'department_admin' && auth.departmentId) {
    alertRows = db
      .select()
      .from(spendingAlerts)
      .where(
        and(
          eq(spendingAlerts.workspaceId, auth.workspaceId),
          eq(spendingAlerts.departmentId, auth.departmentId),
        ),
      )
      .orderBy(desc(spendingAlerts.triggeredAt))
      .all();
  }

  res.json({
    summary,
    logs: logs.map((l) => ({
      id: l.id,
      workspaceId: l.workspaceId,
      departmentId: l.departmentId,
      departmentName: l.departmentId ? deptMap.get(l.departmentId)?.name ?? null : null,
      agentId: l.agentId,
      agentSlug: l.agentId ? agentMap.get(l.agentId)?.slug ?? null : null,
      agentName: l.agentId ? agentMap.get(l.agentId)?.name ?? null : null,
      apiKeyId: l.apiKeyId,
      userLabel: l.userLabel,
      providerType: l.providerType,
      modelUsed: l.modelUsed,
      status: l.status,
      errorCode: l.errorCode,
      errorMessage: l.errorMessage,
      inputTokens: l.inputTokens,
      outputTokens: l.outputTokens,
      calculatedCostUsd: l.actualCostUsd,
      usageAvailable: l.inputTokens !== null && l.outputTokens !== null,
      latencyMs: l.latencyMs,
      createdAt: l.createdAt,
    })),
    alerts: alertRows.map((a) => ({
      id: a.id,
      workspaceId: a.workspaceId,
      departmentId: a.departmentId,
      departmentName: deptMap.get(a.departmentId)?.name ?? 'Department',
      periodMonth: a.periodMonth,
      thresholdUsd: a.thresholdUsd,
      calculatedSpentUsd: a.actualSpentUsd,
      triggeredAt: a.triggeredAt,
      acknowledged: a.acknowledged,
    })),
  });
});

adminRouter.post(
  '/alerts/:id/acknowledge',
  requireRole('global_admin', 'department_admin'),
  (req, res) => {
    const auth = req.auth!;
    const existing = db
      .select()
      .from(spendingAlerts)
      .where(
        and(
          eq(spendingAlerts.id, req.params.id),
          eq(spendingAlerts.workspaceId, auth.workspaceId),
        ),
      )
      .get();
    if (!existing) {
      res.status(404).json({ error: { code: 'not_found', message: 'Alert not found' } });
      return;
    }
    if (
      auth.role === 'department_admin' &&
      existing.departmentId !== auth.departmentId
    ) {
      res.status(403).json({ error: { code: 'forbidden', message: 'Forbidden' } });
      return;
    }

    db.update(spendingAlerts)
      .set({ acknowledged: true })
      .where(eq(spendingAlerts.id, existing.id))
      .run();
    res.json({ ok: true });
  },
);
