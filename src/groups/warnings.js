'use strict';

const db = require('../database/db');

/**
 * Ajoute un avertissement à un membre, dans un groupe précis.
 * `category` isole des compteurs distincts par type d'infraction — par
 * défaut 'general' (antibot, anti-spam, anti-média, liste noire, .warn
 * manuel, modération IA), ou 'link' pour les liens non autorisés qui ont
 * leur propre seuil, plus strict.
 * Retourne { count, limitReached, maxWarnings }.
 */
function warn(groupJid, userId, memberJid, maxWarnings, category = 'general') {
  const count = db.addWarning(groupJid, userId, memberJid, 1, category);
  return { count, limitReached: count >= maxWarnings, maxWarnings };
}

/** Passe directement au seuil max (ex: .warn @membre direct → équivaut à N signalements d'un coup). */
function warnDirect(groupJid, userId, memberJid, maxWarnings, category = 'general') {
  const count = db.setWarningCount(groupJid, userId, memberJid, maxWarnings, category);
  return { count, limitReached: count >= maxWarnings, maxWarnings };
}

function unwarn(groupJid, userId, memberJid, category = 'general') {
  const current = db.getWarning(groupJid, userId, memberJid, category).count || 0;
  if (current <= 0) return { count: 0 };
  const count = db.addWarning(groupJid, userId, memberJid, -1, category);
  return { count };
}

function reset(groupJid, userId, memberJid, category = 'general') {
  db.resetWarning(groupJid, userId, memberJid, category);
}

function get(groupJid, userId, memberJid, category = 'general') {
  return db.getWarning(groupJid, userId, memberJid, category).count || 0;
}

function list(groupJid, userId, category = 'general') {
  return db.listWarnings(groupJid, userId, category).map((w) => ({ memberJid: w.member_jid, count: w.count }));
}

module.exports = { warn, warnDirect, unwarn, reset, get, list };
