'use strict';

const db = require('../database/db');

function mute(groupJid, userId, memberJid, durationMs, mutedBy) {
  const until = durationMs ? Date.now() + durationMs : null;
  db.muteMember(groupJid, userId, memberJid, until, mutedBy);
  return { until };
}

function unmute(groupJid, userId, memberJid) {
  db.unmuteMember(groupJid, userId, memberJid);
}

function isMuted(groupJid, userId, memberJid) {
  return db.isMuted(groupJid, userId, memberJid);
}

module.exports = { mute, unmute, isMuted };
