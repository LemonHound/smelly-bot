import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { logger } from '../logger.js';
import { KNOWN_DOC_PATHS } from '../github/tools.js';

const TOOL_TIMEOUT_MS = 15_000;

function toAnthropicTool(mcpTool) {
  return {
    name: mcpTool.name,
    description: mcpTool.description ?? '',
    input_schema: mcpTool.inputSchema ?? { type: 'object', properties: {} },
  };
}

export function resolveVars(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [
      k,
      v.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => {
        const val = process.env[name];
        if (val === undefined) throw new Error(`Missing env var $${name} required by mcp-servers.json`);
        return val;
      }),
    ])
  );
}

function validateToolCall(toolName, args, toolIndex, githubRepo) {
  if (!toolIndex.has(toolName)) {
    return { ok: false, reason: `Unknown tool: ${toolName}` };
  }

  if (toolName === 'get_file_contents' && githubRepo) {
    const [owner, repo] = githubRepo.split('/');
    if (args.owner === owner && args.repo === repo) {
      if (!KNOWN_DOC_PATHS.includes(args.path)) {
        return { ok: false, reason: `Path not in allowlist: ${args.path}` };
      }
    }
  }

  if (toolName === 'refresh_repo_doc') {
    if (!KNOWN_DOC_PATHS.includes(args.path)) {
      return { ok: false, reason: `Path not in allowlist: ${args.path}` };
    }
  }

  return { ok: true };
}

async function connectServer(server, _clientFactory) {
  if (_clientFactory) {
    const client = _clientFactory(server);
    const { tools: serverTools } = await client.listTools();
    return { client, serverTools };
  }

  const client = new Client({ name: 'smelly-bot', version: '1.0.0' });
  let transport;

  if (server.type === 'http') {
    const resolvedHeaders = resolveVars(server.headers ?? {});
    transport = new StreamableHTTPClientTransport(
      new URL(server.url),
      { requestInit: { headers: resolvedHeaders } }
    );
  } else {
    transport = new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: { ...process.env, ...(server.env ?? {}) },
    });
  }

  await client.connect(transport);
  const { tools: serverTools } = await client.listTools();
  return { client, serverTools };
}

export async function createMcpClient(servers, localTools = [], githubRepo = null, _clientFactory = null) {
  const toolIndex = new Map();
  const tools = [];
  const toolsByServer = new Map();

  for (const server of servers) {
    try {
      const { client, serverTools } = await connectServer(server, _clientFactory);

      const allowed = new Set(server.allowedTools ?? []);
      const enabledTools = allowed.size > 0
        ? serverTools.filter(t => allowed.has(t.name))
        : [];

      if (enabledTools.length === 0) {
        logger.warn(
          { server: server.name, rawTools: serverTools.map(t => t.name) },
          'MCP server connected but zero tools exposed (check allowedTools)'
        );
      }

      const serverToolNames = [];
      for (const tool of enabledTools) {
        toolIndex.set(tool.name, { client, serverName: server.name });
        tools.push(toAnthropicTool(tool));
        serverToolNames.push(tool.name);
      }
      toolsByServer.set(server.name, serverToolNames);

      logger.info(
        { server: server.name, tools: serverToolNames },
        'MCP server connected'
      );
    } catch (err) {
      logger.warn({ server: server.name, err: err.message }, 'MCP server failed to start, continuing without it');
      toolsByServer.set(server.name, []);
    }
  }

  const localToolNames = [];
  for (const tool of localTools) {
    toolIndex.set(tool.name, { handler: tool.handler, serverName: 'local' });
    tools.push({ name: tool.name, description: tool.description, input_schema: tool.input_schema });
    localToolNames.push(tool.name);
  }
  toolsByServer.set('local', localToolNames);

  async function callTool(toolName, args) {
    const validation = validateToolCall(toolName, args, toolIndex, githubRepo);
    if (!validation.ok) {
      logger.warn({ tool: toolName, args, reason: validation.reason }, 'Tool call rejected by security layer');
      return [{ type: 'text', text: 'Tool call failed.' }];
    }

    const entry = toolIndex.get(toolName);

    if (entry.handler) {
      logger.info({ tool: toolName }, 'Local tool call started');
      try {
        const result = await entry.handler(args);
        logger.info({ tool: toolName }, 'Local tool call completed');
        return result;
      } catch (err) {
        logger.warn({ tool: toolName, err: err.message }, 'Local tool call failed');
        return [{ type: 'text', text: 'Tool call failed.' }];
      }
    }

    logger.info({ server: entry.serverName, tool: toolName }, 'Tool call started');

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Tool call timed out: ${toolName}`)), TOOL_TIMEOUT_MS)
    );
    const call = entry.client.callTool({ name: toolName, arguments: args });
    const result = await Promise.race([call, timeout]);

    const isError = result.isError === true;
    logger.info({ server: entry.serverName, tool: toolName, isError }, 'Tool call completed');
    if (isError) {
      logger.warn({ server: entry.serverName, tool: toolName, content: result.content }, 'Tool returned error content');
    }

    return result.content;
  }

  return { tools, callTool, toolsByServer };
}
