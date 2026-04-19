import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeLlmReply, buildThreadContext } from '../src/llm/index.js';

const makeConfig = (overrides = {}) => ({
  CLAUDE_MODEL: 'claude-haiku-4-5',
  MAX_OUTPUT_TOKENS: 1024,
  THREAD_CONTEXT_MAX_CHARS: 6000,
  CHANNEL_HISTORY_MAX_CHARS: 4000,
  ...overrides,
});

const makePrompts = (overrides = {}) => ({
  systemMd: 'You are a test bot.',
  topicsMd: '## Factoid topics\n- Test topic',
  ...overrides,
});

const okRateLimit = { tryConsume: async () => ({ ok: true }) };
const exceededRateLimit = { tryConsume: async () => ({ ok: false, retryAfterMs: 3_600_000 }) };

const makeClient = (text = 'hello from claude') => ({
  messages: {
    create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] }),
  },
});

const errorClient = {
  messages: {
    create: async () => { throw new Error('API error'); },
  },
};

const baseCtx = {
  channelName: 'general',
  mentionUserId: 'U111',
  botUserId: 'UBOT',
  mentionText: 'say hi',
  threadMessages: null,
};

describe('makeLlmReply', () => {
  it('returns Claude response text on success', async () => {
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      anthropicClient: makeClient('howdy partner'),
    });
    const result = await reply(baseCtx);
    assert.equal(result, 'howdy partner');
  });

  it('returns fallback when rate limit exceeded', async () => {
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: exceededRateLimit,
      anthropicClient: makeClient(),
    });
    const result = await reply(baseCtx);
    assert.match(result, /^:/);
  });

  it('returns fallback when Anthropic SDK throws', async () => {
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      anthropicClient: errorClient,
    });
    const result = await reply(baseCtx);
    assert.match(result, /^:/);
  });

  it('does not call Anthropic when rate limit exceeded', async () => {
    let called = false;
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: exceededRateLimit,
      anthropicClient: {
        messages: {
          create: async () => { called = true; return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] }; },
        },
      },
    });
    await reply(baseCtx);
    assert.equal(called, false);
  });

  it('sends system prompt as array with cache_control on topics block', async () => {
    let capturedPayload;
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts({ systemMd: 'SYSTEM', topicsMd: 'TOPICS' }),
      rateLimit: okRateLimit,
      anthropicClient: {
        messages: {
          create: async (payload) => {
            capturedPayload = payload;
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    });
    await reply(baseCtx);
    assert.ok(Array.isArray(capturedPayload.system), 'system should be an array');
    assert.equal(capturedPayload.system.length, 2);
    assert.equal(capturedPayload.system[0].text, 'SYSTEM');
    assert.equal(capturedPayload.system[0].cache_control, undefined);
    assert.equal(capturedPayload.system[1].text, 'TOPICS');
    assert.deepEqual(capturedPayload.system[1].cache_control, { type: 'ephemeral' });
  });

  it('includes thread messages in user content when provided', async () => {
    let capturedPayload;
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      anthropicClient: {
        messages: {
          create: async (payload) => {
            capturedPayload = payload;
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    });
    await reply({
      ...baseCtx,
      threadMessages: [
        { user: 'U222', text: 'first message' },
        { user: 'U333', text: 'second message' },
      ],
    });
    const userContent = capturedPayload.messages[0].content;
    assert.ok(userContent.includes('<@U222>: first message'), 'should include first user message with Slack tag');
    assert.ok(userContent.includes('<@U333>: second message'), 'should include second user message with Slack tag');
  });

  it('includes channelMessages in user content when provided', async () => {
    let capturedPayload;
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      anthropicClient: {
        messages: {
          create: async (payload) => {
            capturedPayload = payload;
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    });
    await reply({
      ...baseCtx,
      channelMessages: [
        { userId: 'U10', displayName: 'Eve', text: 'channel msg one' },
        { userId: 'U11', displayName: 'Frank', text: 'channel msg two' },
      ],
    });
    const userContent = capturedPayload.messages[0].content;
    assert.ok(userContent.includes('Recent channel messages'), 'should include channel messages section header');
    assert.ok(userContent.includes('channel msg one'), 'should include first channel message');
    assert.ok(userContent.includes('channel msg two'), 'should include second channel message');
  });

  it('includes otherThreads in user content when provided', async () => {
    let capturedPayload;
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      anthropicClient: {
        messages: {
          create: async (payload) => {
            capturedPayload = payload;
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    });
    await reply({
      ...baseCtx,
      otherThreads: [
        {
          root: { userId: 'U20', displayName: 'Grace', text: 'thread root text' },
          replies: [
            { userId: 'U21', displayName: 'Hank', text: 'thread reply text' },
          ],
        },
      ],
    });
    const userContent = capturedPayload.messages[0].content;
    assert.ok(userContent.includes('Other recent threads'), 'should include other threads section header');
    assert.ok(userContent.includes('thread root text'), 'should include thread root');
    assert.ok(userContent.includes('thread reply text'), 'should include thread reply');
  });

  it('does not include thread context label when threadMessages is null', async () => {
    let capturedPayload;
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      anthropicClient: {
        messages: {
          create: async (payload) => {
            capturedPayload = payload;
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    });
    await reply({ ...baseCtx, threadMessages: null });
    const userContent = capturedPayload.messages[0].content;
    assert.ok(!userContent.includes('Current thread context'), 'should not include thread context');
  });

  it('includes bot user ID and today\'s date in the user message header', async () => {
    let capturedPayload;
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      anthropicClient: {
        messages: {
          create: async (payload) => {
            capturedPayload = payload;
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    });
    await reply({ ...baseCtx, botUserId: 'UBOTXYZ' });
    const userContent = capturedPayload.messages[0].content;
    assert.ok(userContent.includes('<@UBOTXYZ>'), 'should include bot user ID as Slack tag');
    assert.ok(/\d{4}/.test(userContent), 'should include a year in the date');
  });

  it('includes channel and user in the user message header', async () => {
    let capturedPayload;
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      anthropicClient: {
        messages: {
          create: async (payload) => {
            capturedPayload = payload;
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    });
    await reply({ ...baseCtx, channelName: 'random', mentionUserId: 'U999' });
    const userContent = capturedPayload.messages[0].content;
    assert.ok(userContent.includes('random'), 'should include channel name');
    assert.ok(userContent.includes('<@U999>'), 'should include mention user ID as Slack tag');
  });

  it('passes tool definitions to Claude when provided', async () => {
    let capturedPayload;
    const tools = [{ name: 'findPage', description: 'find a page', input_schema: { type: 'object', properties: {} } }];
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      tools,
      callTool: async () => [{ type: 'text', text: 'result' }],
      anthropicClient: {
        messages: {
          create: async (payload) => {
            capturedPayload = payload;
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    });
    await reply(baseCtx);
    assert.deepEqual(capturedPayload.tools, tools);
  });

  it('executes tool-use loop: calls callTool and feeds tool_result back to Claude', async () => {
    const toolCalls = [];
    let callCount = 0;

    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      tools: [{ name: 'findPage', description: 'find', input_schema: { type: 'object', properties: {} } }],
      callTool: async (toolName, args) => {
        toolCalls.push({ toolName, args });
        return [{ type: 'text', text: 'Wikipedia result' }];
      },
      anthropicClient: {
        messages: {
          create: async (payload) => {
            callCount++;
            if (callCount === 1) {
              return {
                stop_reason: 'tool_use',
                content: [
                  { type: 'tool_use', id: 'tu_1', name: 'findPage', input: { query: 'cephalopods' } },
                ],
              };
            }
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Cephalopods are fascinating.' }] };
          },
        },
      },
    });

    const result = await reply(baseCtx);
    assert.equal(result, 'Cephalopods are fascinating.');
    assert.equal(callCount, 2, 'Claude should be called twice');
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].toolName, 'findPage');
    assert.deepEqual(toolCalls[0].args, { query: 'cephalopods' });
  });

  it('appends assistant + tool_result turns before second Claude call', async () => {
    const capturedPayloads = [];
    let callCount = 0;

    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      tools: [{ name: 'getPage', description: 'get', input_schema: { type: 'object', properties: {} } }],
      callTool: async (_toolName, _args) => [{ type: 'text', text: 'page content' }],
      anthropicClient: {
        messages: {
          create: async (payload) => {
            capturedPayloads.push(JSON.parse(JSON.stringify(payload)));
            callCount++;
            if (callCount === 1) {
              return {
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: 'tu_abc', name: 'getPage', input: { title: 'Octopus' } }],
              };
            }
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
          },
        },
      },
    });

    await reply(baseCtx);

    const secondCall = capturedPayloads[1];
    const roles = secondCall.messages.map(m => m.role);
    assert.ok(roles.includes('assistant'), 'messages should include assistant turn');
    assert.ok(roles.includes('user'), 'messages should include tool_result user turn');

    const userTurn = secondCall.messages.find(m => m.role === 'user' && Array.isArray(m.content));
    assert.ok(userTurn, 'tool_result user turn should exist');
    const toolResult = userTurn.content.find(b => b.type === 'tool_result');
    assert.ok(toolResult, 'tool_result block should exist');
    assert.equal(toolResult.tool_use_id, 'tu_abc');
  });

  it('feeds is_error tool_result when callTool throws', async () => {
    const capturedPayloads = [];
    let callCount = 0;

    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      tools: [{ name: 'findPage', description: 'find', input_schema: { type: 'object', properties: {} } }],
      callTool: async (_toolName, _args) => { throw new Error('tool timeout'); },
      anthropicClient: {
        messages: {
          create: async (payload) => {
            capturedPayloads.push(JSON.parse(JSON.stringify(payload)));
            callCount++;
            if (callCount === 1) {
              return {
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: 'tu_err', name: 'findPage', input: { query: 'x' } }],
              };
            }
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'sorry' }] };
          },
        },
      },
    });

    const result = await reply(baseCtx);
    assert.equal(result, 'sorry');

    const secondCall = capturedPayloads[1];
    const userTurn = secondCall.messages.find(m => m.role === 'user' && Array.isArray(m.content));
    const toolResult = userTurn.content.find(b => b.type === 'tool_result');
    assert.equal(toolResult.is_error, true);
  });

  it('works without tools or callTool (plain Claude mode)', async () => {
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      anthropicClient: makeClient('plain response'),
    });
    const result = await reply(baseCtx);
    assert.equal(result, 'plain response');
  });

  it('calls onTool with the tool name before executing the tool', async () => {
    const onToolCalls = [];
    let callCount = 0;

    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      tools: [{ name: 'findPage', description: 'find', input_schema: { type: 'object', properties: {} } }],
      callTool: async () => [{ type: 'text', text: 'result' }],
      anthropicClient: {
        messages: {
          create: async () => {
            callCount++;
            if (callCount === 1) {
              return {
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: 'tu_1', name: 'findPage', input: { query: 'x' } }],
              };
            }
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
          },
        },
      },
    });

    await reply({ ...baseCtx, onTool: (name) => onToolCalls.push(name) });
    assert.deepEqual(onToolCalls, ['findPage'], 'onTool should be called with the tool name');
  });

  it('does not call onTool when no tools are used', async () => {
    const onToolCalls = [];

    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      anthropicClient: makeClient('direct answer'),
    });

    await reply({ ...baseCtx, onTool: (name) => onToolCalls.push(name) });
    assert.deepEqual(onToolCalls, [], 'onTool should not be called for end_turn responses');
  });
});

describe('buildUserMessage with isWildcard', () => {
  it('includes uninvited note in user message when isWildcard is true', async () => {
    let capturedPayload;
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      anthropicClient: {
        messages: {
          create: async (payload) => {
            capturedPayload = payload;
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    });
    await reply({ ...baseCtx, isWildcard: true });
    const userContent = capturedPayload.messages[0].content;
    assert.ok(userContent.includes('uninvited'), 'should include uninvited note for wildcard');
  });

  it('does not include uninvited note when isWildcard is false or absent', async () => {
    let capturedPayload;
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      anthropicClient: {
        messages: {
          create: async (payload) => {
            capturedPayload = payload;
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    });
    await reply({ ...baseCtx, isWildcard: false });
    const userContent = capturedPayload.messages[0].content;
    assert.ok(!userContent.includes('uninvited'), 'should not include uninvited note for normal invocation');
  });
});

describe('buildThreadContext', () => {
  it('returns all messages when within budget', () => {
    const messages = [
      { user: 'A', text: 'hello' },
      { user: 'B', text: 'world' },
    ];
    const result = buildThreadContext(messages, 1000);
    assert.deepEqual(result, messages);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(buildThreadContext([], 1000), []);
  });

  it('keeps root and newest replies to fit within budget, dropping older middle replies', () => {
    const root   = { user: 'A', text: 'x'.repeat(10) };
    const reply1 = { user: 'B', text: 'y'.repeat(10) };
    const reply2 = { user: 'C', text: 'z'.repeat(10) };
    const result = buildThreadContext([root, reply1, reply2], 30);
    assert.ok(result[0] === root, 'root must always be first');
    assert.ok(result.some(m => m === reply2), 'newest reply should be included');
    assert.ok(!result.some(m => m === reply1), 'older reply should be dropped');
  });

  it('truncates root text with [truncated] when root alone exceeds budget', () => {
    const root = { user: 'A', text: 'x'.repeat(100) };
    const result = buildThreadContext([root], 10);
    assert.equal(result.length, 1);
    assert.ok(result[0].text.includes('[truncated]'), 'root should be marked truncated');
    assert.ok(result[0].text.length < root.text.length, 'truncated text should be shorter');
  });

  it('returns messages in chronological order', () => {
    const messages = [
      { user: 'A', text: 'first' },
      { user: 'B', text: 'second' },
      { user: 'C', text: 'third' },
    ];
    const result = buildThreadContext(messages, 1000);
    assert.equal(result[0].user, 'A');
    assert.equal(result[1].user, 'B');
    assert.equal(result[2].user, 'C');
  });

  it('uses displayName and userId when present in message objects', () => {
    const messages = [
      { userId: 'U111', displayName: 'Alice', text: 'hello from alice' },
      { userId: 'U222', displayName: 'Bob', text: 'hello from bob' },
    ];
    const result = buildThreadContext(messages, 1000);
    assert.equal(result.length, 2);
    assert.equal(result[0].userId, 'U111');
    assert.equal(result[0].displayName, 'Alice');
    assert.equal(result[1].userId, 'U222');
    assert.equal(result[1].displayName, 'Bob');
  });
});

describe('buildUserMessage with githubRepo', () => {
  it('includes Target repo in header when GITHUB_REPO is set in config', async () => {
    let capturedPayload;
    const reply = makeLlmReply({
      config: makeConfig({ GITHUB_REPO: 'myorg/myrepo' }),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      anthropicClient: {
        messages: {
          create: async (payload) => {
            capturedPayload = payload;
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    });
    await reply(baseCtx);
    const userContent = capturedPayload.messages[0].content;
    assert.ok(userContent.includes('Target repo: myorg/myrepo'), 'should include GITHUB_REPO in header');
  });

  it('omits Target repo line when GITHUB_REPO is not set', async () => {
    let capturedPayload;
    const reply = makeLlmReply({
      config: makeConfig({ GITHUB_REPO: undefined }),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      anthropicClient: {
        messages: {
          create: async (payload) => {
            capturedPayload = payload;
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    });
    await reply(baseCtx);
    const userContent = capturedPayload.messages[0].content;
    assert.ok(!userContent.includes('Target repo'), 'should not include Target repo line');
  });
});

describe('buildUserMessage with displayName', () => {
  it('includes both display name and userId in header when mentionDisplayName provided', async () => {
    let capturedPayload;
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      anthropicClient: {
        messages: {
          create: async (payload) => {
            capturedPayload = payload;
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    });
    await reply({ ...baseCtx, mentionUserId: 'U123', mentionDisplayName: 'Charlie' });
    const userContent = capturedPayload.messages[0].content;
    assert.ok(userContent.includes('Charlie'), 'should include display name');
    assert.ok(userContent.includes('<@U123>'), 'should include user ID in Slack format');
  });

  it('thread messages with {userId, displayName, text} format include both in output', async () => {
    let capturedPayload;
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      anthropicClient: {
        messages: {
          create: async (payload) => {
            capturedPayload = payload;
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    });
    await reply({
      ...baseCtx,
      threadMessages: [
        { userId: 'U444', displayName: 'Dana', text: 'first message' },
      ],
    });
    const userContent = capturedPayload.messages[0].content;
    assert.ok(userContent.includes('Dana'), 'should include display name in thread context');
    assert.ok(userContent.includes('<@U444>'), 'should include user ID in thread context');
  });
});
