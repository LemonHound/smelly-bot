import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeLlmReply, buildThreadContext } from '../src/llm/index.js';

const makeConfig = (overrides = {}) => ({
  CLAUDE_MODEL: 'claude-haiku-4-5',
  MAX_OUTPUT_TOKENS: 400,
  THREAD_CONTEXT_MAX_CHARS: 6000,
  LLM_MAX_TOOL_ITERATIONS: 5,
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
    assert.ok(!userContent.includes('Thread context'), 'should not include thread context');
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

  it('returns static fallback when max tool iterations exceeded', async () => {
    let callCount = 0;
    const reply = makeLlmReply({
      config: makeConfig({ LLM_MAX_TOOL_ITERATIONS: 2 }),
      prompts: makePrompts(),
      rateLimit: okRateLimit,
      tools: [{ name: 'findPage', description: 'find', input_schema: { type: 'object', properties: {} } }],
      callTool: async () => [{ type: 'text', text: 'result' }],
      anthropicClient: {
        messages: {
          create: async () => {
            callCount++;
            return {
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id: `tu_${callCount}`, name: 'findPage', input: { query: 'x' } }],
            };
          },
        },
      },
    });

    const result = await reply(baseCtx);
    assert.match(result, /^:/, 'should return fallback when iterations exceeded');
    assert.equal(callCount, 2, 'should stop at max iterations');
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
});
