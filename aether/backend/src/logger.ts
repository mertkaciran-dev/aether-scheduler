import pino from 'pino';
import { config } from './config';

export const logger = pino({
  level: config.logLevel,
  base: { svc: 'aether', role: config.role, host: config.hostname },
  redact: {
    paths: ['req.headers.authorization', 'req.headers["x-api-key"]', '*.secret', '*.apiKey'],
    censor: '[redacted]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
