import { Router } from 'express';
import { count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DEFAULT_WORKSPACE_ID, db, sqlite } from '../db/index.ts';
import { apiKeys, departments, workspaces } from '../db/schema.ts';
import { requireAuth } from '../middleware/auth.ts';
import { generateApiKey, makeId } from '../utils/crypto.ts';

export const authRouter = Router();

const setupSchema = z.object({
  userLabel: z
    .string()
    .trim()
    .min(2, 'Admin label must be at least 2 characters')
    .max(120),
});

authRouter.get('/status', (_req, res) => {
  const [{ total }] = db.select({ total: count() }).from(apiKeys).all();
  const ws = db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID))
    .get();

  res.json({
    needsSetup: total === 0,
    workspaceName: ws?.name || 'Default Workspace',
  });
});

authRouter.post('/setup', (req, res) => {
  const parsed = setupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: parsed.error.issues[0]?.message || 'Invalid setup payload',
      },
    });
    return;
  }

  const now = new Date().toISOString();
  const generated = generateApiKey('global_admin');
  const keyId = makeId('key');

  // Atomic transaction ensures first-run setup locks permanently after the first key is created
  const createFirstKeyTx = sqlite.transaction(() => {
    const row = sqlite
      .prepare('SELECT COUNT(*) AS cnt FROM api_keys')
      .get() as { cnt: number };

    if (row.cnt > 0) {
      return null;
    }

    sqlite
      .prepare(
        `INSERT INTO api_keys (
          id, workspace_id, department_id, user_label, key_prefix, key_hash, role, allowed_agent_ids, is_active, created_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        keyId,
        DEFAULT_WORKSPACE_ID,
        null,
        parsed.data.userLabel,
        generated.keyPrefix,
        generated.keyHash,
        'global_admin',
        '[]',
        1,
        now,
        null,
      );

    return {
      id: keyId,
      workspaceId: DEFAULT_WORKSPACE_ID,
      departmentId: null,
      userLabel: parsed.data.userLabel,
      keyPrefix: generated.keyPrefix,
      role: 'global_admin' as const,
      allowedAgentIds: [] as string[],
      isActive: true,
      createdAt: now,
      lastUsedAt: null,
    };
  });

  const created = createFirstKeyTx();
  if (!created) {
    res.status(403).json({
      error: {
        code: 'setup_locked',
        message:
          'First-run setup is permanently locked because an access key already exists.',
      },
    });
    return;
  }

  res.status(201).json({
    rawKey: generated.rawKey,
    key: created,
  });
});

authRouter.get('/me', requireAuth, (req, res) => {
  const auth = req.auth!;
  const dept = auth.departmentId
    ? db
        .select()
        .from(departments)
        .where(eq(departments.id, auth.departmentId))
        .get()
    : null;
  const ws = db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, auth.workspaceId))
    .get();

  res.json({
    ...auth,
    departmentName: dept?.name ?? null,
    workspaceName: ws?.name ?? 'Default Workspace',
  });
});
