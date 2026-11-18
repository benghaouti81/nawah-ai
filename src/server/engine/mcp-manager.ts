import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DiscoveredMcpTool, McpTransport } from '../../shared/types.ts';
import { decryptSecret } from '../utils/crypto.ts';

export interface McpServerRecord {
  id: string;
  name: string;
  slug: string;
  transport: string;
  endpointOrCommand: string;
  encryptedAuthHeaders: string | null;
  isActive: boolean;
}

export interface BoundMcpTool {
  qualifiedName: string;
  serverId: string;
  serverSlug: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolExecutionEvent {
  step: number;
  serverSlug: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result: string;
  isError: boolean;
}

function splitCommandArgs(commandLine: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  if (tokens.length === 0) {
    throw new Error('MCP stdio command cannot be empty');
  }
  return { command: tokens[0], args: tokens.slice(1) };
}

function parseAuthHeaders(encryptedAuthHeaders: string | null): Record<string, string> {
  if (!encryptedAuthHeaders) {
    return {};
  }
  const decrypted = decryptSecret(encryptedAuthHeaders);
  const parsed = JSON.parse(decrypted) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string' && k.trim()) {
      out[k.trim()] = v;
    }
  }
  return out;
}

async function connectClient(server: McpServerRecord): Promise<Client> {
  const transportType = server.transport as McpTransport;
  const headers = parseAuthHeaders(server.encryptedAuthHeaders);

  const client = new Client(
    { name: 'nawah-ai-core', version: '0.1.0' },
    { capabilities: {} },
  );

  if (transportType === 'streamable_http') {
    const url = new URL(server.endpointOrCommand);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    });
    await client.connect(transport);
    return client;
  }

  if (transportType === 'http_sse') {
    const url = new URL(server.endpointOrCommand);
    const transport = new SSEClientTransport(url, {
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    });
    await client.connect(transport);
    return client;
  }

  if (transportType === 'stdio') {
    const { command, args } = splitCommandArgs(server.endpointOrCommand);
    const transport = new StdioClientTransport({
      command,
      args,
    });
    await client.connect(transport);
    return client;
  }

  throw new Error(`Unsupported MCP transport: ${server.transport}`);
}

export async function discoverServerTools(
  server: McpServerRecord,
): Promise<DiscoveredMcpTool[]> {
  const client = await connectClient(server);
  try {
    const result = await client.listTools();
    return (result.tools || []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema || { type: 'object', properties: {} }) as Record<
        string,
        unknown
      >,
      annotations: t.annotations
        ? {
            readOnlyHint: t.annotations.readOnlyHint,
            destructiveHint: t.annotations.destructiveHint,
            idempotentHint: t.annotations.idempotentHint,
            openWorldHint: t.annotations.openWorldHint,
          }
        : undefined,
    }));
  } finally {
    await client.close().catch(() => undefined);
  }
}

export class AuthorizedMcpSession {
  private clients = new Map<string, Client>();
  private toolMap = new Map<string, BoundMcpTool>();
  public readonly tools: BoundMcpTool[] = [];

  private constructor() {}

  static async create(params: {
    servers: McpServerRecord[];
    allowedTools: string[];
    readOnly: boolean;
  }): Promise<AuthorizedMcpSession> {
    const session = new AuthorizedMcpSession();
    const allowSet = new Set(params.allowedTools);

    try {
      for (const server of params.servers) {
        if (!server.isActive) continue;
        const client = await connectClient(server);
        session.clients.set(server.id, client);

        const listed = await client.listTools();
        for (const tool of listed.tools || []) {
          if (allowSet.size > 0 && !allowSet.has(tool.name)) {
            continue;
          }
          if (allowSet.size === 0) {
            // Strict whitelist: if allowedTools is empty, no tools are exposed
            continue;
          }
          if (params.readOnly) {
            if (
              tool.annotations?.destructiveHint === true ||
              tool.annotations?.readOnlyHint === false
            ) {
              continue;
            }
          }

          const qualifiedName = `${server.slug}__${tool.name}`;
          const bound: BoundMcpTool = {
            qualifiedName,
            serverId: server.id,
            serverSlug: server.slug,
            toolName: tool.name,
            description:
              tool.description ||
              `Execute ${tool.name} on MCP server ${server.name}`,
            inputSchema: (tool.inputSchema || {
              type: 'object',
              properties: {},
            }) as Record<string, unknown>,
          };
          session.toolMap.set(qualifiedName, bound);
          session.tools.push(bound);
        }
      }
      return session;
    } catch (err) {
      await session.close();
      throw err;
    }
  }

  async invokeTool(
    qualifiedName: string,
    args: Record<string, unknown>,
  ): Promise<{ serverSlug: string; toolName: string; resultText: string; isError: boolean }> {
    const bound = this.toolMap.get(qualifiedName);
    if (!bound) {
      return {
        serverSlug: 'unknown',
        toolName: qualifiedName,
        resultText: `Tool "${qualifiedName}" is not whitelisted or authorized for this agent.`,
        isError: true,
      };
    }
    const client = this.clients.get(bound.serverId);
    if (!client) {
      return {
        serverSlug: bound.serverSlug,
        toolName: bound.toolName,
        resultText: `MCP server "${bound.serverSlug}" is not connected.`,
        isError: true,
      };
    }

    const response = await client.callTool({
      name: bound.toolName,
      arguments: args,
    });

    const contentParts = Array.isArray(response.content)
      ? response.content.map((c) => {
          if (typeof c === 'object' && c !== null && 'text' in c) {
            return String((c as { text: unknown }).text);
          }
          return JSON.stringify(c);
        })
      : [JSON.stringify(response.content ?? '')];

    return {
      serverSlug: bound.serverSlug,
      toolName: bound.toolName,
      resultText: contentParts.join('\n'),
      isError: Boolean(response.isError),
    };
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.close().catch(() => undefined);
    }
    this.clients.clear();
  }
}
