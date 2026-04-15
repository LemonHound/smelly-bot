import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REFRESH_REPO_DOC_SCHEMA, makeRefreshRepoDocHandler } from '../src/github/tools.js';

describe('makeRefreshRepoDocHandler', () => {
  it('calls fetchDirect and returns content blocks as-is', async () => {
    const blocks = [{ type: 'text', text: 'content of README.md' }];
    const docCache = {
      fetchDirect: async () => blocks,
    };
    const handler = makeRefreshRepoDocHandler({ docCache });
    const result = await handler({ path: 'README.md' });
    assert.deepEqual(result, blocks);
  });

  it('propagates errors from fetchDirect', async () => {
    const docCache = {
      fetchDirect: async () => { throw new Error('MCP unreachable'); },
    };
    const handler = makeRefreshRepoDocHandler({ docCache });
    await assert.rejects(() => handler({ path: 'README.md' }), /MCP unreachable/);
  });
});

describe('REFRESH_REPO_DOC_SCHEMA', () => {
  it('has correct name and required path field', () => {
    assert.equal(REFRESH_REPO_DOC_SCHEMA.name, 'refresh_repo_doc');
    assert.ok(REFRESH_REPO_DOC_SCHEMA.input_schema.required.includes('path'));
  });
});
