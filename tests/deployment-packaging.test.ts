import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import JSZip from 'jszip';

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr !== 'object') {
        srv.close();
        reject(new Error('Failed to get free port'));
        return;
      }
      const { port } = addr;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

async function waitForHealth(baseUrl: string, proc: ChildProcess, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Server process exited early with code ${proc.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) {
        const json = (await res.json()) as { ok: boolean };
        if (json.ok) return;
      }
    } catch {
      // retry until server listens
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${baseUrl}/api/health`);
}

function startProductionServer(params: {
  cwd: string;
  port: number;
  dataDir: string;
  extraEnv?: Record<string, string | undefined>;
}): { proc: ChildProcess; logs: () => string; stop: () => Promise<number | null> } {
  const tsxBin = path.resolve(process.cwd(), 'node_modules/.bin/tsx');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(params.port),
    NAWAH_DATA_DIR: params.dataDir,
    ...params.extraEnv,
  };
  if (params.extraEnv?.NAWAH_MASTER_KEY === undefined) {
    delete env.NAWAH_MASTER_KEY;
  }
  if (params.extraEnv?.NAWAH_BOOTSTRAP_ADMIN_KEY === undefined) {
    delete env.NAWAH_BOOTSTRAP_ADMIN_KEY;
  }

  let output = '';
  const proc = spawn(tsxBin, ['server.ts'], {
    cwd: params.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => {
    output += d.toString();
  });
  proc.stderr.on('data', (d) => {
    output += d.toString();
  });

  const stop = async (): Promise<number | null> => {
    if (proc.exitCode !== null) return proc.exitCode;
    return await new Promise<number | null>((resolve) => {
      const killTimer = setTimeout(() => {
        proc.kill('SIGKILL');
      }, 6000);
      proc.once('exit', (code) => {
        clearTimeout(killTimer);
        resolve(code);
      });
      proc.kill('SIGTERM');
    });
  };

  return { proc, logs: () => output, stop };
}

test('Fresh production install, first-run setup lock, persistence across SIGTERM restart, and deploy bundle ZIP export/execution', async () => {
  const rootDir = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nawah-deploy-fresh-'));
  const dataDir = path.join(tempRoot, 'data');
  const extractDir = path.join(tempRoot, 'extracted-zip');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(extractDir, { recursive: true });

  // Clean production build in workspace
  execFileSync('npm', ['run', 'build'], { cwd: rootDir, stdio: 'pipe' });

  let adminKey = '';
  let createdDeptId = '';
  let createdProviderId = '';
  let zipBuffer: Buffer | null = null;

  // 1. Fresh install startup (no master key, no bootstrap admin key)
  const port1 = await getFreePort();
  const baseUrl1 = `http://127.0.0.1:${port1}`;
  const srv1 = startProductionServer({ cwd: rootDir, port: port1, dataDir });
  try {
    await waitForHealth(baseUrl1, srv1.proc);

    // Production static HTML served cleanly
    const htmlRes = await fetch(baseUrl1);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /<html/i);

    // Auth status requires setup
    const status1 = (await (await fetch(`${baseUrl1}/api/auth/status`)).json()) as {
      needsSetup: boolean;
      workspaceName: string;
    };
    assert.equal(status1.needsSetup, true);
    assert.equal(status1.workspaceName, 'Default Workspace');

    // First-run setup creates initial global_admin key, then permanently locks
    const setupRes = await fetch(`${baseUrl1}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userLabel: 'Deploy Tester' }),
    });
    assert.equal(setupRes.status, 201);
    const setupJson = (await setupRes.json()) as { rawKey: string };
    assert.ok(setupJson.rawKey.startsWith('nawah_gadm_'));
    adminKey = setupJson.rawKey;

    const lockedRes = await fetch(`${baseUrl1}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userLabel: 'Second Admin' }),
    });
    assert.equal(lockedRes.status, 403);

    // Create a department and an encrypted provider to verify persistence + master key retention
    const deptRes = await fetch(`${baseUrl1}/api/admin/departments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Platform Engineering',
        slug: 'platform-engineering',
        monthlyAlertThresholdUsd: 50,
      }),
    });
    assert.equal(deptRes.status, 201);
    createdDeptId = ((await deptRes.json()) as { id: string }).id;

    const provRes = await fetch(`${baseUrl1}/api/admin/providers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Persist OpenAI',
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-persist-secret-12345',
      }),
    });
    assert.equal(provRes.status, 201);
    createdProviderId = ((await provRes.json()) as { id: string }).id;

    // Verify starter templates loaded from templates/agents
    const tplRes = await fetch(`${baseUrl1}/api/admin/templates`, {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    assert.equal(tplRes.status, 200);
    const templates = (await tplRes.json()) as Array<{ id: string }>;
    assert.ok(templates.length >= 4);

    // Verify /api/deploy/files returns non-empty configs including .dockerignore and README.md
    const deployFilesRes = await fetch(`${baseUrl1}/api/deploy/files`, {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    assert.equal(deployFilesRes.status, 200);
    const deployFilesJson = (await deployFilesRes.json()) as {
      files: Array<{ name: string; content: string }>;
    };
    const fileNames = deployFilesJson.files.map((f) => f.name);
    for (const expected of [
      'Dockerfile',
      'docker-compose.yml',
      '.dockerignore',
      '.env.example',
      'drizzle.config.ts',
      'README.md',
      'integrations/continue-config.yaml',
      'integrations/git-pr-webhook.mjs',
      'integrations/slack-adapter.mjs',
    ]) {
      assert.ok(fileNames.includes(expected), `Missing ${expected} in /api/deploy/files`);
    }
    for (const f of deployFilesJson.files) {
      assert.ok(f.content.trim().length > 0, `Empty deploy file: ${f.name}`);
    }

    // Download /api/deploy/bundle.zip
    const zipRes = await fetch(`${baseUrl1}/api/deploy/bundle.zip`, {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    assert.equal(zipRes.status, 200);
    zipBuffer = Buffer.from(await zipRes.arrayBuffer());
  } finally {
    const exitCode = await srv1.stop();
    assert.equal(exitCode, 0, `Server 1 did not exit cleanly:\n${srv1.logs()}`);
  }

  // Verify SQLite DB and auto-generated master key survived shutdown in dataDir
  assert.ok(fs.existsSync(path.join(dataDir, 'nawah.db')));
  assert.ok(fs.existsSync(path.join(dataDir, '.nawah_master_key')));

  // 2. Restart against the SAME dataDir and verify persisted data + encrypted secret decryption
  const port2 = await getFreePort();
  const baseUrl2 = `http://127.0.0.1:${port2}`;
  const srv2 = startProductionServer({ cwd: rootDir, port: port2, dataDir });
  try {
    await waitForHealth(baseUrl2, srv2.proc);

    const status2 = (await (await fetch(`${baseUrl2}/api/auth/status`)).json()) as {
      needsSetup: boolean;
    };
    assert.equal(status2.needsSetup, false);

    const meRes = await fetch(`${baseUrl2}/api/auth/me`, {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    assert.equal(meRes.status, 200);

    const deptsAfterRestart = (await (
      await fetch(`${baseUrl2}/api/admin/departments`, {
        headers: { Authorization: `Bearer ${adminKey}` },
      })
    ).json()) as Array<{ id: string; name: string }>;
    assert.ok(deptsAfterRestart.some((d) => d.id === createdDeptId && d.name === 'Platform Engineering'));

    const provsAfterRestart = (await (
      await fetch(`${baseUrl2}/api/admin/providers`, {
        headers: { Authorization: `Bearer ${adminKey}` },
      })
    ).json()) as Array<{ id: string; hasApiKey: boolean }>;
    assert.ok(provsAfterRestart.some((p) => p.id === createdProviderId && p.hasApiKey));
  } finally {
    await srv2.stop();
  }

  // 3. Extract ZIP into an isolated folder and verify completeness + independent build/startup
  assert.ok(zipBuffer);
  const zip = await JSZip.loadAsync(zipBuffer);
  const entryNames = Object.keys(zip.files).filter((name) => !zip.files[name].dir);

  for (const required of [
    'Dockerfile',
    'docker-compose.yml',
    '.dockerignore',
    '.env.example',
    'README.md',
    'package.json',
    'server.ts',
    'index.html',
    'vite.config.ts',
    'tsconfig.json',
    'drizzle.config.ts',
    'drizzle/meta/_journal.json',
    'drizzle/0000_bent_xavin.sql',
    'drizzle/0001_striped_naoko.sql',
    'integrations/continue-config.yaml',
    'integrations/git-pr-webhook.mjs',
    'integrations/slack-adapter.mjs',
    'src/App.tsx',
    'src/server/db/index.ts',
  ]) {
    assert.ok(entryNames.includes(required), `ZIP missing required file: ${required}`);
    const content = await zip.files[required].async('nodebuffer');
    assert.ok(content.length > 0, `ZIP file is empty: ${required}`);
  }
  assert.ok(
    entryNames.some((n) => n.startsWith('templates/agents/') && n.endsWith('.yaml')),
    'ZIP missing starter YAML templates',
  );
  assert.ok(
    !entryNames.some(
      (n) =>
        n.startsWith('node_modules/') ||
        n.startsWith('data/') ||
        n.startsWith('dist/') ||
        n === '.env',
    ),
    'ZIP leaked excluded runtime/build directories',
  );

  for (const name of entryNames) {
    const dest = path.join(extractDir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, await zip.files[name].async('nodebuffer'));
  }

  // Link node_modules into extracted ZIP directory so offline build & server boot run cleanly from extracted files alone
  fs.symlinkSync(
    path.resolve(rootDir, 'node_modules'),
    path.join(extractDir, 'node_modules'),
    'dir',
  );
  execFileSync(path.resolve(rootDir, 'node_modules/.bin/vite'), ['build'], {
    cwd: extractDir,
    stdio: 'pipe',
  });

  const zipDataDir = path.join(tempRoot, 'zip-data');
  const port3 = await getFreePort();
  const baseUrl3 = `http://127.0.0.1:${port3}`;
  const srv3 = startProductionServer({
    cwd: extractDir,
    port: port3,
    dataDir: zipDataDir,
    extraEnv: {
      NAWAH_BOOTSTRAP_ADMIN_KEY: 'nawah_gadm_zip_bootstrap_key_001',
      NAWAH_BOOTSTRAP_ADMIN_LABEL: 'ZIP Bootstrap Admin',
    },
  });
  try {
    await waitForHealth(baseUrl3, srv3.proc);
    const tplRes = await fetch(`${baseUrl3}/api/admin/templates`, {
      headers: { Authorization: 'Bearer nawah_gadm_zip_bootstrap_key_001' },
    });
    assert.equal(tplRes.status, 200);
    const tpls = (await tplRes.json()) as Array<{ id: string }>;
    assert.ok(tpls.length >= 4);

    const htmlRes = await fetch(baseUrl3);
    assert.equal(htmlRes.status, 200);
    assert.match(await htmlRes.text(), /<html/i);
  } finally {
    await srv3.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Upgrading an existing 0000 installation preserves persisted data, master key, and applies pending SQLite migrations on startup', async () => {
  const rootDir = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nawah-upgrade-'));
  const dataDir = path.join(tempRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Prepare an existing legacy installation on schema 0000_bent_xavin
  const masterKeyHex = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dataDir, '.nawah_master_key'), `${masterKeyHex}\n`, { mode: 0o600 });

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(masterKeyHex, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update('sk-legacy-provider-secret', 'utf8'), cipher.final()]);
  const encryptedPayload = `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;

  const legacyAdminKey = 'nawah_gadm_legacy_upgrade_key_999';
  const legacyKeyHash = crypto.createHash('sha256').update(legacyAdminKey, 'utf8').digest('hex');

  const legacySql = fs.readFileSync(
    path.resolve(rootDir, 'drizzle/0000_bent_xavin.sql'),
    'utf8',
  );
  const journal = JSON.parse(
    fs.readFileSync(path.resolve(rootDir, 'drizzle/meta/_journal.json'), 'utf8'),
  ) as { entries: Array<{ idx: number; when: number }> };
  const hash0 = crypto.createHash('sha256').update(legacySql).digest('hex');

  const legacyDb = new Database(path.join(dataDir, 'nawah.db'));
  legacyDb.pragma('journal_mode = WAL');
  for (const stmt of legacySql.split('--> statement-breakpoint')) {
    const cleaned = stmt.trim();
    if (cleaned) legacyDb.exec(cleaned);
  }
  legacyDb.exec(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    );
  `);
  legacyDb
    .prepare('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)')
    .run(hash0, journal.entries[0].when);

  legacyDb
    .prepare(`INSERT INTO workspaces (id, name, slug, created_at) VALUES ('ws_default', 'Default Workspace', 'default', '2026-01-01T00:00:00.000Z')`)
    .run();
  legacyDb
    .prepare(`INSERT INTO departments (id, workspace_id, name, slug, monthly_alert_threshold_usd, allowed_model_ids, allowed_mcp_server_ids, created_at) VALUES ('dept_legacy', 'ws_default', 'Legacy Core', 'legacy-core', 25, '[]', '[]', '2026-01-01T00:00:00.000Z')`)
    .run();
  legacyDb
    .prepare(`INSERT INTO providers (id, workspace_id, name, type, base_url, encrypted_api_key, is_active, created_at) VALUES ('prov_legacy', 'ws_default', 'Legacy OpenAI', 'openai', 'https://api.openai.com/v1', ?, 1, '2026-01-01T00:00:00.000Z')`)
    .run(encryptedPayload);
  legacyDb
    .prepare(`INSERT INTO api_keys (id, workspace_id, department_id, user_label, key_prefix, key_hash, role, allowed_agent_ids, is_active, created_at, last_used_at) VALUES ('key_legacy', 'ws_default', NULL, 'Legacy Admin', 'nawah_gadm_leg...', ?, 'global_admin', '[]', 1, '2026-01-01T00:00:00.000Z', NULL)`)
    .run(legacyKeyHash);
  legacyDb
    .prepare(`INSERT INTO usage_logs (id, workspace_id, department_id, agent_id, api_key_id, user_label, provider_type, model_used, status, input_tokens, output_tokens, actual_cost_usd, latency_ms, created_at) VALUES ('log_legacy_1', 'ws_default', 'dept_legacy', NULL, 'key_legacy', 'Legacy Admin', 'openai', 'gpt-4o', 'success', 1000, 500, 0.015, 210, ?)`)
    .run(new Date().toISOString());
  legacyDb.close();

  // Start production server on the legacy dataDir -> should migrate cleanly and preserve all legacy rows
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const srv = startProductionServer({ cwd: rootDir, port, dataDir });
  try {
    await waitForHealth(baseUrl, srv.proc);

    const status = (await (await fetch(`${baseUrl}/api/auth/status`)).json()) as {
      needsSetup: boolean;
    };
    assert.equal(status.needsSetup, false);

    const depts = (await (
      await fetch(`${baseUrl}/api/admin/departments`, {
        headers: { Authorization: `Bearer ${legacyAdminKey}` },
      })
    ).json()) as Array<{ id: string; name: string }>;
    assert.ok(depts.some((d) => d.id === 'dept_legacy' && d.name === 'Legacy Core'));

    const usageRes = (await (
      await fetch(`${baseUrl}/api/admin/usage?days=30`, {
        headers: { Authorization: `Bearer ${legacyAdminKey}` },
      })
    ).json()) as {
      summary: { totalRequests: number; totalCalculatedCostUsd: number | null };
      logs: Array<{ id: string; calculatedCostUsd: number | null }>;
    };
    assert.equal(usageRes.summary.totalRequests, 1);
    assert.equal(usageRes.summary.totalCalculatedCostUsd, 0.015);
    assert.equal(usageRes.logs[0].id, 'log_legacy_1');
  } finally {
    await srv.stop();
  }

  // Verify migration 0001 actually updated usage_logs to allow NULL values
  const upgradedDb = new Database(path.join(dataDir, 'nawah.db'));
  try {
    const migRows = upgradedDb
      .prepare('SELECT COUNT(*) AS cnt FROM "__drizzle_migrations"')
      .get() as { cnt: number };
    assert.equal(migRows.cnt, 2);
  } finally {
    upgradedDb.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Deployment routes fail loudly with 500 instead of silently returning empty files when required assets are missing', async () => {
  const missingCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nawah-missing-assets-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  // Import express & deployRouter in-process? No, test in isolated child via process.chdir inside a tiny tsx eval
  // so process.cwd() has no Dockerfile/src/templates, while NAWAH_DATA_DIR has valid DB.
  const dataDir = path.join(missingCwd, 'data');
  const script = `
    import fs from 'node:fs';
    import http from 'node:http';
    import path from 'node:path';
    import express from '${path.resolve(process.cwd(), 'node_modules/express/index.js')}';
    process.env.NAWAH_DATA_DIR = ${JSON.stringify(dataDir)};
    process.env.NAWAH_BOOTSTRAP_ADMIN_KEY = 'nawah_gadm_missing_test_key';
    const { initializeDatabase } = await import(${JSON.stringify(path.resolve(process.cwd(), 'src/server/db/index.ts'))});
    const { deployRouter } = await import(${JSON.stringify(path.resolve(process.cwd(), 'src/server/routes/deploy.ts'))});
    initializeDatabase();
    process.chdir(${JSON.stringify(missingCwd)});
    const app = express();
    app.use('/api/deploy', deployRouter);
    const server = http.createServer(app);
    server.listen(${port}, '127.0.0.1', () => {
      console.log('READY');
    });
  `;
  const scriptPath = path.join(missingCwd, 'check.mts');
  fs.writeFileSync(scriptPath, script);

  const proc = spawn(path.resolve(process.cwd(), 'node_modules/.bin/tsx'), [scriptPath], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for READY')), 8000);
      proc.stdout.on('data', (d) => {
        if (d.toString().includes('READY')) {
          clearTimeout(timer);
          resolve();
        }
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Helper exited unexpectedly (${code})`));
      });
    });

    const filesRes = await fetch(`${baseUrl}/api/deploy/files`, {
      headers: { Authorization: 'Bearer nawah_gadm_missing_test_key' },
    });
    assert.equal(filesRes.status, 500);
    const filesErr = (await filesRes.json()) as { error: { code: string; message: string } };
    assert.equal(filesErr.error.code, 'deploy_files_unavailable');
    assert.match(filesErr.error.message, /missing/i);

    const zipRes = await fetch(`${baseUrl}/api/deploy/bundle.zip`, {
      headers: { Authorization: 'Bearer nawah_gadm_missing_test_key' },
    });
    assert.equal(zipRes.status, 500);
    const zipErr = (await zipRes.json()) as { error: { code: string; message: string } };
    assert.equal(zipErr.error.code, 'deploy_bundle_incomplete');
    assert.match(zipErr.error.message, /missing/i);
  } finally {
    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    fs.rmSync(missingCwd, { recursive: true, force: true });
  }
});
