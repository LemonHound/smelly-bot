import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeReactionClassifier } from '../src/reaction.js';

function makeClient(answer) {
  return {
    messages: {
      create: async () => ({ content: [{ type: 'text', text: answer }] }),
    },
  };
}

const errorClient = {
  messages: {
    create: async () => { throw new Error('API error'); },
  },
};

describe('makeReactionClassifier', () => {
  it('returns "question" when model answers B', async () => {
    const classify = makeReactionClassifier({ anthropicClient: makeClient('B') });
    assert.equal(await classify('thinking_face'), 'question');
  });

  it('returns "question" for lowercase b', async () => {
    const classify = makeReactionClassifier({ anthropicClient: makeClient('  b  ') });
    assert.equal(await classify('raised_eyebrow'), 'question');
  });

  it('returns "agree" when model answers A', async () => {
    const classify = makeReactionClassifier({ anthropicClient: makeClient('A') });
    assert.equal(await classify('thumbsup'), 'agree');
  });

  it('returns "agree" for any non-B response', async () => {
    const classify = makeReactionClassifier({ anthropicClient: makeClient('unclear') });
    assert.equal(await classify('wave'), 'agree');
  });

  it('returns "agree" on API error (fail safe)', async () => {
    const classify = makeReactionClassifier({ anthropicClient: errorClient });
    assert.equal(await classify('thinking_face'), 'agree');
  });
});
