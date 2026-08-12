'use strict';

const express = require('express');
const path = require('path');
const config = require('../config/config');
const logger = require('../utils/logger');
const routes = require('./routes');

function createServer() {
  const app = express();

  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.use(express.static(path.join(__dirname, '..', '..', 'public')));
  app.use('/api', routes);

  app.use((req, res) => {
    res.status(404).json({ error: 'Route introuvable.' });
  });

  // Gestion d'erreurs centralisée — ne jamais exposer la pile ni des clés.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error({ err: err.message, path: req.path }, 'Erreur non gérée sur une route API');
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  });

  return app;
}

function start() {
  const app = createServer();
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, `${config.botName} — serveur démarré sur http://0.0.0.0:${config.port}`);
  });
  return server;
}

module.exports = { createServer, start };
