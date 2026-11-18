import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const require = createRequire(import.meta.url);
const express = require(path.resolve(process.cwd(), 'node_modules/express/index.js')) as typeof import('express');

type CapturedRequest = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

async function startMockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void | Promise<void>,
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
        res.end(JSON.stringify({ error: { message: err instanceof Error ? err.message : 'mock error' } }));
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
let adminToken = 'nawah_test_admin_key_12345';

let dbMod: typeof import('../src/server/db/index.ts');
let schemaMod: typeof import('../src/server/db/schema.ts');
let cryptoMod: typeof import('../src/server/utils/crypto.ts');
let routerMod: typeof import('../src/server/engine/provider-router.ts');

function setupFixtureAgent(params: {
  slug: string;
  providerType: 'openai' | 'anthropic' | 'google' | 'ollama' | 'openai_compatible';
  baseUrl: string | null;
  apiKey: string | null;
  modelId: string;
  supportsVision?: boolean;
  modelActive?: boolean;
  providerActive?: boolean;
}): { agentModelParam: string } {
  const now = new Date().toISOString();
  const deptId = cryptoMod.makeId('dept');
  const providerId = cryptoMod.makeId('prov');
  const modelRowId = cryptoMod.makeId('mod');
  const agentId = cryptoMod.makeId('agt');

  dbMod.db
    .insert(schemaMod.departments)
    .values({
      id: deptId,
      workspaceId: dbMod.DEFAULT_WORKSPACE_ID,
      name: `Dept ${params.slug}`,
      slug: `dept-${params.slug}`,
      monthlyAlertThresholdUsd: 100,
      allowedModelIds: [],
      allowedMcpServerIds: [],
      createdAt: now,
    })
    .run();

  dbMod.db
    .insert(schemaMod.providers)
    .values({
      id: providerId,
      workspaceId: dbMod.DEFAULT_WORKSPACE_ID,
      name: `Provider ${params.slug}`,
      type: params.providerType,
      baseUrl: params.baseUrl,
      encryptedApiKey: params.apiKey ? cryptoMod.encryptSecret(params.apiKey) : null,
      isActive: params.providerActive ?? true,
      createdAt: now,
    })
    .run();

  dbMod.db
    .insert(schemaMod.providerModels)
    .values({
      id: modelRowId,
      providerId,
      modelId: params.modelId,
      inputCostPer1mUsd: 1,
      outputCostPer1mUsd: 2,
      supportsVision: params.supportsVision ?? false,
      isActive: params.modelActive ?? true,
      createdAt: now,
    })
    .run();

  dbMod.db
    .insert(schemaMod.agents)
    .values({
      id: agentId,
      workspaceId: dbMod.DEFAULT_WORKSPACE_ID,
      departmentId: deptId,
      slug: params.slug,
      name: `Agent ${params.slug}`,
      description: 'Test agent',
      systemPrompt: 'Base agent prompt',
      contextDocs: '',
      modelId: modelRowId,
      temperature: 0.3,
      mcpPermissions: { serverIds: [], allowedTools: [], readOnly: true },
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return { agentModelParam: `agent/${params.slug}` };
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nawah-task2-'));
  process.env.NAWAH_DATA_DIR = tempDir;
  process.env.NAWAH_BOOTSTRAP_ADMIN_KEY = adminToken;

  dbMod = await import('../src/server/db/index.ts');
  schemaMod = await import('../src/server/db/schema.ts');
  cryptoMod = await import('../src/server/utils/crypto.ts');
  routerMod = await import('../src/server/engine/provider-router.ts');
  const { openAiRouter } = await import('../src/server/routes/v1-openai.ts');

  dbMod.initializeDatabase();

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/v1', openAiRouter);

  gatewayServer = http.createServer(app);
  await new Promise<void>((resolve) => gatewayServer!.listen(0, '127.0.0.1', resolve));
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

test('OpenAI: non-streaming, SSE streaming with cumulative usage & unterminated EOF buffer, and vision check', async () => {
  const mock = await startMockServer((req, res, body) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }] }));
      return;
    }

    const reqJson = JSON.parse(body) as {
      stream?: boolean;
      max_tokens?: number;
      messages?: Array<{ role: string; content: unknown }>;
    };

    if (!reqJson.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-upstream',
          choices: [
            {
              message: { role: 'assistant', content: 'OpenAI non-stream ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 15, completion_tokens: 7 },
        }),
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"OpenAI"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n');
    // Unterminated final line at EOF (no trailing newline) should still be processed
    res.end('data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":6}}');
  });

  try {
    const visionEnabled = setupFixtureAgent({
      slug: 'openai-vision',
      providerType: 'openai',
      baseUrl: `${mock.baseUrl}/v1`,
      apiKey: 'sk-test-openai',
      modelId: 'gpt-4o',
      supportsVision: true,
    });

    const nonStreamRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: visionEnabled.agentModelParam,
        max_tokens: 256,
        messages: [
          { role: 'system', content: 'Extra instruction' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            ],
          },
        ],
      }),
    });

    assert.equal(nonStreamRes.status, 200);
    const nonStreamJson = (await nonStreamRes.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    assert.equal(nonStreamJson.choices[0].message.content, 'OpenAI non-stream ok');
    assert.equal(nonStreamJson.usage.prompt_tokens, 15);
    assert.equal(nonStreamJson.usage.completion_tokens, 7);

    const capturedReq = JSON.parse(mock.requests[0].body) as {
      max_tokens: number;
      messages: Array<{ role: string; content: unknown }>;
    };
    assert.equal(capturedReq.max_tokens, 256);
    assert.equal(capturedReq.messages[0].role, 'system');
    assert.match(String(capturedReq.messages[0].content), /Extra instruction/);
    assert.ok(Array.isArray(capturedReq.messages[1].content));
    assert.equal(
      (capturedReq.messages[1].content as Array<{ type: string }>)[1].type,
      'image_url',
    );
    assert.equal(mock.requests[0].headers.authorization, 'Bearer sk-test-openai');

    // Streaming test
    const streamRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: visionEnabled.agentModelParam,
        stream: true,
        messages: [{ role: 'user', content: 'Hi stream' }],
      }),
    });
    assert.equal(streamRes.status, 200);
    const sseText = await streamRes.text();
    const dataPayloads = sseText
      .split('\n\n')
      .map((block) => block.trim())
      .filter((block) => block.startsWith('data: ') && block !== 'data: [DONE]')
      .map((block) => JSON.parse(block.slice(6)) as {
        choices: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      });

    const contentJoined = dataPayloads
      .map((p) => p.choices[0]?.delta?.content ?? '')
      .join('');
    assert.equal(contentJoined, 'Hello OpenAI!');
    const finalChunk = dataPayloads.find((p) => p.usage);
    assert.ok(finalChunk?.usage);
    // Must not sum intermediate cumulative chunks (10+10+10 or 2+5+6)
    assert.equal(finalChunk.usage.prompt_tokens, 10);
    assert.equal(finalChunk.usage.completion_tokens, 6);

    // Vision disabled agent must reject image_url with 400
    const noVision = setupFixtureAgent({
      slug: 'openai-no-vision',
      providerType: 'openai',
      baseUrl: `${mock.baseUrl}/v1`,
      apiKey: 'sk-test-openai',
      modelId: 'gpt-4o-mini',
      supportsVision: false,
    });
    const visionRejectedRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: noVision.agentModelParam,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Look' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
            ],
          },
        ],
      }),
    });
    assert.equal(visionRejectedRes.status, 400);
    const rejJson = (await visionRejectedRes.json()) as { error: { code: string } };
    assert.equal(rejJson.error.code, 'vision_not_supported');

    const conn = await routerMod.testProviderConnection({
      type: 'openai',
      baseUrl: `${mock.baseUrl}/v1`,
      apiKey: 'sk-test-openai',
    });
    assert.equal(conn.ok, true);
    assert.equal(conn.modelsCount, 1);
  } finally {
    await mock.close();
  }
});

test('Anthropic: tool history + vision translation, SSE token counting, max_tokens finish reason, and stream error events', async () => {
  let streamMode: 'normal' | 'error' = 'normal';
  const mock = await startMockServer((req, res, body) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'claude-3-7-sonnet' }] }));
      return;
    }

    const reqJson = JSON.parse(body) as {
      stream?: boolean;
      messages: Array<{ role: string; content: Array<{ type: string }> }>;
    };

    if (!reqJson.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Anthropic ok' }],
          stop_reason: 'max_tokens',
          usage: { input_tokens: 21, output_tokens: 13 },
        }),
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":4}}}\n\n',
    );
    res.write(
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    );
    res.write(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Streamed "}}\n\n',
    );
    if (streamMode === 'error') {
      res.end(
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Upstream overloaded"}}\n\n',
      );
      return;
    }
    res.write(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude"}}\n\n',
    );
    res.write(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":9}}\n\n',
    );
    res.end('event: message_stop\ndata: {"type":"message_stop"}');
  });

  try {
    const claude = setupFixtureAgent({
      slug: 'claude-agent',
      providerType: 'anthropic',
      baseUrl: `${mock.baseUrl}/v1`,
      apiKey: 'sk-ant-test',
      modelId: 'claude-3-7-sonnet',
      supportsVision: true,
    });

    const nonStreamRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: claude.agentModelParam,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Check image' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            ],
          },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'tc_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"1"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'tc_1', content: 'tool result text' },
          { role: 'user', content: 'Continue' },
        ],
      }),
    });

    assert.equal(nonStreamRes.status, 200);
    const json = (await nonStreamRes.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    assert.equal(json.choices[0].message.content, 'Anthropic ok');
    assert.equal(json.choices[0].finish_reason, 'length');
    assert.equal(json.usage.prompt_tokens, 21);
    assert.equal(json.usage.completion_tokens, 13);

    // Check Anthropic wire payload: user -> assistant(tool_use) -> user(tool_result + text coalesced!)
    const sent = JSON.parse(mock.requests[0].body) as {
      max_tokens: number;
      messages: Array<{ role: string; content: Array<{ type: string }> }>;
    };
    assert.equal(mock.requests[0].headers['x-api-key'], 'sk-ant-test');
    assert.equal(sent.max_tokens, 100);
    assert.deepEqual(
      sent.messages.map((m) => m.role),
      ['user', 'assistant', 'user'],
    );
    assert.equal(sent.messages[0].content[1].type, 'image');
    assert.equal(sent.messages[1].content[0].type, 'tool_use');
    assert.equal(sent.messages[2].content[0].type, 'tool_result');
    assert.equal(sent.messages[2].content[1].type, 'text');

    // SSE stream test: output_tokens must equal 9 (not 4+9=13) and finish_reason must be 'length'
    streamMode = 'normal';
    const streamRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: claude.agentModelParam,
        stream: true,
        messages: [{ role: 'user', content: 'Hi Claude' }],
      }),
    });
    assert.equal(streamRes.status, 200);
    const sseText = await streamRes.text();
    const events = sseText
      .split('\n\n')
      .map((b) => b.trim())
      .filter((b) => b.startsWith('data: ') && b !== 'data: [DONE]')
      .map((b) => JSON.parse(b.slice(6)) as {
        choices: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      });
    assert.equal(
      events.map((e) => e.choices[0]?.delta?.content ?? '').join(''),
      'Streamed Claude',
    );
    const usageEvt = events.find((e) => e.usage);
    assert.ok(usageEvt?.usage);
    assert.equal(usageEvt.usage.prompt_tokens, 12);
    assert.equal(usageEvt.usage.completion_tokens, 9);
    assert.equal(usageEvt.choices[0].finish_reason, 'length');

    // SSE error event inside HTTP 200 Anthropic stream
    streamMode = 'error';
    const errStreamRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: claude.agentModelParam,
        stream: true,
        messages: [{ role: 'user', content: 'Trigger error' }],
      }),
    });
    const errSseText = await errStreamRes.text();
    assert.match(errSseText, /Upstream overloaded/);
    assert.match(errSseText, /"type":"gateway_error"/);
  } finally {
    await mock.close();
  }
});

test('Google: maxOutputTokens, multimodal + tool history, non-streaming, streaming, and testProviderConnection', async () => {
  const mock = await startMockServer((req, res) => {
    if (req.url?.includes('/models?') || req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash' }] }));
      return;
    }

    if (req.url?.includes(':streamGenerateContent')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Gemini "}]}}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":2}}\n\n',
      );
      res.end(
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Stream"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":5}}\n\n',
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Gemini ok' }] },
            finishReason: 'MAX_TOKENS',
          },
        ],
        usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 11 },
      }),
    );
  });

  try {
    const gemini = setupFixtureAgent({
      slug: 'gemini-agent',
      providerType: 'google',
      baseUrl: mock.baseUrl,
      apiKey: 'AIzaTestGoogleKey',
      modelId: 'gemini-2.5-flash',
      supportsVision: true,
    });

    const nonStreamRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: gemini.agentModelParam,
        max_tokens: 320,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analyze' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            ],
          },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'g_1', type: 'function', function: { name: 'search_docs', arguments: '{"q":"nawah"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'g_1', content: 'doc snippet' },
        ],
      }),
    });

    assert.equal(nonStreamRes.status, 200);
    const json = (await nonStreamRes.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    assert.equal(json.choices[0].message.content, 'Gemini ok');
    assert.equal(json.choices[0].finish_reason, 'length');
    assert.equal(json.usage.prompt_tokens, 18);
    assert.equal(json.usage.completion_tokens, 11);

    const captured = JSON.parse(mock.requests[0].body) as {
      generationConfig?: { maxOutputTokens?: number };
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    assert.equal(captured.generationConfig?.maxOutputTokens, 320);
    assert.deepEqual(
      captured.contents.map((c) => c.role),
      ['user', 'model', 'user'],
    );
    assert.ok('inlineData' in captured.contents[0].parts[1]);
    assert.ok('functionCall' in captured.contents[1].parts[0]);
    assert.ok('functionResponse' in captured.contents[2].parts[0]);

    const streamRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: gemini.agentModelParam,
        stream: true,
        messages: [{ role: 'user', content: 'Stream Gemini' }],
      }),
    });
    assert.equal(streamRes.status, 200);
    const sseText = await streamRes.text();
    assert.match(sseText, /Gemini /);
    assert.match(sseText, /Stream/);
    assert.match(sseText, /"prompt_tokens":8,"completion_tokens":5/);

    const conn = await routerMod.testProviderConnection({
      type: 'google',
      baseUrl: mock.baseUrl,
      apiKey: 'AIzaTestGoogleKey',
    });
    assert.equal(conn.ok, true);
    assert.equal(conn.modelsCount, 1);
  } finally {
    await mock.close();
  }
});

test('Ollama: non-streaming, stream_options 400 fallback, and testProviderConnection', async () => {
  const mock = await startMockServer((req, res, body) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'llama3.2' }] }));
      return;
    }

    const reqJson = JSON.parse(body) as { stream?: boolean; stream_options?: unknown };
    if (!reqJson.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Ollama ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 9, completion_tokens: 4 },
        }),
      );
      return;
    }

    if ('stream_options' in reqJson) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unknown field stream_options' } }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Fallback "},"finish_reason":null}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n');
    res.end('data: [DONE]\n\n');
  });

  try {
    const ollama = setupFixtureAgent({
      slug: 'ollama-agent',
      providerType: 'ollama',
      baseUrl: `${mock.baseUrl}/v1`,
      apiKey: null,
      modelId: 'llama3.2',
    });

    const nonStreamRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ollama.agentModelParam,
        messages: [{ role: 'user', content: 'Hello Ollama' }],
      }),
    });
    assert.equal(nonStreamRes.status, 200);
    const json = (await nonStreamRes.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(json.choices[0].message.content, 'Ollama ok');

    const streamRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ollama.agentModelParam,
        stream: true,
        messages: [{ role: 'user', content: 'Stream Ollama' }],
      }),
    });
    assert.equal(streamRes.status, 200);
    const sseText = await streamRes.text();
    assert.match(sseText, /Fallback /);
    assert.match(sseText, /OK/);
    // Verify initial stream attempt + 1 fallback retry occurred
    assert.equal(mock.requests.length, 3);

    const conn = await routerMod.testProviderConnection({
      type: 'ollama',
      baseUrl: `${mock.baseUrl}/v1`,
      apiKey: null,
    });
    assert.equal(conn.ok, true);
    assert.equal(conn.modelsCount, 1);
  } finally {
    await mock.close();
  }
});

test('Error handling: invalid API key (401), missing API key, disabled/missing model, unreachable provider, timeout, and client abort', async () => {
  // 1. Missing API key
  const noKey = setupFixtureAgent({
    slug: 'no-key-anthropic',
    providerType: 'anthropic',
    baseUrl: 'http://127.0.0.1:9999/v1',
    apiKey: null,
    modelId: 'claude-3-7-sonnet',
  });
  const noKeyRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: noKey.agentModelParam,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  assert.equal(noKeyRes.status, 422);
  assert.equal(((await noKeyRes.json()) as { error: { code: string } }).error.code, 'provider_key_missing');

  // 2. Disabled model
  const inactiveModel = setupFixtureAgent({
    slug: 'inactive-model',
    providerType: 'openai',
    baseUrl: 'http://127.0.0.1:9999/v1',
    apiKey: 'sk-x',
    modelId: 'gpt-4o',
    modelActive: false,
  });
  const inactiveModelRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: inactiveModel.agentModelParam,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  assert.equal(inactiveModelRes.status, 422);
  assert.equal(
    ((await inactiveModelRes.json()) as { error: { code: string } }).error.code,
    'provider_model_unavailable',
  );

  // 3. Unknown agent/model
  const missingAgentRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'agent/does-not-exist',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  assert.equal(missingAgentRes.status, 404);

  // 4. Invalid API key (upstream 401) + slow timeout + client abort
  let upstreamAborted = false;
  const mock = await startMockServer((req, res) => {
    if (req.url === '/timeout/chat/completions') {
      // Never respond quickly so timeout triggers
      const timer = setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        }
      }, 2500);
      req.on('close', () => {
        clearTimeout(timer);
        upstreamAborted = true;
      });
      return;
    }
    if (req.url === '/abort/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Part1"},"finish_reason":null}]}\n\n');
      req.on('close', () => {
        upstreamAborted = true;
      });
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
  });

  try {
    const badKey = setupFixtureAgent({
      slug: 'bad-key-openai',
      providerType: 'openai',
      baseUrl: `${mock.baseUrl}/v1`,
      apiKey: 'sk-invalid',
      modelId: 'gpt-4o',
    });
    const badKeyRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: badKey.agentModelParam,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(badKeyRes.status, 502);
    const badKeyJson = (await badKeyRes.json()) as { error: { code: string; message: string } };
    assert.equal(badKeyJson.error.code, 'upstream_provider_error');
    assert.match(badKeyJson.error.message, /HTTP 401/);

    // 5. Unreachable provider (bind then close port immediately)
    const deadMock = await startMockServer((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    const deadUrl = `${deadMock.baseUrl}/v1`;
    await deadMock.close();

    const unreachable = setupFixtureAgent({
      slug: 'unreachable-ollama',
      providerType: 'ollama',
      baseUrl: deadUrl,
      apiKey: null,
      modelId: 'llama3.2',
    });
    const unreachableRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: unreachable.agentModelParam,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(unreachableRes.status, 502);

    // 6. Timeout handling
    const prevTimeout = process.env.NAWAH_PROVIDER_TIMEOUT_MS;
    process.env.NAWAH_PROVIDER_TIMEOUT_MS = '150';
    try {
      const slowAgent = setupFixtureAgent({
        slug: 'slow-openai',
        providerType: 'openai',
        baseUrl: `${mock.baseUrl}/timeout`,
        apiKey: 'sk-ok',
        modelId: 'gpt-4o',
      });
      const timeoutRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: slowAgent.agentModelParam,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      assert.equal(timeoutRes.status, 504);
      const timeoutJson = (await timeoutRes.json()) as { error: { code: string } };
      assert.equal(timeoutJson.error.code, 'upstream_provider_timeout');
    } finally {
      if (prevTimeout === undefined) {
        delete process.env.NAWAH_PROVIDER_TIMEOUT_MS;
      } else {
        process.env.NAWAH_PROVIDER_TIMEOUT_MS = prevTimeout;
      }
    }

    // 7. Client SSE abort propagation
    upstreamAborted = false;
    const abortAgent = setupFixtureAgent({
      slug: 'abort-openai',
      providerType: 'openai',
      baseUrl: `${mock.baseUrl}/abort`,
      apiKey: 'sk-ok',
      modelId: 'gpt-4o',
    });
    const clientAbort = new AbortController();
    const sseAbortRes = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: abortAgent.agentModelParam,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: clientAbort.signal,
    });
    assert.equal(sseAbortRes.status, 200);
    const reader = sseAbortRes.body!.getReader();
    await reader.read();
    clientAbort.abort();
    await reader.cancel().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(upstreamAborted, true);
  } finally {
    await mock.close();
  }
});
