import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { logger } from '../logger.js';

const TOOL_TIMEOUT_MS = 15_000;

function toAnthropicTool(mcpTool) {
  return {
    name: mcpTool.name,
    description: mcpTool.description ?? '',
    input_schema: mcpTool.inputSchema ?? { type: 'object', properties: {} },
  };
}

export async function createMcpClient(servers) {
  const toolIndex = new Map();
  const tools = [];

  for (const server of servers) {
    const client = new Client({ name: 'smelly-bot', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: server.env ?? undefined,
    });

    const disabled = new Set(server.disabledTools ?? []);

    try {
      await client.connect(transport);
      const { tools: serverTools } = await client.listTools();
      const enabledTools = serverTools.filter(t => !disabled.has(t.name));
      for (const tool of enabledTools) {
        toolIndex.set(tool.name, { client, serverName: server.name });
        tools.push(toAnthropicTool(tool));
      }
      logger.info(
        { server: server.name, tools: enabledTools.map(t => t.name), disabled: [...disabled] },
        'MCP server connected',
      );
    } catch (err) {
      logger.warn({ server: server.name, err: err.message }, 'MCP server failed to start, continuing without it');
    }
  }

  async function callTool(toolName, args) {
    const entry = toolIndex.get(toolName);
    if (!entry) throw new Error(`No MCP server provides tool: ${toolName}`);

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

  return { tools, callTool };
}
