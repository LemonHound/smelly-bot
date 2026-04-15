import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
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
