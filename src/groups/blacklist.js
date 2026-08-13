'use strict';

const db = require('../database/db');

function normalize(word) {
  return String(word || '').trim().toLowerCase();
}

function add(groupJid, userId, word, addedBy) {
  const w = normalize(word);
  if (!w) return null;
  db.addBlacklistWord(groupJid, userId, w, addedBy);
  return w;
}

function remove(groupJid, userId, word) {
  db.removeBlacklistWord(groupJid, userId, normalize(word));
}

function list(groupJid, userId) {
  return db.listBlacklistWords(groupJid, userId);
}

/** Retourne le premier mot de la liste noire trouvé dans le texte (recherche par mot entier), ou null. */
function findMatch(groupJid, userId, text) {
  if (!text) return null;
  const words = list(groupJid, userId);
  if (!words.length) return null;
  const lower = text.toLowerCase();
  for (const w of words) {
    const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(lower)) return w;
  }
  return null;
}

module.exports = { add, remove, list, findMatch };
