'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const ffmpegPath = require('ffmpeg-static');
const logger = require('../utils/logger');

const execFileAsync = promisify(execFile);

// L'endpoint public translate.google.com/translate_tts n'exige pas de clé API,
// mais n'est pas une API officiellement supportée par Google : il limite la
// longueur du texte par requête (~200 caractères) et peut changer sans préavis.
const MAX_CHUNK_LEN = 200;
const TTS_LANG = 'fr';

/**
 * Retire les marqueurs de formatage WhatsApp (*gras*, _italique_, ~barré~,
 * `code`) avant la synthèse — sinon Google TTS les prononce/laisse tels
 * quels dans le vocal ("étoile", caractères bruts...), ce qui n'a aucun sens
 * à l'oral. Les listes à puces "- " sont aussi aplaties en simple pause.
 */
function stripWhatsAppFormatting(text) {
  return (text || '')
    .replace(/[*_~`]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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
  const clean = stripWhatsAppFormatting(text);
  const chunks = splitIntoChunks(clean);
  if (!chunks.length) return null;
  const buffers = [];
  for (let i = 0; i < chunks.length; i++) {
    buffers.push(await fetchChunkAudio(chunks[i], i, chunks.length));
  }
  logger.debug({ chunkCount: chunks.length }, 'Synthèse TTS française terminée');
  return Buffer.concat(buffers);
}

/**
 * Convertit un buffer MP3 en OGG/Opus mono 16kHz — le format que WhatsApp
 * exige pour rendre un message comme un vocal natif (bulle + forme d'onde)
 * quand on l'envoie avec `ptt: true`. Un MP3 brut est accepté sans erreur par
 * l'API Baileys mais WhatsApp affiche alors "souci avec le fichier audio".
 */
async function convertToOggOpus(mp3Buffer) {
  const tmpDir = os.tmpdir();
  const id = crypto.randomBytes(6).toString('hex');
  const inputPath = path.join(tmpDir, `ua-tts-${id}.mp3`);
  const outputPath = path.join(tmpDir, `ua-tts-${id}.ogg`);

  try {
    await fs.writeFile(inputPath, mp3Buffer);
    await execFileAsync(ffmpegPath, [
      '-y',
      '-i', inputPath,
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'libopus',
      '-b:a', '32k',
      outputPath,
    ]);
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(inputPath, { force: true }).catch(() => {});
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }
}

/**
 * Synthétise un texte en vocal français prêt à être envoyé à WhatsApp
 * (`{ audio, mimetype: 'audio/ogg; codecs=opus', ptt: true }`).
 * Retourne null si le texte est vide.
 */
async function synthesizeFrenchVoiceNote(text) {
  const mp3 = await synthesizeFrench(text);
  if (!mp3) return null;
  return convertToOggOpus(mp3);
}

module.exports = { synthesizeFrench, synthesizeFrenchVoiceNote };
