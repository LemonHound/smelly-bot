import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngagementCheck } from '../src/engage.js';

const makeConfig = (overrides = {}) => ({
  ENGAGEMENT_CHECK_ENABLED: true,
  ...overrides,
});

function makeAnthropicClient(answer = 'YES') {
  return {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: answer }],
      }),
    },
  };
}

const errorClient = {
  messages: {
    create: async () => { throw new Error('API error'); },
  },
};

const sampleThread = [
  { displayName: 'Alice', userId: 'U1', text: 'hey smelly-bot, what is the deal with octopuses' },
  { displayName: 'smelly-bot', userId: 'UBOT', text: 'glad you asked, octopuses have three hearts and zero shame' },
];

describe('makeEngagementCheck', () => {
  it('returns null when ENGAGEMENT_CHECK_ENABLED is false', () => {
    const check = makeEngagementCheck({
      anthropicClient: makeAnthropicClient(),
      config: makeConfig({ ENGAGEMENT_CHECK_ENABLED: false }),
    });
    assert.equal(check, null, 'should return null when disabled');
  });

  it('returns a function when enabled', () => {
    const check = makeEngagementCheck({
      anthropicClient: makeAnthropicClient(),
      config: makeConfig(),
    });
    assert.equal(typeof check, 'function', 'should return a function when enabled');
  });

  it('returns true when the model answers YES', async () => {
    const check = makeEngagementCheck({
      anthropicClient: makeAnthropicClient('YES'),
      config: makeConfig(),
    });
    const result = await check({ threadMessages: sampleThread, newMessage: 'haha ok fair point' });
    assert.equal(result, true, 'should return true for YES response');
  });

  it('returns true for YES with surrounding whitespace or lowercase', async () => {
    const check = makeEngagementCheck({
      anthropicClient: makeAnthropicClient('  yes  '),
      config: makeConfig(),
    });
    const result = await check({ threadMessages: sampleThread, newMessage: 'haha' });
    assert.equal(result, true, 'should handle lowercase/whitespace YES');
  });

  it('returns false when the model answers NO', async () => {
    const check = makeEngagementCheck({
      anthropicClient: makeAnthropicClient('NO'),
      config: makeConfig(),
    });
    const result = await check({ threadMessages: sampleThread, newMessage: 'yeah same lol' });
    assert.equal(result, false, 'should return false for NO response');
  });

  it('returns true (fail open) when Anthropic throws', async () => {
    const check = makeEngagementCheck({
      anthropicClient: errorClient,
      config: makeConfig(),
    });
    const result = await check({ threadMessages: sampleThread, newMessage: 'whatever' });
    assert.equal(result, true, 'should fail open on API error');
  });

  it('handles empty thread gracefully', async () => {
    const check = makeEngagementCheck({
      anthropicClient: makeAnthropicClient('YES'),
      config: makeConfig(),
    });
    const result = await check({ threadMessages: [], newMessage: 'hello' });
    assert.equal(result, true, 'should handle empty thread without throwing');
  });

  it('handles null threadMessages gracefully', async () => {
    const check = makeEngagementCheck({
      anthropicClient: makeAnthropicClient('YES'),
      config: makeConfig(),
    });
    const result = await check({ threadMessages: null, newMessage: 'hello' });
    assert.equal(result, true, 'should handle null thread without throwing');
  });
});
