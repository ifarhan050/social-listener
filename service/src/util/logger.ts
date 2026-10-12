import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // Never log secrets.
  redact: ['token', 'apiKey', 'headers.authorization', '*.token', '*.apiKey'],
});

export type Logger = typeof logger;
