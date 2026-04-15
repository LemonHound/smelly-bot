import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocCache } from '../src/github/docCache.js';

const TTL_MS = 24 * 60 * 60 * 1000;

function makeConfig(repo = 'owner/myrepo') {
  return { GITHUB_REPO: repo };
}

function makeFirestore({ snap = null, throwOnGet = false, throwOnSet = false } = {}) {
  return {
    collection: () => ({
      doc: () => ({
        get: throwOnGet
          ? async () => { throw new Error('Firestore unavailable'); }
          : async () => snap,
        set: throwOnSet
          ? async () => { throw new Error('Firestore write failed'); }
          : async () => {},
      }),
    }),
  };
}

const CONTENT_BLOCKS = [{ type: 'text', text: 'cached content' }];

function makeSnap(content, ageMs = 0) {
  const fetchedAt = new Date(Date.now() - ageMs);
  return {
    exists: true,
    data: () => ({
      content: JSON.stringify(content),
      fetchedAt: { toMillis: () => fetchedAt.getTime(), toDate: () => fetchedAt },
    }),
  };
}

const missingSnap = { exists: false };

function makeCallTool(resultBlocks = [{ type: 'text', text: 'fresh content' }]) {
  let calls = 0;
  return {
    fn: async () => {
      calls++;
      return resultBlocks;
    },
    get calls() { return calls; },
  };
}

describe('makeDocCache — getOrFetch', () => {
  it('returns cached content blocks on hit within TTL without calling MCP', async () => {
    const callTool = makeCallTool();
    const cache = makeDocCache({
      firestore: makeFirestore({ snap: makeSnap(CONTENT_BLOCKS, 1000) }),
      callTool: callTool.fn,
      config: makeConfig(),
    });
    const result = await cache.getOrFetch('README.md');
    assert.deepEqual(result, CONTENT_BLOCKS);
    assert.equal(callTool.calls, 0);
  });

  it('normalizes resource blocks from cache hit (stale stored format)', async () => {
    const resourceBlocks = [
      { type: 'resource', resource: { uri: 'file:///README.md', mimeType: 'text/markdown', text: '# Hello' } },
    ];
    const callTool = makeCallTool();
    const cache = makeDocCache({
      firestore: makeFirestore({ snap: makeSnap(resourceBlocks, 1000) }),
      callTool: callTool.fn,
      config: makeConfig(),
    });
    const result = await cache.getOrFetch('README.md');
    assert.deepEqual(result, [{ type: 'text', text: '# Hello' }]);
    assert.equal(callTool.calls, 0, 'should not re-fetch from MCP');
  });

  it('calls MCP and upserts on cache miss', async () => {
    let upserted = null;
    const firestore = {
      collection: () => ({
        doc: () => ({
          get: async () => missingSnap,
          set: async (data) => { upserted = data; },
        }),
      }),
    };
    const freshBlocks = [{ type: 'text', text: 'fresh data' }];
    const callTool = makeCallTool(freshBlocks);
    const cache = makeDocCache({ firestore, callTool: callTool.fn, config: makeConfig() });
    const result = await cache.getOrFetch('README.md');
    assert.deepEqual(result, freshBlocks);
    assert.equal(callTool.calls, 1);
    assert.deepEqual(JSON.parse(upserted.content), freshBlocks);
  });

  it('treats stale cache as miss and refetches', async () => {
    const freshBlocks = [{ type: 'text', text: 'newer content' }];
    const callTool = makeCallTool(freshBlocks);
    const cache = makeDocCache({
      firestore: makeFirestore({ snap: makeSnap(CONTENT_BLOCKS, TTL_MS + 1) }),
      callTool: callTool.fn,
      config: makeConfig(),
    });
    const result = await cache.getOrFetch('README.md');
    assert.deepEqual(result, freshBlocks);
    assert.equal(callTool.calls, 1);
  });

  it('fails open when Firestore read throws', async () => {
    const freshBlocks = [{ type: 'text', text: 'direct content' }];
    const callTool = makeCallTool(freshBlocks);
    const cache = makeDocCache({
      firestore: makeFirestore({ throwOnGet: true }),
      callTool: callTool.fn,
      config: makeConfig(),
    });
    const result = await cache.getOrFetch('README.md');
    assert.deepEqual(result, freshBlocks);
    assert.equal(callTool.calls, 1);
  });

  it('returns content even when Firestore write fails after MCP success', async () => {
    const freshBlocks = [{ type: 'text', text: 'fetched content' }];
    const callTool = makeCallTool(freshBlocks);
    const cache = makeDocCache({
      firestore: makeFirestore({ snap: missingSnap, throwOnSet: true }),
      callTool: callTool.fn,
      config: makeConfig(),
    });
    const result = await cache.getOrFetch('README.md');
    assert.deepEqual(result, freshBlocks);
  });

  it('falls back to MCP when cached content is unparseable (stale format)', async () => {
    const freshBlocks = [{ type: 'text', text: 'refetched' }];
    const callTool = makeCallTool(freshBlocks);
    const badSnap = {
      exists: true,
      data: () => ({
        content: 'not valid json {{{{',
        fetchedAt: { toMillis: () => Date.now() - 100, toDate: () => new Date() },
      }),
    };
    const cache = makeDocCache({
      firestore: makeFirestore({ snap: badSnap }),
      callTool: callTool.fn,
      config: makeConfig(),
    });
    const result = await cache.getOrFetch('README.md');
    assert.deepEqual(result, freshBlocks);
    assert.equal(callTool.calls, 1);
  });
});

describe('makeDocCache — normalizeForClaude (via getOrFetch)', () => {
  it('converts resource blocks to text blocks', async () => {
    const resourceBlocks = [
      { type: 'resource', resource: { uri: 'file:///README.md', mimeType: 'text/markdown', text: '# Hello' } },
    ];
    const callTool = makeCallTool(resourceBlocks);
    const cache = makeDocCache({
      firestore: makeFirestore({ snap: missingSnap }),
      callTool: callTool.fn,
      config: makeConfig(),
    });
    const result = await cache.getOrFetch('README.md');
    assert.deepEqual(result, [{ type: 'text', text: '# Hello' }]);
  });

  it('passes text blocks through unchanged', async () => {
    const textBlocks = [{ type: 'text', text: 'plain content' }];
    const callTool = makeCallTool(textBlocks);
    const cache = makeDocCache({
      firestore: makeFirestore({ snap: missingSnap }),
      callTool: callTool.fn,
      config: makeConfig(),
    });
    const result = await cache.getOrFetch('README.md');
    assert.deepEqual(result, textBlocks);
  });
});

describe('makeDocCache — fetchDirect', () => {
  it('always calls MCP and upserts regardless of cache state', async () => {
    let upserted = null;
    const firestore = {
      collection: () => ({
        doc: () => ({
          get: async () => makeSnap(CONTENT_BLOCKS, 100),
          set: async (data) => { upserted = data; },
        }),
      }),
    };
    const freshBlocks = [{ type: 'text', text: 'fresh direct' }];
    const callTool = makeCallTool(freshBlocks);
    const cache = makeDocCache({ firestore, callTool: callTool.fn, config: makeConfig() });
    const result = await cache.fetchDirect('README.md');
    assert.deepEqual(result, freshBlocks);
    assert.equal(callTool.calls, 1);
    assert.deepEqual(JSON.parse(upserted.content), freshBlocks);
  });
});

describe('wrapCallToolWithCache', () => {
  it('intercepts get_file_contents for any path on GITHUB_REPO and serves from cache', async () => {
    const { wrapCallToolWithCache } = await import('../src/github/docCache.js');
    let mcpCalled = false;
    const rawCallTool = async () => { mcpCalled = true; return [{ type: 'text', text: 'raw' }]; };

    const cache = makeDocCache({
      firestore: makeFirestore({ snap: makeSnap(CONTENT_BLOCKS, 100) }),
      callTool: rawCallTool,
      config: makeConfig(),
    });

    const wrapped = wrapCallToolWithCache(rawCallTool, cache, makeConfig());
    const result = await wrapped('get_file_contents', { owner: 'owner', repo: 'myrepo', path: 'src/index.js' });
    assert.deepEqual(result, CONTENT_BLOCKS);
    assert.equal(mcpCalled, false);
  });

  it('intercepts get_file_contents for arbitrary paths on GITHUB_REPO', async () => {
    const { wrapCallToolWithCache } = await import('../src/github/docCache.js');
    const freshBlocks = [{ type: 'text', text: 'fetched' }];
    let mcpCalled = false;
    const rawCallTool = async () => { mcpCalled = true; return freshBlocks; };
    const cache = makeDocCache({
      firestore: makeFirestore({ snap: missingSnap }),
      callTool: rawCallTool,
      config: makeConfig(),
    });
    const wrapped = wrapCallToolWithCache(rawCallTool, cache, makeConfig());
    const result = await wrapped('get_file_contents', { owner: 'owner', repo: 'myrepo', path: 'src/config.js' });
    assert.deepEqual(result, freshBlocks);
    assert.equal(mcpCalled, true, 'MCP called on cache miss');
  });

  it('passes through get_file_contents for different repo', async () => {
    const { wrapCallToolWithCache } = await import('../src/github/docCache.js');
    let mcpCalled = false;
    const rawCallTool = async () => { mcpCalled = true; return [{ type: 'text', text: 'other repo result' }]; };
    const cache = makeDocCache({
      firestore: makeFirestore({ snap: missingSnap }),
      callTool: rawCallTool,
      config: makeConfig(),
    });
    const wrapped = wrapCallToolWithCache(rawCallTool, cache, makeConfig());
    const result = await wrapped('get_file_contents', { owner: 'other', repo: 'repo', path: 'README.md' });
    assert.equal(mcpCalled, true);
    assert.deepEqual(result, [{ type: 'text', text: 'other repo result' }]);
  });

  it('passes through non-file-contents tool calls unchanged', async () => {
    const { wrapCallToolWithCache } = await import('../src/github/docCache.js');
    const rawCallTool = async (name) => [{ type: 'text', text: `result:${name}` }];
    const cache = makeDocCache({
      firestore: makeFirestore({ snap: missingSnap }),
      callTool: rawCallTool,
      config: makeConfig(),
    });
    const wrapped = wrapCallToolWithCache(rawCallTool, cache, makeConfig());
    const result = await wrapped('list_issues', { state: 'open' });
    assert.deepEqual(result, [{ type: 'text', text: 'result:list_issues' }]);
  });
});
