'use strict';

// Liste de TLD non exhaustive par nature : n'importe quelle liste fermée finit
// par rater un domaine (ex: .me pour t.me n'était pas couvert). On l'élargit
// et on ajoute surtout une liste de services connus, toujours détectés quel
// que soit leur TLD.
const URL_RE =
  /((https?:\/\/|www\.)[^\s]+|\b[a-z0-9-]+\.(com|net|org|io|co|shop|store|link|xyz|ci|sn|ml|bf|me|gg|ly|to|tv|cc|gl|app|dev|page|click|info|biz|pro|site|online|club|life|world|top|icu|cn|ru|de|fr|uk|us)\b[^\s]*)/gi;

// Lien d'invitation de groupe WhatsApp — toujours considéré comme un lien.
const WA_INVITE_RE = /chat\.whatsapp\.com\/[a-zA-Z0-9]+/gi;

// Services fréquemment utilisés pour contourner le filtre (bots Telegram,
// raccourcisseurs, invitations Discord...) — toujours flaggés indépendamment
// de la liste de TLD ci-dessus, qui ne pourra jamais être complète.
const KNOWN_LINK_SERVICES_RE =
  /\b(t\.me|telegram\.me|wa\.me|discord\.gg|discord\.com\/invite|bit\.ly|tinyurl\.com|cutt\.ly|is\.gd|rebrand\.ly|shorturl\.at|linktr\.ee)\/[^\s]+/gi;

function findLinks(text) {
  if (!text) return [];
  const found = new Set();
  for (const m of text.matchAll(URL_RE)) found.add(m[0]);
  for (const m of text.matchAll(WA_INVITE_RE)) found.add(m[0]);
  for (const m of text.matchAll(KNOWN_LINK_SERVICES_RE)) found.add(m[0]);
  return [...found];
}

function countLinks(text) {
  return findLinks(text).length;
}

module.exports = { findLinks, countLinks };
