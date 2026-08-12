'use strict';

const fs = require('fs');
const groqClient = require('./groqClient');
const logger = require('../utils/logger');

/**
 * Transcrit un vocal puis supprime systématiquement le fichier audio temporaire,
 * que la transcription réussisse ou échoue.
 */
async function transcribeAndCleanup(filePath) {
  try {
    const text = await groqClient.transcribe(filePath);
    return text;
  } catch (err) {
    logger.warn({ err: err.message }, 'Transcription vocale impossible');
    return null;
  } finally {
    fs.unlink(filePath, () => {});
  }
}

module.exports = { transcribeAndCleanup };
