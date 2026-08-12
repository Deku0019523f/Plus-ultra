'use strict';

const db = require('../database/db');

/**
 * Ajoute un avertissement à un membre, dans un groupe précis.
 * Retourne { count, limitReached, maxWarnings }.
 */
function warn(groupJid, userId, memberJid, maxWarnings) {
  const count = db.addWarning(groupJid, userId, memberJid, 1);
  return { count, limitReached: count >= maxWarnings, maxWarnings };
}

function unwarn(groupJid, userId, memberJid) {
  const current = db.getWarning(groupJid, userId, memberJid).count || 0;
  if (current <= 0) return { count: 0 };
  const count = db.addWarning(groupJid, userId, memberJid, -1);
  return { count };
}

function reset(groupJid, userId, memberJid) {
  db.resetWarning(groupJid, userId, memberJid);
}

function get(groupJid, userId, memberJid) {
  return db.getWarning(groupJid, userId, memberJid).count || 0;
}

function list(groupJid, userId) {
  return db.listWarnings(groupJid, userId).map((w) => ({ memberJid: w.member_jid, count: w.count }));
}

module.exports = { warn, unwarn, reset, get, list };
