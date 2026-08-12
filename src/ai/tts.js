'use strict';

const logger = require('../utils/logger');

// L'endpoint public translate.google.com/translate_tts n'exige pas de clé API,
// mais n'est pas une API officiellement supportée par Google : il limite la
// longueur du texte par requête (~200 caractères) et peut changer sans préavis.
const MAX_CHUNK_LEN = 200;
const TTS_LANG = 'fr';

function splitIntoChunks(text) {
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/);
  const chunks = [];
  let current = '';
  for (const s of sentences) {
    const candidate = current ? `${current} ${s}` : s;
    if (candidate.length > MAX_CHUNK_LEN) {
      if (current) chunks.push(current.trim());
      current = s.length > MAX_CHUNK_LEN ? s.slice(0, MAX_CHUNK_LEN) : s;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

async function fetchChunkAudio(chunk, index, total) {
  const url = new URL('https://translate.google.com/translate_tts');
  url.searchParams.set('ie', 'UTF-8');
  url.searchParams.set('q', chunk);
  url.searchParams.set('tl', TTS_LANG);
  url.searchParams.set('client', 'tw-ob');
  url.searchParams.set('idx', String(index));
  url.searchParams.set('total', String(total));
  url.searchParams.set('textlen', String(chunk.length));

  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Referer: 'https://translate.google.com/',
    },
  });
  if (!res.ok) throw new Error(`Google TTS a répondu ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Synthétise un texte en voix française (mp3) via l'endpoint public Google
 * Translate TTS. Découpe automatiquement les textes longs. Retourne null si
 * le texte est vide, lève une erreur si la synthèse échoue (à catcher côté
 * appelant pour retomber sur une réponse texte).
 */
async function synthesizeFrench(text) {
  const chunks = splitIntoChunks(text || '');
  if (!chunks.length) return null;
  const buffers = [];
  for (let i = 0; i < chunks.length; i++) {
    buffers.push(await fetchChunkAudio(chunks[i], i, chunks.length));
  }
  logger.debug({ chunkCount: chunks.length }, 'Synthèse TTS française terminée');
  return Buffer.concat(buffers);
}

module.exports = { synthesizeFrench };
