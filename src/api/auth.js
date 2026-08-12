'use strict';

const db = require('../database/db');

function requireAuth(req, res, next) {
  const apiKey = req.header('x-api-key');
  if (!apiKey) return res.status(401).json({ error: 'Clé API manquante (en-tête x-api-key).' });

  const user = db.getUserByApiKey(apiKey);
  if (!user) return res.status(401).json({ error: 'Clé API invalide.' });

  req.user = user;
  next();
}

module.exports = { requireAuth };
