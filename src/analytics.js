import { logger } from './logger.js';

const COLLECTION = 'analytics';
const FEEDBACK_REACTIONS = new Set(['thumbsup', '+1', 'white_check_mark', 'tada', 'thumbsdown', '-1', 'x', 'disappointed']);
const POSITIVE_REACTIONS = new Set(['thumbsup', '+1', 'white_check_mark', 'tada']);

const MODEL_PRICING_PER_M = {
  'claude-haiku-4-5': { input: 0.80, output: 4.00 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-opus-4-7': { input: 15.00, output: 75.00 },
};

function estimateCostUsd(model, inputTokens, outputTokens) {
  const pricing = MODEL_PRICING_PER_M[model] ?? { input: 3.00, output: 15.00 };
  return ((inputTokens * pricing.input) + (outputTokens * pricing.output)) / 1_000_000;
}

export function makeAnalyticsStore({ firestore }) {
  const botMessageIndex = new Map();

  function indexBotMessage(messageTs, docId) {
    if (botMessageIndex.size >= 500) {
      const oldest = botMessageIndex.keys().next().value;
      botMessageIndex.delete(oldest);
    }
    botMessageIndex.set(messageTs, docId);
  }

  async function record({ channel, thread_ts, model, input_tokens, output_tokens, tools_called, latency_ms, stop_reason, response_length, is_wildcard, message_ts }) {
    const doc = {
      timestamp: new Date(),
      channel,
      thread_ts,
      model,
      input_tokens,
      output_tokens,
      total_tokens: input_tokens + output_tokens,
      estimated_cost_usd: estimateCostUsd(model, input_tokens, output_tokens),
      tools_called,
      tool_count: tools_called.length,
      latency_ms,
      stop_reason,
      response_length,
      is_wildcard: Boolean(is_wildcard),
      message_ts: message_ts ?? null,
      feedback: null,
    };

    try {
      const ref = await firestore.collection(COLLECTION).add(doc);
      if (message_ts) indexBotMessage(message_ts, ref.id);
      logger.debug({ docId: ref.id, total_tokens: doc.total_tokens, cost: doc.estimated_cost_usd.toFixed(6) }, 'Analytics recorded');
    } catch (err) {
      logger.warn({ err: err.message }, 'Analytics write failed');
    }
  }

  async function addFeedback({ message_ts, reaction }) {
    if (!FEEDBACK_REACTIONS.has(reaction)) return;
    const docId = botMessageIndex.get(message_ts);
    if (!docId) return;

    try {
      await firestore.collection(COLLECTION).doc(docId).update({
        feedback: POSITIVE_REACTIONS.has(reaction) ? 'positive' : 'negative',
        feedback_reaction: reaction,
        feedback_at: new Date(),
      });
      logger.debug({ docId, reaction }, 'Feedback recorded');
    } catch (err) {
      logger.warn({ err: err.message, docId }, 'Feedback write failed');
    }
  }

  return { record, addFeedback };
}
