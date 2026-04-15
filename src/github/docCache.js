import { FieldValue } from '@google-cloud/firestore';
import { logger } from '../logger.js';

const TTL_MS = 24 * 60 * 60 * 1000;
const COLLECTION = 'docCache';

function cacheKey(owner, repo, path) {
  return `${owner}__${repo}__${path.replace(/\//g, '__')}`;
}

const CLAUDE_CONTENT_TYPES = new Set(['text', 'image', 'document', 'search_result', 'tool_reference']);

function normalizeForClaude(blocks) {
  if (!Array.isArray(blocks)) return [{ type: 'text', text: String(blocks) }];
  return blocks.map(b => {
    if (CLAUDE_CONTENT_TYPES.has(b.type)) return b;
    const inner = b[b.type];
    const text = b.text ?? inner?.text ?? inner?.blob ?? inner?.content ?? JSON.stringify(b);
    return { type: 'text', text };
  });
}

export function makeDocCache({ firestore, callTool, config }) {
  const [owner, repo] = config.GITHUB_REPO.split('/');

  async function get(path) {
    let doc;
    try {
      const key = cacheKey(owner, repo, path);
      const snap = await firestore.collection(COLLECTION).doc(key).get();
      if (!snap.exists) return null;
      doc = snap.data();
    } catch (err) {
      logger.warn({ path, err: err.message }, 'Firestore read failed, bypassing cache');
      return null;
    }

    const age = Date.now() - doc.fetchedAt.toMillis();
    if (age >= TTL_MS) return null;

    const key = cacheKey(owner, repo, path);
    logger.debug({ key, fetchedAt: doc.fetchedAt.toDate().toISOString() }, 'Doc cache hit');

    try {
      return JSON.parse(doc.content);
    } catch {
      logger.warn({ key }, 'Failed to parse cached content, bypassing cache');
      return null;
    }
  }

  async function upsert(path, content) {
    const key = cacheKey(owner, repo, path);
    try {
      await firestore.collection(COLLECTION).doc(key).set({
        content: JSON.stringify(content),
        fetchedAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      logger.warn({ key, err: err.message }, 'Firestore write failed, continuing without cache update');
    }
  }

  async function getOrFetch(path) {
    const cached = await get(path);
    if (cached !== null) return normalizeForClaude(cached);

    const raw = await callTool('get_file_contents', { owner, repo, path });
    const normalized = normalizeForClaude(raw);
    logger.debug({ path, blocks: normalized.length }, 'Fetched file from MCP');
    await upsert(path, normalized);
    return normalized;
  }

  async function fetchDirect(path) {
    const raw = await callTool('get_file_contents', { owner, repo, path });
    const normalized = normalizeForClaude(raw);
    logger.debug({ path, blocks: normalized.length }, 'Force-fetched file from MCP');
    await upsert(path, normalized);
    return normalized;
  }

  return { get, upsert, getOrFetch, fetchDirect };
}

export function wrapCallToolWithCache(callTool, docCache, config) {
  const [owner, repo] = config.GITHUB_REPO.split('/');
  return async (toolName, args) => {
    if (toolName === 'get_file_contents' && args.owner === owner && args.repo === repo) {
      return await docCache.getOrFetch(args.path);
    }
    const result = await callTool(toolName, args);
    return normalizeForClaude(result);
  };
}
