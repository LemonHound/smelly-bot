import { logger } from './logger.js';

export function makeReactionClassifier({ anthropicClient }) {
  return async function classifyReaction(emojiName) {
    const prompt = [
      `Someone reacted to a chat message with the emoji :${emojiName}:.`,
      '',
      'Does this emoji indicate: (A) agreement, thanks, or positive acknowledgement, or (B) a question, pushback, concern, or alert that something might be wrong?',
      '',
      'Answer A or B only.',
    ].join('\n');

    try {
      const response = await anthropicClient.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages: [{ role: 'user', content: prompt }],
      });
      const answer = response.content.find(b => b.type === 'text')?.text?.trim().toUpperCase() ?? '';
      return answer.startsWith('B') ? 'question' : 'agree';
    } catch (err) {
      logger.warn({ err: err.message, emoji: emojiName }, 'Reaction classification failed, defaulting to agree');
      return 'agree';
    }
  };
}
