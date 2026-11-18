import path from 'node:path';
import Database from 'better-sqlite3';
import { count } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { getDataDir, getMasterKey, hashApiKey, makeId } from '../utils/crypto.ts';
import * as schema from './schema.ts';

export const DEFAULT_WORKSPACE_ID = 'ws_default';

const dataDir = getDataDir();
const dbPath = path.join(dataDir, 'nawah.db');

export const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 5000');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

export function initializeDatabase(): void {
  // Ensure master key is initialized & persisted inside NAWAH_DATA_DIR
  getMasterKey();

  const migrationsFolder = path.resolve(process.cwd(), 'drizzle');
  migrate(db, { migrationsFolder });

  const now = new Date().toISOString();

  // Only initialize the single default workspace (zero fake departments, agents, providers, or usage logs)
  db.insert(schema.workspaces)
    .values({
      id: DEFAULT_WORKSPACE_ID,
      name: 'Default Workspace',
      slug: 'default',
      createdAt: now,
    })
    .onConflictDoNothing()
    .run();

  // Optional headless bootstrap admin key from environment if database has zero keys
  const bootstrapKey = process.env.NAWAH_BOOTSTRAP_ADMIN_KEY?.trim();
  if (bootstrapKey) {
    const [{ total }] = db
      .select({ total: count() })
      .from(schema.apiKeys)
      .all();

    if (total === 0) {
      const label =
        process.env.NAWAH_BOOTSTRAP_ADMIN_LABEL?.trim() || 'Platform Admin';
      const keyPrefix =
        bootstrapKey.length > 16
          ? `${bootstrapKey.slice(0, 12)}...${bootstrapKey.slice(-4)}`
          : `${bootstrapKey.slice(0, 4)}...`;

      db.insert(schema.apiKeys)
        .values({
          id: makeId('key'),
          workspaceId: DEFAULT_WORKSPACE_ID,
          departmentId: null,
          userLabel: label,
          keyPrefix,
          keyHash: hashApiKey(bootstrapKey),
          role: 'global_admin',
          allowedAgentIds: [],
          isActive: true,
          createdAt: now,
          lastUsedAt: null,
        })
        .run();
    }
  }
}
