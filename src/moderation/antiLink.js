'use strict';

const URL_RE = /((https?:\/\/|www\.)[^\s]+|\b[a-z0-9-]+\.(com|net|org|io|co|shop|store|link|xyz|ci|sn|ml|bf)\b[^\s]*)/gi;
// Lien d'invitation de groupe WhatsApp — toujours considéré comme un lien.
const WA_INVITE_RE = /chat\.whatsapp\.com\/[a-zA-Z0-9]+/gi;

function findLinks(text) {
  if (!text) return [];
  const found = new Set();
  for (const m of text.matchAll(URL_RE)) found.add(m[0]);
  for (const m of text.matchAll(WA_INVITE_RE)) found.add(m[0]);
  return [...found];
}

function countLinks(text) {
  return findLinks(text).length;
}

module.exports = { findLinks, countLinks };
