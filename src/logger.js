import pino from 'pino';

export const logger = pino({
  messageKey: 'message',
  formatters: {
    level(label) {
      const severity = {
        trace: 'DEBUG', debug: 'DEBUG',
        info: 'INFO',   warn: 'WARNING',
        error: 'ERROR', fatal: 'CRITICAL',
      };
      return { severity: severity[label] ?? 'DEFAULT' };
    },
  },
});
