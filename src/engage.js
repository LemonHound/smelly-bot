import { logger } from './logger.js';

export function makeEngagementCheck({ anthropicClient, config }) {
  if (!config.ENGAGEMENT_CHECK_ENABLED) return null;

  return async ({ threadMessages, newMessage }) => {
    const contextLines = (threadMessages ?? []).slice(-6).map(m => {
      const label = m.displayName ?? m.userId ?? 'unknown';
      return `${label}: ${m.text}`;
    });

    const prompt = [
      'Thread context (most recent last):',
      ...contextLines,
      '',
      `New message: "${newMessage}"`,
      '',
      'Is this new message a reply to or continuing a conversation with smelly-bot? Answer YES or NO only.',
    ].join('\n');

    try {
      const response = await anthropicClient.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages: [{ role: 'user', content: prompt }],
      });
      const answer = response.content.find(b => b.type === 'text')?.text?.trim().toUpperCase() ?? '';
      return answer.startsWith('YES');
    } catch (err) {
      logger.warn({ err: err.message }, 'Engagement check failed, defaulting to engage');
      return true;
    }
  };
}
