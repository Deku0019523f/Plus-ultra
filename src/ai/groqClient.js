'use strict';

const fs = require('fs');
const Groq = require('groq-sdk');
const config = require('../config/config');
const logger = require('../utils/logger');

const client = config.groq.apiKey ? new Groq({ apiKey: config.groq.apiKey }) : null;

class GroqUnavailableError extends Error {
  constructor(cause) {
    super('Tous les modèles Groq ont échoué (rate limit ou indisponibilité)');
    this.name = 'GroqUnavailableError';
    this.cause = cause;
  }
}

// Index du dernier modèle qui a fonctionné, pour éviter de retenter systématiquement
// le premier modèle (souvent le plus chargé) en tête de rotation.
let preferredIndex = 0;

function rotationOrder() {
  const models = config.groq.textModels;
  return [...models.slice(preferredIndex), ...models.slice(0, preferredIndex)];
}

/**
 * Complète un chat en tournant sur la liste de modèles texte jusqu'à succès.
 * @param {{messages: Array, jsonMode?: boolean, temperature?: number, maxTokens?: number}} opts
 */
async function chatComplete({ messages, jsonMode = false, temperature = 0.4, maxTokens = 600 }) {
  if (!client) throw new GroqUnavailableError(new Error('GROQ_API_KEY manquant'));

  const order = rotationOrder();
  let lastErr;

  for (const model of order) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      });
      const content = response?.choices?.[0]?.message?.content || '';
      preferredIndex = config.groq.textModels.indexOf(model);
      if (preferredIndex < 0) preferredIndex = 0;
      return { content, model };
    } catch (err) {
      lastErr = err;
      logger.warn({ model, err: err.message }, 'Modèle Groq en échec, rotation vers le suivant');
    }
  }

  throw new GroqUnavailableError(lastErr);
}

/** Transcrit un fichier audio via Whisper-large-v3 (Groq). */
async function transcribe(filePath) {
  if (!client) throw new GroqUnavailableError(new Error('GROQ_API_KEY manquant'));
  try {
    const response = await client.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: config.groq.voiceModel,
      response_format: 'json',
    });
    return response?.text || '';
  } catch (err) {
    logger.error({ err: err.message }, 'Erreur de transcription Whisper');
    throw err;
  }
}

module.exports = { chatComplete, transcribe, GroqUnavailableError };
