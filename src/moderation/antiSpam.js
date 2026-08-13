'use strict';

// État en mémoire uniquement : perdu à chaque redémarrage, ce qui est
// acceptable pour un compteur de flood (pas une donnée à conserver).
// clé = `${groupJid}:${memberJid}` -> tableau de timestamps (ms)
const history = new Map();

function key(groupJid, memberJid) {
  return `${groupJid}:${memberJid}`;
}

/**
 * Enregistre un message et retourne { isFlooding, count } sur la fenêtre
 * glissante [maintenant - windowSec, maintenant].
 */
function record(groupJid, memberJid, maxMessages, windowSec) {
  const k = key(groupJid, memberJid);
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const timestamps = (history.get(k) || []).filter((t) => now - t < windowMs);
  timestamps.push(now);
  history.set(k, timestamps);
  return { isFlooding: timestamps.length > maxMessages, count: timestamps.length };
}

/** Vide le compteur d'un membre (ex: après une sanction, pour repartir propre). */
function reset(groupJid, memberJid) {
  history.delete(key(groupJid, memberJid));
}

module.exports = { record, reset };
