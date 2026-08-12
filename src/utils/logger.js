'use strict';

const pino = require('pino');
const config = require('../config/config');

const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      'apiKey',
      'req.headers["x-api-key"]',
      'config.groq.apiKey',
      '*.GROQ_API_KEY',
      '*.pairingCode',
    ],
    censor: '[redacted]',
  },
  transport:
    config.nodeEnv !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});

module.exports = logger;
