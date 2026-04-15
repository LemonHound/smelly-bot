import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVars, createMcpClient } from '../src/mcp/client.js';

function makeStubClient(toolNames = []) {
  return {
    async listTools() {
      return {
        tools: toolNames.map(name => ({
          name,
          description: `desc:${name}`,
          inputSchema: { type: 'object', properties: {} },
        })),
      };
    },
    async callTool({ name }) {
      return { content: [{ type: 'text', text: `result:${name}` }], isError: false };
    },
  };
}

function clientFactory(toolNames) {
  return (_server) => makeStubClient(toolNames);
}

describe('resolveVars', () => {
  it('substitutes $VARNAME from process.env', () => {
    process.env.GITHUB_TOKEN = 'abc123';
    const result = resolveVars({ Authorization: 'Bearer $GITHUB_TOKEN' });
    assert.equal(result.Authorization, 'Bearer abc123');
    delete process.env.GITHUB_TOKEN;
  });

  it('passes through values without $ unchanged', () => {
    const result = resolveVars({ 'Content-Type': 'application/json' });
    assert.equal(result['Content-Type'], 'application/json');
  });

  it('throws with the var name when env var is missing', () => {
    delete process.env.MISSING_VAR;
    assert.throws(
      () => resolveVars({ Authorization: 'Bearer $MISSING_VAR' }),
      (err) => err.message.includes('MISSING_VAR')
    );
  });

  it('handles multiple vars in one value', () => {
    process.env.PART_A = 'hello';
    process.env.PART_B = 'world';
    const result = resolveVars({ X: '$PART_A-$PART_B' });
    assert.equal(result.X, 'hello-world');
    delete process.env.PART_A;
    delete process.env.PART_B;
  });
});

describe('createMcpClient — allowlist', () => {
  it('filters to only allowedTools names', async () => {
    const result = await createMcpClient(
      [{ name: 'myserver', type: 'stdio', command: 'noop', args: [], allowedTools: ['toolA'] }],
      [],
      clientFactory(['toolA', 'toolB', 'toolC'])
    );
    const names = result.tools.map(t => t.name);
    assert.ok(names.includes('toolA'), 'toolA should be in LLM tools');
    assert.ok(!names.includes('toolB'), 'toolB should not be in LLM tools');
    assert.ok(!names.includes('toolC'), 'toolC should not be in LLM tools');
    const serverTools = result.toolsByServer.get('myserver');
    assert.equal(serverTools.length, 3, 'toolsByServer shows all server tools regardless of allowlist');
    assert.ok(serverTools.some(t => t.name === 'toolA'));
    assert.ok(serverTools.some(t => t.name === 'toolB'));
    assert.ok(serverTools.some(t => t.name === 'toolC'));
  });

  it('default deny: no allowedTools field → zero LLM tools, toolsByServer shows all server tools', async () => {
    const result = await createMcpClient(
      [{ name: 'myserver', type: 'stdio', command: 'noop', args: [] }],
      [],
      clientFactory(['toolA', 'toolB'])
    );
    assert.equal(result.tools.filter(t => t.name === 'toolA' || t.name === 'toolB').length, 0);
    const serverTools = result.toolsByServer.get('myserver');
    assert.equal(serverTools.length, 2, 'toolsByServer shows all server tools');
  });

  it('zero match: allowedTools has names not in server list → zero LLM tools, toolsByServer still shows all server tools', async () => {
    const result = await createMcpClient(
      [{ name: 'myserver', type: 'stdio', command: 'noop', args: [], allowedTools: ['nonexistent'] }],
      [],
      clientFactory(['toolA', 'toolB'])
    );
    assert.equal(result.tools.length, 0);
    const serverTools = result.toolsByServer.get('myserver');
    assert.equal(serverTools.length, 2, 'toolsByServer shows all server tools');
  });
});

describe('createMcpClient — local tools', () => {
  it('local tools appear in tools array and toolsByServer.local', async () => {
    const localTools = [
      {
        name: 'my_local_tool',
        description: 'does a thing',
        input_schema: { type: 'object', properties: {} },
        handler: async () => [{ type: 'text', text: 'local result' }],
      },
    ];
    const result = await createMcpClient([], localTools);
    assert.ok(result.tools.some(t => t.name === 'my_local_tool'), 'local tool in tools array');
    assert.ok(result.toolsByServer.has('local'), 'toolsByServer has local key');
    assert.ok(result.toolsByServer.get('local').some(t => t.name === 'my_local_tool'));
  });

  it('local key present even with no local tools', async () => {
    const result = await createMcpClient([], []);
    assert.ok(result.toolsByServer.has('local'));
    assert.deepEqual(result.toolsByServer.get('local'), []);
  });

  it('local tool callTool dispatches to handler', async () => {
    const localTools = [
      {
        name: 'echo_tool',
        description: 'echoes input',
        input_schema: { type: 'object', properties: {} },
        handler: async ({ msg }) => [{ type: 'text', text: `echo:${msg}` }],
      },
    ];
    const { callTool } = await createMcpClient([], localTools);
    const result = await callTool('echo_tool', { msg: 'hello' });
    assert.deepEqual(result, [{ type: 'text', text: 'echo:hello' }]);
  });
});

describe('createMcpClient — server connect failure', () => {
  it('server connect failure → warning, remaining servers still connected', async () => {
    const throwingFactory = (server) => {
      if (server.name === 'bad') throw new Error('connection refused');
      return makeStubClient(['goodTool']);
    };
    const result = await createMcpClient(
      [
        { name: 'bad', type: 'stdio', command: 'noop', args: [], allowedTools: ['x'] },
        { name: 'good', type: 'stdio', command: 'noop', args: [], allowedTools: ['goodTool'] },
      ],
      [],
      throwingFactory
    );
    assert.ok(result.tools.some(t => t.name === 'goodTool'), 'good server tools should be present');
    assert.deepEqual(result.toolsByServer.get('bad'), []);
    const goodTools = result.toolsByServer.get('good');
    assert.equal(goodTools.length, 1);
    assert.equal(goodTools[0].name, 'goodTool');
  });
});

describe('createMcpClient — security layer', () => {
  it('unknown tool returns error result', async () => {
    const { callTool } = await createMcpClient([], []);
    const result = await callTool('nonexistent_tool', {});
    assert.deepEqual(result, [{ type: 'text', text: 'Tool call failed.' }]);
  });

  it('get_file_contents passes through for any path', async () => {
    const localTools = [{
      name: 'get_file_contents',
      description: 'stub',
      input_schema: { type: 'object', properties: {} },
      handler: async ({ path }) => [{ type: 'text', text: `content:${path}` }],
    }];
    const { callTool } = await createMcpClient([], localTools);
    const result = await callTool('get_file_contents', { owner: 'owner', repo: 'myrepo', path: 'src/index.js' });
    assert.deepEqual(result, [{ type: 'text', text: 'content:src/index.js' }]);
  });
});

describe('createMcpClient — MCP server callTool', () => {
  it('dispatches callTool to the correct MCP server client', async () => {
    const result = await createMcpClient(
      [{ name: 'myserver', type: 'stdio', command: 'noop', args: [], allowedTools: ['toolA'] }],
      [],
      clientFactory(['toolA'])
    );
    const output = await result.callTool('toolA', {});
    assert.deepEqual(output, [{ type: 'text', text: 'result:toolA' }]);
  });
});
