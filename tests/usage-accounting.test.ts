import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

const require = createRequire(import.meta.url);
const express = require(
  path.resolve(process.cwd(), 'node_modules/express/index.js'),
) as typeof import('express');

type CapturedRequest = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

async function startMockServer(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string,
  ) => void | Promise<void>,
): Promise<{
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method || 'GET',
        url: req.url || '/',
        headers: req.headers,
        body,
      });
      try {
        await handler(req, res, body);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end(
          JSON.stringify({
            error: { message: err instanceof Error ? err.message : 'mock error' },
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

let tempDir = '';
let gatewayBaseUrl = '';
let gatewayServer: http.Server | null = null;
const adminToken = 'nawah_task3_admin_key_12345';

let dbMod: typeof import('../src/server/db/index.ts');
let schemaMod: typeof import('../src/server/db/schema.ts');
let cryptoMod: typeof import('../src/server/utils/crypto.ts');
let usageLoggerMod: typeof import('../src/server/engine/usage-logger.ts');

function createDepartmentFixture(params: {
  name: string;
  slug: string;
  monthlyAlertThresholdUsd?: number;
}): string {
  const deptId = cryptoMod.makeId('dept');
  dbMod.db
    .insert(schemaMod.departments)
    .values({
      id: deptId,
      workspaceId: dbMod.DEFAULT_WORKSPACE_ID,
      name: params.name,
      slug: params.slug,
      monthlyAlertThresholdUsd: params.monthlyAlertThresholdUsd ?? 0,
      allowedModelIds: [],
      allowedMcpServerIds: [],
      createdAt: new Date().toISOString(),
    })
    .run();
  return deptId;
}

function createAgentFixture(params: {
  departmentId: string;
  slug: string;
  providerType: 'openai' | 'anthropic' | 'google' | 'ollama' | 'openai_compatible';
  baseUrl: string | null;
  apiKey: string | null;
  modelId: string;
  inputCostPer1mUsd: number;
  outputCostPer1mUsd: number;
}): {
  agentId: string;
  modelRowId: string;
  agentModelParam: string;
} {
  const now = new Date().toISOString();
  const providerId = cryptoMod.makeId('prov');
  const modelRowId = cryptoMod.makeId('mod');
  const agentId = cryptoMod.makeId('agt');

  dbMod.db
    .insert(schemaMod.providers)
    .values({
      id: providerId,
      workspaceId: dbMod.DEFAULT_WORKSPACE_ID,
      name: `Provider ${params.slug}`,
      type: params.providerType,
      baseUrl: params.baseUrl,
      encryptedApiKey: params.apiKey ? cryptoMod.encryptSecret(params.apiKey) : null,
      isActive: true,
      createdAt: now,
    })
    .run();

  dbMod.db
    .insert(schemaMod.providerModels)
    .values({
      id: modelRowId,
      providerId,
      modelId: params.modelId,
      inputCostPer1mUsd: params.inputCostPer1mUsd,
      outputCostPer1mUsd: params.outputCostPer1mUsd,
      supportsVision: false,
      isActive: true,
      createdAt: now,
    })
    .run();

  dbMod.db
    .insert(schemaMod.agents)
    .values({
      id: agentId,
      workspaceId: dbMod.DEFAULT_WORKSPACE_ID,
      departmentId: params.departmentId,
      slug: params.slug,
      name: `Agent ${params.slug}`,
      description: 'Task 3 test agent',
      systemPrompt: 'Base system prompt',
      contextDocs: '',
      modelId: modelRowId,
      temperature: 0.2,
      mcpPermissions: { serverIds: [], allowedTools: [], readOnly: true },
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return {
    agentId,
    modelRowId,
    agentModelParam: `agent/${params.slug}`,
  };
}

function createApiKeyFixture(params: {
  role: 'global_admin' | 'department_admin' | 'member';
  userLabel: string;
  departmentId: string | null;
  allowedAgentIds?: string[];
}): { keyId: string; token: string } {
  const keyId = cryptoMod.makeId('key');
  const token = `nawah_test_${cryptoMod.makeId('tok')}`;
  dbMod.db
    .insert(schemaMod.apiKeys)
    .values({
      id: keyId,
      workspaceId: dbMod.DEFAULT_WORKSPACE_ID,
      departmentId: params.departmentId,
      userLabel: params.userLabel,
      keyPrefix: `${token.slice(0, 12)}...`,
      keyHash: cryptoMod.hashApiKey(token),
      role: params.role,
      allowedAgentIds: params.allowedAgentIds ?? [],
      isActive: true,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    })
    .run();
  return { keyId, token };
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nawah-task3-'));
  process.env.NAWAH_DATA_DIR = tempDir;
  process.env.NAWAH_BOOTSTRAP_ADMIN_KEY = adminToken;

  dbMod = await import('../src/server/db/index.ts');
  schemaMod = await import('../src/server/db/schema.ts');
  cryptoMod = await import('../src/server/utils/crypto.ts');
  usageLoggerMod = await import('../src/server/engine/usage-logger.ts');
  const { openAiRouter } = await import('../src/server/routes/v1-openai.ts');
  const { adminRouter } = await import('../src/server/routes/admin.ts');
  const { webhooksRouter } = await import('../src/server/routes/webhooks.ts');

  dbMod.initializeDatabase();

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/v1', openAiRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/webhooks', webhooksRouter);

  gatewayServer = http.createServer(app);
  await new Promise<void>((resolve) =>
    gatewayServer!.listen(0, '127.0.0.1', resolve),
  );
  const addr = gatewayServer.address();
  assert.ok(addr && typeof addr === 'object');
  gatewayBaseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (gatewayServer) {
    await new Promise<void>((resolve) => {
      gatewayServer!.closeAllConnections?.();
      gatewayServer!.close(() => resolve());
    });
  }
  dbMod?.sqlite.close();
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Provider usage extraction, calculated cost math, zero preservation, and missing-usage null semantics across all 4 providers', async () => {
  let openAiOmitUsage = false;
  let openAiZeroTokens = false;

  const openAiMock = await startMockServer((_req, res, body) => {
    const reqJson = JSON.parse(body) as { stream?: boolean };
    if (openAiOmitUsage) {
      if (!reqJson.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              { message: { role: 'assistant', content: 'No usage field' }, finish_reason: 'stop' },
            ],
          }),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"No usage stream"},"finish_reason":"stop"}]}\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }

    if (openAiZeroTokens) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0 },
        }),
      );
      return;
    }

    if (!reqJson.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'OpenAI reply' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
        }),
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Streamed"},"finish_reason":null}]}\n\n');
    res.write(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2000,"completion_tokens":1000}}\n\n',
    );
    res.end('data: [DONE]\n\n');
  });

  let anthropicOmitUsage = false;
  const anthropicMock = await startMockServer((_req, res, body) => {
    const reqJson = JSON.parse(body) as { stream?: boolean };
    if (!reqJson.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_a',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Anthropic reply' }],
          stop_reason: 'end_turn',
          ...(anthropicOmitUsage ? {} : { usage: { input_tokens: 400, output_tokens: 200 } }),
        }),
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: anthropicOmitUsage ? {} : { usage: { input_tokens: 500, output_tokens: 10 } },
      })}\n\n`,
    );
    res.write(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude ok"}}\n\n',
    );
    res.write(
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        ...(anthropicOmitUsage ? {} : { usage: { output_tokens: 250 } }),
      })}\n\n`,
    );
    res.end('event: message_stop\ndata: {"type":"message_stop"}');
  });

  let googleOmitUsage = false;
  const googleMock = await startMockServer((req, res) => {
    if (req.url?.includes(':streamGenerateContent')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'Gemini stream' }] }, finishReason: 'STOP' }],
          ...(googleOmitUsage ? {} : { usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 300 } }),
        })}\n\n`,
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'Gemini ok' }] }, finishReason: 'STOP' }],
        ...(googleOmitUsage ? {} : { usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 150 } }),
      }),
    );
  });

  const ollamaMock = await startMockServer((_req, res, body) => {
    const reqJson = JSON.parse(body) as { stream?: boolean; stream_options?: unknown };
    if (!reqJson.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Ollama reply' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 80 },
        }),
      );
      return;
    }

    // Simulate older Ollama rejecting stream_options with 400 and then omitting usage on retry
    if ('stream_options' in reqJson) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unsupported stream_options' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Local OK"},"finish_reason":"stop"}]}\n\n');
    res.end('data: [DONE]\n\n');
  });

  try {
    const engDeptId = createDepartmentFixture({
      name: 'Engineering Accounting',
      slug: 'eng-accounting',
      monthlyAlertThresholdUsd: 0.01,
    });
    const localDeptId = createDepartmentFixture({
      name: 'Local Models',
      slug: 'local-models',
      monthlyAlertThresholdUsd: 1,
    });

    const openaiAgent = createAgentFixture({
      departmentId: engDeptId,
      slug: 'acct-openai',
      providerType: 'openai',
      baseUrl: `${openAiMock.baseUrl}/v1`,
      apiKey: 'sk-oai',
      modelId: 'gpt-4o',
      inputCostPer1mUsd: 2.5,
      outputCostPer1mUsd: 10,
    });
    const anthropicAgent = createAgentFixture({
      departmentId: engDeptId,
      slug: 'acct-anthropic',
      providerType: 'anthropic',
      baseUrl: `${anthropicMock.baseUrl}/v1`,
      apiKey: 'sk-ant',
      modelId: 'claude-3-7-sonnet',
      inputCostPer1mUsd: 3,
      outputCostPer1mUsd: 15,
    });
    const googleAgent = createAgentFixture({
      departmentId: engDeptId,
      slug: 'acct-google',
      providerType: 'google',
      baseUrl: googleMock.baseUrl,
      apiKey: 'AIzaTest',
      modelId: 'gemini-2.5-flash',
      inputCostPer1mUsd: 0.5,
      outputCostPer1mUsd: 2,
    });
    const ollamaAgent = createAgentFixture({
      departmentId: localDeptId,
      slug: 'acct-ollama',
      providerType: 'ollama',
      baseUrl: `${ollamaMock.baseUrl}/v1`,
      apiKey: null,
      modelId: 'llama3.2',
      inputCostPer1mUsd: 0,
      outputCostPer1mUsd: 0,
    });

    const memberEng = createApiKeyFixture({
      role: 'member',
      userLabel: 'alice@eng',
      departmentId: engDeptId,
    });
    const memberLocal = createApiKeyFixture({
      role: 'member',
      userLabel: 'bob@local',
      departmentId: localDeptId,
    });

    // 1. OpenAI non-streaming with trace: 1000 in @ $2.5/1M + 500 out @ $10/1M = 0.0025 + 0.005 = 0.0075
    const oaiRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${memberEng.token}`,
        'Content-Type': 'application/json',
        'x-nawah-trace': '1',
      },
      body: JSON.stringify({
        model: openaiAgent.agentModelParam,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(oaiRes.status, 200);
    const oaiJson = (await oaiRes.json()) as {
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      nawah: {
        calculated_cost_usd: number;
        cost_basis: string;
        usage_available: boolean;
      };
    };
    assert.equal(oaiJson.usage.prompt_tokens, 1000);
    assert.equal(oaiJson.usage.completion_tokens, 500);
    assert.equal(oaiJson.nawah.calculated_cost_usd, 0.0075);
    assert.equal(oaiJson.nawah.cost_basis, 'configured_model_pricing');
    assert.equal(oaiJson.nawah.usage_available, true);

    // 2. OpenAI streaming with trace: 2000 in + 1000 out = 0.005 + 0.01 = 0.015 (crosses 0.01 threshold)
    const oaiStreamRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${memberEng.token}`,
        'Content-Type': 'application/json',
        'x-nawah-trace': '1',
      },
      body: JSON.stringify({
        model: openaiAgent.agentModelParam,
        stream: true,
        messages: [{ role: 'user', content: 'stream hi' }],
      }),
    });
    assert.equal(oaiStreamRes.status, 200);
    const oaiSse = await oaiStreamRes.text();
    assert.match(oaiSse, /"calculated_cost_usd":0\.015/);
    assert.match(oaiSse, /"cost_basis":"configured_model_pricing"/);
    assert.match(oaiSse, /"usage_available":true/);

    // Verify alert was created with calculatedSpentUsd in DB
    const alertsAfterOai = dbMod.db
      .select()
      .from(schemaMod.spendingAlerts)
      .where(eq(schemaMod.spendingAlerts.departmentId, engDeptId))
      .all();
    assert.equal(alertsAfterOai.length, 1);
    assert.equal(alertsAfterOai[0].actualSpentUsd, 0.0225);

    // 3. OpenAI genuine zero tokens (0, 0) -> preserved as 0 and $0 cost (NOT null)
    openAiZeroTokens = true;
    const oaiZeroRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${memberEng.token}`,
        'Content-Type': 'application/json',
        'x-nawah-trace': '1',
      },
      body: JSON.stringify({
        model: openaiAgent.agentModelParam,
        messages: [{ role: 'user', content: 'zero' }],
      }),
    });
    assert.equal(oaiZeroRes.status, 200);
    const oaiZeroJson = (await oaiZeroRes.json()) as {
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      nawah: { calculated_cost_usd: number | null; usage_available: boolean };
    };
    assert.equal(oaiZeroJson.usage.prompt_tokens, 0);
    assert.equal(oaiZeroJson.usage.completion_tokens, 0);
    assert.equal(oaiZeroJson.nawah.calculated_cost_usd, 0);
    assert.equal(oaiZeroJson.nawah.usage_available, true);
    openAiZeroTokens = false;

    // 4. OpenAI omitted usage (both non-stream & stream) -> recorded as null / usage: null / usage_available: false
    openAiOmitUsage = true;
    const oaiMissingRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${memberEng.token}`,
        'Content-Type': 'application/json',
        'x-nawah-trace': '1',
      },
      body: JSON.stringify({
        model: openaiAgent.agentModelParam,
        messages: [{ role: 'user', content: 'missing usage' }],
      }),
    });
    assert.equal(oaiMissingRes.status, 200);
    const oaiMissingJson = (await oaiMissingRes.json()) as {
      usage: unknown;
      nawah: { calculated_cost_usd: number | null; usage_available: boolean };
    };
    assert.equal(oaiMissingJson.usage, null);
    assert.equal(oaiMissingJson.nawah.calculated_cost_usd, null);
    assert.equal(oaiMissingJson.nawah.usage_available, false);
    openAiOmitUsage = false;

    // 5. Anthropic non-stream (400/200) & stream (500/250) & omitted usage
    const antRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${memberEng.token}`,
        'Content-Type': 'application/json',
        'x-nawah-trace': '1',
      },
      body: JSON.stringify({
        model: anthropicAgent.agentModelParam,
        messages: [{ role: 'user', content: 'claude' }],
      }),
    });
    assert.equal(antRes.status, 200);
    const antJson = (await antRes.json()) as {
      usage: { prompt_tokens: number; completion_tokens: number };
      nawah: { calculated_cost_usd: number };
    };
    assert.equal(antJson.usage.prompt_tokens, 400);
    assert.equal(antJson.usage.completion_tokens, 200);
    // (400 * 3 + 200 * 15) / 1e6 = 4200 / 1e6 = 0.0042
    assert.equal(antJson.nawah.calculated_cost_usd, 0.0042);

    const antStreamRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${memberEng.token}`,
        'Content-Type': 'application/json',
        'x-nawah-trace': '1',
      },
      body: JSON.stringify({
        model: anthropicAgent.agentModelParam,
        stream: true,
        messages: [{ role: 'user', content: 'claude stream' }],
      }),
    });
    assert.equal(antStreamRes.status, 200);
    const antSse = await antStreamRes.text();
    // (500 * 3 + 250 * 15) / 1e6 = 5250 / 1e6 = 0.00525
    assert.match(antSse, /"input_tokens":500,"output_tokens":250/);
    assert.match(antSse, /"calculated_cost_usd":0\.00525/);

    anthropicOmitUsage = true;
    const antMissingRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${memberEng.token}`,
        'Content-Type': 'application/json',
        'x-nawah-trace': '1',
      },
      body: JSON.stringify({
        model: anthropicAgent.agentModelParam,
        stream: true,
        messages: [{ role: 'user', content: 'claude no usage' }],
      }),
    });
    assert.equal(antMissingRes.status, 200);
    const antMissingSse = await antMissingRes.text();
    assert.match(antMissingSse, /"usage":null/);
    assert.match(antMissingSse, /"calculated_cost_usd":null,"cost_basis":"configured_model_pricing","usage_available":false/);
    anthropicOmitUsage = false;

    // 6. Google non-stream (300/150) & stream (600/300) & omitted usage
    const gooRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${memberEng.token}`,
        'Content-Type': 'application/json',
        'x-nawah-trace': '1',
      },
      body: JSON.stringify({
        model: googleAgent.agentModelParam,
        messages: [{ role: 'user', content: 'gemini' }],
      }),
    });
    assert.equal(gooRes.status, 200);
    const gooJson = (await gooRes.json()) as {
      usage: { prompt_tokens: number; completion_tokens: number };
      nawah: { calculated_cost_usd: number };
    };
    assert.equal(gooJson.usage.prompt_tokens, 300);
    assert.equal(gooJson.usage.completion_tokens, 150);
    // (300 * 0.5 + 150 * 2) / 1e6 = 450 / 1e6 = 0.00045
    assert.equal(gooJson.nawah.calculated_cost_usd, 0.00045);

    const gooStreamRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${memberEng.token}`,
        'Content-Type': 'application/json',
        'x-nawah-trace': '1',
      },
      body: JSON.stringify({
        model: googleAgent.agentModelParam,
        stream: true,
        messages: [{ role: 'user', content: 'gemini stream' }],
      }),
    });
    assert.equal(gooStreamRes.status, 200);
    const gooSse = await gooStreamRes.text();
    // (600 * 0.5 + 300 * 2) / 1e6 = 900 / 1e6 = 0.0009
    assert.match(gooSse, /"input_tokens":600,"output_tokens":300/);
    assert.match(gooSse, /"calculated_cost_usd":0\.0009/);

    googleOmitUsage = true;
    const gooMissingRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${memberEng.token}`,
        'Content-Type': 'application/json',
        'x-nawah-trace': '1',
      },
      body: JSON.stringify({
        model: googleAgent.agentModelParam,
        messages: [{ role: 'user', content: 'gemini no usage' }],
      }),
    });
    assert.equal(gooMissingRes.status, 200);
    const gooMissingJson = (await gooMissingRes.json()) as {
      usage: unknown;
      nawah: { calculated_cost_usd: number | null; usage_available: boolean };
    };
    assert.equal(gooMissingJson.usage, null);
    assert.equal(gooMissingJson.nawah.calculated_cost_usd, null);
    assert.equal(gooMissingJson.nawah.usage_available, false);
    googleOmitUsage = false;

    // 7. Ollama non-stream ($0 rate -> 0 cost, NOT null) & stream_options 400 retry (single log, null usage)
    const beforeOllamaCount = dbMod.db
      .select()
      .from(schemaMod.usageLogs)
      .where(eq(schemaMod.usageLogs.agentId, ollamaAgent.agentId))
      .all().length;

    const olNonStream = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${memberLocal.token}`,
        'Content-Type': 'application/json',
        'x-nawah-trace': '1',
      },
      body: JSON.stringify({
        model: ollamaAgent.agentModelParam,
        messages: [{ role: 'user', content: 'ollama' }],
      }),
    });
    assert.equal(olNonStream.status, 200);
    const olJson = (await olNonStream.json()) as {
      usage: { prompt_tokens: number; completion_tokens: number };
      nawah: { calculated_cost_usd: number; usage_available: boolean };
    };
    assert.equal(olJson.usage.prompt_tokens, 120);
    assert.equal(olJson.usage.completion_tokens, 80);
    assert.equal(olJson.nawah.calculated_cost_usd, 0);
    assert.equal(olJson.nawah.usage_available, true);

    const olStream = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${memberLocal.token}`,
        'Content-Type': 'application/json',
        'x-nawah-trace': '1',
      },
      body: JSON.stringify({
        model: ollamaAgent.agentModelParam,
        stream: true,
        messages: [{ role: 'user', content: 'ollama retry' }],
      }),
    });
    assert.equal(olStream.status, 200);
    const olSse = await olStream.text();
    assert.match(olSse, /Local OK/);
    assert.match(olSse, /"calculated_cost_usd":null,"cost_basis":"configured_model_pricing","usage_available":false/);

    // Verify retry produced ONLY 1 additional log row (total 2 for Ollama agent), and second row has null tokens/cost
    const ollamaLogs = dbMod.db
      .select()
      .from(schemaMod.usageLogs)
      .where(eq(schemaMod.usageLogs.agentId, ollamaAgent.agentId))
      .orderBy(desc(schemaMod.usageLogs.createdAt))
      .all();
    assert.equal(ollamaLogs.length, beforeOllamaCount + 2);
    const retryLog = ollamaLogs.find((l) => l.inputTokens === null);
    assert.ok(retryLog);
    assert.equal(retryLog.status, 'success');
    assert.equal(retryLog.outputTokens, null);
    assert.equal(retryLog.actualCostUsd, null);
    assert.equal(retryLog.apiKeyId, memberLocal.keyId);
    assert.equal(retryLog.userLabel, 'bob@local');
    assert.equal(retryLog.departmentId, localDeptId);
    assert.equal(retryLog.providerType, 'ollama');
    assert.equal(retryLog.modelUsed, 'llama3.2');

    // 8. Webhook response format check (Slack adapter)
    const slackRes = await fetch(`${gatewayBaseUrl}/api/webhooks/slack`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${memberEng.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agentSlug: 'acct-openai',
        text: 'hello slack',
      }),
    });
    assert.equal(slackRes.status, 200);
    const slackJson = (await slackRes.json()) as {
      ok: boolean;
      usage: {
        inputTokens: number;
        outputTokens: number;
        calculatedCostUsd: number;
        costBasis: string;
      };
    };
    assert.equal(slackJson.ok, true);
    assert.equal(slackJson.usage.inputTokens, 1000);
    assert.equal(slackJson.usage.outputTokens, 500);
    assert.equal(slackJson.usage.calculatedCostUsd, 0.0075);
    assert.equal(slackJson.usage.costBasis, 'configured_model_pricing');
  } finally {
    await openAiMock.close();
    await anthropicMock.close();
    await googleMock.close();
    await ollamaMock.close();
  }
});

test('Failures, stream error events, timeouts, and client aborts produce exactly 1 failed record with null tokens/cost', async () => {
  const mock = await startMockServer((req, res) => {
    if (req.url === '/bad-key/chat/completions') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Bad API key' } }));
      return;
    }
    if (req.url === '/anthropic-err/messages') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":50,"output_tokens":5}}}\n\n',
      );
      res.end(
        'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Stream exploded"}}\n\n',
      );
      return;
    }
    if (req.url === '/timeout/chat/completions') {
      const timer = setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        }
      }, 2000);
      req.on('close', () => clearTimeout(timer));
      return;
    }
    if (req.url === '/abort/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Partial"},"finish_reason":null}]}\n\n');
      return;
    }
    res.writeHead(500);
    res.end('{}');
  });

  try {
    const deptId = createDepartmentFixture({
      name: 'Failure Accounting Dept',
      slug: 'failure-acct',
      monthlyAlertThresholdUsd: 0.0001,
    });
    const member = createApiKeyFixture({
      role: 'member',
      userLabel: 'carol@fail',
      departmentId: deptId,
    });

    const badKeyAgent = createAgentFixture({
      departmentId: deptId,
      slug: 'fail-401',
      providerType: 'openai',
      baseUrl: `${mock.baseUrl}/bad-key`,
      apiKey: 'sk-bad',
      modelId: 'gpt-4o',
      inputCostPer1mUsd: 10,
      outputCostPer1mUsd: 30,
    });
    const antErrAgent = createAgentFixture({
      departmentId: deptId,
      slug: 'fail-ant-stream',
      providerType: 'anthropic',
      baseUrl: `${mock.baseUrl}/anthropic-err`,
      apiKey: 'sk-ant',
      modelId: 'claude-3-7-sonnet',
      inputCostPer1mUsd: 10,
      outputCostPer1mUsd: 30,
    });
    const timeoutAgent = createAgentFixture({
      departmentId: deptId,
      slug: 'fail-timeout',
      providerType: 'openai',
      baseUrl: `${mock.baseUrl}/timeout`,
      apiKey: 'sk-ok',
      modelId: 'gpt-4o',
      inputCostPer1mUsd: 10,
      outputCostPer1mUsd: 30,
    });
    const abortAgent = createAgentFixture({
      departmentId: deptId,
      slug: 'fail-abort',
      providerType: 'openai',
      baseUrl: `${mock.baseUrl}/abort`,
      apiKey: 'sk-ok',
      modelId: 'gpt-4o',
      inputCostPer1mUsd: 10,
      outputCostPer1mUsd: 30,
    });

    // 1. Upstream 401
    const r401 = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${member.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: badKeyAgent.agentModelParam, messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(r401.status, 502);

    // 2. Anthropic mid-stream error (even though message_start reported 50 tokens before error)
    const rAntErr = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${member.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: antErrAgent.agentModelParam,
        stream: true,
        messages: [{ role: 'user', content: 'x' }],
      }),
    });
    assert.equal(rAntErr.status, 200);
    await rAntErr.text();

    // 3. Timeout
    const prevTimeout = process.env.NAWAH_PROVIDER_TIMEOUT_MS;
    process.env.NAWAH_PROVIDER_TIMEOUT_MS = '120';
    try {
      const rTimeout = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${member.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: timeoutAgent.agentModelParam, messages: [{ role: 'user', content: 'x' }] }),
      });
      assert.equal(rTimeout.status, 504);
    } finally {
      if (prevTimeout === undefined) delete process.env.NAWAH_PROVIDER_TIMEOUT_MS;
      else process.env.NAWAH_PROVIDER_TIMEOUT_MS = prevTimeout;
    }

    // 4. Client SSE abort mid-stream
    const ac = new AbortController();
    const rAbort = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${member.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: abortAgent.agentModelParam,
        stream: true,
        messages: [{ role: 'user', content: 'x' }],
      }),
      signal: ac.signal,
    });
    assert.equal(rAbort.status, 200);
    const reader = rAbort.body!.getReader();
    await reader.read();
    ac.abort();
    await reader.cancel().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 120));

    // Verify exactly 4 failed logs exist for this department, all with null tokens and null calculated cost
    const deptLogs = dbMod.db
      .select()
      .from(schemaMod.usageLogs)
      .where(eq(schemaMod.usageLogs.departmentId, deptId))
      .all();

    assert.equal(deptLogs.length, 4);
    for (const row of deptLogs) {
      assert.equal(row.status, 'failed');
      assert.equal(row.inputTokens, null);
      assert.equal(row.outputTokens, null);
      assert.equal(row.actualCostUsd, null);
      assert.equal(row.apiKeyId, member.keyId);
      assert.equal(row.userLabel, 'carol@fail');
    }

    // Failed logs must never trigger spending alerts even with low threshold
    const deptAlerts = dbMod.db
      .select()
      .from(schemaMod.spendingAlerts)
      .where(eq(schemaMod.spendingAlerts.departmentId, deptId))
      .all();
    assert.equal(deptAlerts.length, 0);
  } finally {
    await mock.close();
  }
});

test('GET /api/admin/usage aggregates >200 rows accurately, distinguishes null vs 0, exposes byProvider/byModel/byUser/byDepartment/byAgent, and enforces role scoping', async () => {
  const deptA = createDepartmentFixture({ name: 'Scale Dept A', slug: 'scale-a', monthlyAlertThresholdUsd: 5 });
  const deptB = createDepartmentFixture({ name: 'Scale Dept B', slug: 'scale-b', monthlyAlertThresholdUsd: 10 });

  const agentA = createAgentFixture({
    departmentId: deptA,
    slug: 'scale-agent-a',
    providerType: 'openai',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'sk-1',
    modelId: 'gpt-4o',
    inputCostPer1mUsd: 10,
    outputCostPer1mUsd: 20,
  });
  const agentB = createAgentFixture({
    departmentId: deptB,
    slug: 'scale-agent-b',
    providerType: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: null,
    modelId: 'llama3.2',
    inputCostPer1mUsd: 0,
    outputCostPer1mUsd: 0,
  });

  const deptAdminA = createApiKeyFixture({
    role: 'department_admin',
    userLabel: 'lead-a@corp',
    departmentId: deptA,
  });
  const memberA1 = createApiKeyFixture({
    role: 'member',
    userLabel: 'user-a1@corp',
    departmentId: deptA,
  });
  const memberB1 = createApiKeyFixture({
    role: 'member',
    userLabel: 'user-b1@corp',
    departmentId: deptB,
  });

  // Insert 205 priced logs into deptA (each 1000 in @ $10/1M + 500 out @ $20/1M = $0.02 each -> 205 * 0.02 = $4.10)
  // Plus 5 zero-cost logs into deptB ($0.00 each) + 2 unavailable logs into deptB (null)
  for (let i = 0; i < 205; i++) {
    usageLoggerMod.recordUsageAndCheckAlerts({
      workspaceId: dbMod.DEFAULT_WORKSPACE_ID,
      departmentId: deptA,
      agentId: agentA.agentId,
      apiKeyId: memberA1.keyId,
      userLabel: 'user-a1@corp',
      providerType: 'openai',
      modelUsed: 'gpt-4o',
      status: 'success',
      inputTokens: 1000,
      outputTokens: 500,
      inputCostPer1mUsd: 10,
      outputCostPer1mUsd: 20,
      latencyMs: 12,
    });
  }
  for (let i = 0; i < 5; i++) {
    usageLoggerMod.recordUsageAndCheckAlerts({
      workspaceId: dbMod.DEFAULT_WORKSPACE_ID,
      departmentId: deptB,
      agentId: agentB.agentId,
      apiKeyId: memberB1.keyId,
      userLabel: 'user-b1@corp',
      providerType: 'ollama',
      modelUsed: 'llama3.2',
      status: 'success',
      inputTokens: 100,
      outputTokens: 50,
      inputCostPer1mUsd: 0,
      outputCostPer1mUsd: 0,
      latencyMs: 8,
    });
  }
  for (let i = 0; i < 2; i++) {
    usageLoggerMod.recordUsageAndCheckAlerts({
      workspaceId: dbMod.DEFAULT_WORKSPACE_ID,
      departmentId: deptB,
      agentId: agentB.agentId,
      apiKeyId: memberB1.keyId,
      userLabel: 'user-b1@corp',
      providerType: 'ollama',
      modelUsed: 'llama3.2',
      status: 'failed',
      errorCode: 'upstream_provider_error',
      errorMessage: 'Down',
      inputTokens: null,
      outputTokens: null,
      inputCostPer1mUsd: 0,
      outputCostPer1mUsd: 0,
      latencyMs: 5,
    });
  }

  // Dept Admin A check: must aggregate all 205 deptA rows even though ledger caps logs at 200
  const deptAdminRes = await fetch(`${gatewayBaseUrl}/api/admin/usage?days=30`, {
    headers: { Authorization: `Bearer ${deptAdminA.token}` },
  });
  assert.equal(deptAdminRes.status, 200);
  const deptAdminData = (await deptAdminRes.json()) as {
    summary: {
      totalCalculatedCostUsd: number | null;
      totalRequests: number;
      successfulRequests: number;
      failedRequests: number;
      unavailableUsageRequests: number;
      totalInputTokens: number | null;
      totalOutputTokens: number | null;
      byDepartment: Array<{ departmentId: string; requests: number; calculatedCostUsd: number | null }>;
      byAgent: Array<{ agentId: string; requests: number; tokens: number | null; calculatedCostUsd: number | null }>;
      byProvider: Array<{ providerType: string; requests: number; calculatedCostUsd: number | null }>;
      byModel: Array<{ providerType: string; modelUsed: string; requests: number; calculatedCostUsd: number | null }>;
      byUser: Array<{ userLabel: string; requests: number; calculatedCostUsd: number | null }>;
    };
    logs: Array<{ id: string; calculatedCostUsd: number | null; usageAvailable: boolean }>;
    alerts: unknown[];
  };

  assert.equal(deptAdminData.logs.length, 200);
  assert.equal(deptAdminData.summary.totalRequests, 205);
  assert.equal(deptAdminData.summary.successfulRequests, 205);
  assert.equal(deptAdminData.summary.failedRequests, 0);
  assert.equal(deptAdminData.summary.totalInputTokens, 205_000);
  assert.equal(deptAdminData.summary.totalOutputTokens, 102_500);
  assert.equal(deptAdminData.summary.totalCalculatedCostUsd, 4.1);
  assert.equal(deptAdminData.summary.byDepartment.length, 1);
  assert.equal(deptAdminData.summary.byDepartment[0].requests, 205);
  assert.equal(deptAdminData.summary.byDepartment[0].calculatedCostUsd, 4.1);
  assert.equal(deptAdminData.summary.byAgent[0].tokens, 307_500);
  assert.equal(deptAdminData.summary.byProvider[0].providerType, 'openai');
  assert.equal(deptAdminData.summary.byModel[0].modelUsed, 'gpt-4o');
  assert.equal(deptAdminData.summary.byUser[0].userLabel, 'user-a1@corp');

  // Member B1 check: sees only their 7 rows (5 success @ $0.00 + 2 failed with null)
  const memberBRes = await fetch(`${gatewayBaseUrl}/api/admin/usage?days=30`, {
    headers: { Authorization: `Bearer ${memberB1.token}` },
  });
  assert.equal(memberBRes.status, 200);
  const memberBData = (await memberBRes.json()) as typeof deptAdminData;
  assert.equal(memberBData.summary.totalRequests, 7);
  assert.equal(memberBData.summary.successfulRequests, 5);
  assert.equal(memberBData.summary.failedRequests, 2);
  assert.equal(memberBData.summary.unavailableUsageRequests, 2);
  assert.equal(memberBData.summary.totalCalculatedCostUsd, 0);
  assert.equal(memberBData.summary.totalInputTokens, 500);
  assert.equal(memberBData.summary.totalOutputTokens, 250);
  assert.equal(memberBData.alerts.length, 0);

  // Global admin sees everything across workspace
  const globalRes = await fetch(`${gatewayBaseUrl}/api/admin/usage?days=30`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(globalRes.status, 200);
  const globalData = (await globalRes.json()) as typeof deptAdminData;
  assert.ok(globalData.summary.totalRequests >= 212);
  assert.ok(globalData.summary.byProvider.some((p) => p.providerType === 'ollama'));
  assert.ok(globalData.summary.byProvider.some((p) => p.providerType === 'openai'));
  assert.ok(globalData.summary.byDepartment.some((d) => d.departmentId === deptA));
  assert.ok(globalData.summary.byDepartment.some((d) => d.departmentId === deptB));
});

test('SQLite migration 0001 cleanly migrates existing 0000 database and allows null tokens/cost', () => {
  const migDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nawah-mig-'));
  const sqliteFile = path.join(migDir, 'legacy.db');
  const legacySql = fs.readFileSync(
    path.resolve(process.cwd(), 'drizzle/0000_bent_xavin.sql'),
    'utf8',
  );

  const legacyDb = new Database(sqliteFile);
  try {
    for (const stmt of legacySql.split('--> statement-breakpoint')) {
      const cleaned = stmt.trim();
      if (cleaned) legacyDb.exec(cleaned);
    }

    // Record migration 0000 in __drizzle_migrations as Drizzle expects, then insert legacy rows
    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      );
    `);
    const journal = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const entry0 = journal.entries.find((e) => e.idx === 0)!;
    const crypto = require('node:crypto') as typeof import('node:crypto');
    const hash0 = crypto.createHash('sha256').update(legacySql).digest('hex');
    legacyDb
      .prepare('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)')
      .run(hash0, entry0.when);

    legacyDb
      .prepare(
        `INSERT INTO workspaces (id, name, slug, created_at) VALUES ('ws_default', 'Default', 'default', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    legacyDb
      .prepare(
        `INSERT INTO usage_logs (id, workspace_id, user_label, provider_type, model_used, status, input_tokens, output_tokens, actual_cost_usd, latency_ms, created_at)
         VALUES ('log_old', 'ws_default', 'legacy', 'openai', 'gpt-4o', 'success', 100, 50, 0.001, 10, '2026-01-01T00:00:00.000Z')`,
      )
      .run();

    // Now run Drizzle migrate() which applies 0001_striped_naoko.sql
    const dDb = drizzle(legacyDb, { schema: schemaMod });
    migrate(dDb, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });

    // Verify legacy row survived intact
    const oldRow = legacyDb
      .prepare('SELECT id, input_tokens, output_tokens, actual_cost_usd FROM usage_logs WHERE id = ?')
      .get('log_old') as {
      id: string;
      input_tokens: number | null;
      output_tokens: number | null;
      actual_cost_usd: number | null;
    };
    assert.equal(oldRow.id, 'log_old');
    assert.equal(oldRow.input_tokens, 100);
    assert.equal(oldRow.output_tokens, 50);
    assert.equal(oldRow.actual_cost_usd, 0.001);

    // Verify NULL tokens/cost can now be inserted cleanly
    legacyDb
      .prepare(
        `INSERT INTO usage_logs (id, workspace_id, user_label, provider_type, model_used, status, input_tokens, output_tokens, actual_cost_usd, latency_ms, created_at)
         VALUES ('log_null', 'ws_default', 'new', 'ollama', 'llama3.2', 'failed', NULL, NULL, NULL, 5, '2026-01-02T00:00:00.000Z')`,
      )
      .run();

    const nullRow = legacyDb
      .prepare('SELECT input_tokens, output_tokens, actual_cost_usd FROM usage_logs WHERE id = ?')
      .get('log_null') as {
      input_tokens: number | null;
      output_tokens: number | null;
      actual_cost_usd: number | null;
    };
    assert.equal(nullRow.input_tokens, null);
    assert.equal(nullRow.output_tokens, null);
    assert.equal(nullRow.actual_cost_usd, null);
  } finally {
    legacyDb.close();
    fs.rmSync(migDir, { recursive: true, force: true });
  }
});
