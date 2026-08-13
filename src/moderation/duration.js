'use strict';

const UNIT_MS = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse une durée courte type "30m", "2h", "1d", "45s". Retourne des
 * millisecondes, ou null si le texte ne ressemble pas à une durée (dans ce
 * cas l'appelant doit traiter ça comme "pas de durée" et non comme une
 * erreur de parsing).
 */
function parseDuration(text) {
  if (!text) return null;
  const m = String(text).trim().toLowerCase().match(/^(\d+)\s*(s|m|h|d)$/);
  if (!m) return null;
  const [, amount, unit] = m;
  return parseInt(amount, 10) * UNIT_MS[unit];
}

/** Formate une échéance (timestamp ms) en durée restante lisible, ou "indéfini". */
function formatUntil(until) {
  if (!until) return 'indéfini';
  const remainingMs = until - Date.now();
  if (remainingMs <= 0) return 'expiré';
  const minutes = Math.round(remainingMs / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours / 24)} j`;
}

module.exports = { parseDuration, formatUntil };
