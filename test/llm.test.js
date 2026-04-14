import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeLlmReply, buildThreadContext } from '../src/llm/index.js';

const makeConfig = (overrides = {}) => ({
  CLAUDE_MODEL: 'claude-haiku-4-5',
  MAX_OUTPUT_TOKENS: 400,
  THREAD_CONTEXT_MAX_CHARS: 6000,
  LOG_LLM_PAYLOADS: false,
  ...overrides,
});

const okRateLimit = { tryConsume: async () => ({ ok: true }) };
const exceededRateLimit = { tryConsume: async () => ({ ok: false, retryAfterMs: 3_600_000 }) };

const makeClient = (text = 'hello from claude') => ({
  messages: {
    create: async () => ({ content: [{ type: 'text', text }] }),
  },
});

const errorClient = {
  messages: {
    create: async () => { throw new Error('API error'); },
  },
};

const baseCtx = {
  channelName: 'general',
  mentionUser: 'Alice',
  mentionText: 'say hi',
  threadMessages: null,
};

describe('makeLlmReply', () => {
  it('returns Claude response text on success', async () => {
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: 'Be helpful.',
      rateLimit: okRateLimit,
      anthropicClient: makeClient('howdy partner'),
    });
    const result = await reply(baseCtx);
    assert.equal(result, 'howdy partner');
  });

  it('returns fallback when rate limit exceeded', async () => {
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: 'Be helpful.',
      rateLimit: exceededRateLimit,
      anthropicClient: makeClient(),
    });
    const result = await reply(baseCtx);
    assert.match(result, /^:/);
  });

  it('returns fallback when Anthropic SDK throws', async () => {
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: 'Be helpful.',
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
      prompts: 'Be helpful.',
      rateLimit: exceededRateLimit,
      anthropicClient: {
        messages: {
          create: async () => { called = true; return { content: [{ type: 'text', text: 'x' }] }; },
        },
      },
    });
    await reply(baseCtx);
    assert.equal(called, false);
  });

  it('sends system prompt in the system field', async () => {
    let capturedPayload;
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: 'MY_SYSTEM_PROMPT',
      rateLimit: okRateLimit,
      anthropicClient: {
        messages: {
          create: async (payload) => {
            capturedPayload = payload;
            return { content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    });
    await reply(baseCtx);
    assert.equal(capturedPayload.system, 'MY_SYSTEM_PROMPT');
  });

  it('includes thread messages in user content when provided', async () => {
    let capturedPayload;
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: 'system',
      rateLimit: okRateLimit,
      anthropicClient: {
        messages: {
          create: async (payload) => {
            capturedPayload = payload;
            return { content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    });
    await reply({
      ...baseCtx,
      threadMessages: [
        { user: 'Bob', text: 'first message' },
        { user: 'Carol', text: 'second message' },
      ],
    });
    const userContent = capturedPayload.messages[0].content;
    assert.ok(userContent.includes('Bob: first message'), 'should include Bob message');
    assert.ok(userContent.includes('Carol: second message'), 'should include Carol message');
  });

  it('does not include thread context label when threadMessages is null', async () => {
    let capturedPayload;
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: 'system',
      rateLimit: okRateLimit,
      anthropicClient: {
        messages: {
          create: async (payload) => {
            capturedPayload = payload;
            return { content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    });
    await reply({ ...baseCtx, threadMessages: null });
    const userContent = capturedPayload.messages[0].content;
    assert.ok(!userContent.includes('Thread context'), 'should not include thread context');
  });

  it('includes channel and user in the user message header', async () => {
    let capturedPayload;
    const reply = makeLlmReply({
      config: makeConfig(),
      prompts: 'system',
      rateLimit: okRateLimit,
      anthropicClient: {
        messages: {
          create: async (payload) => {
            capturedPayload = payload;
            return { content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    });
    await reply({ ...baseCtx, channelName: 'random', mentionUser: 'Dave' });
    const userContent = capturedPayload.messages[0].content;
    assert.ok(userContent.includes('random'), 'should include channel name');
    assert.ok(userContent.includes('Dave'), 'should include mention user');
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
