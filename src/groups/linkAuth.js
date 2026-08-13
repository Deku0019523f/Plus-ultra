'use strict';

const db = require('../database/db');

function authorize(groupJid, userId, memberJid, maxLinks, authorizedBy) {
  return db.setLinkAuthorization(groupJid, userId, memberJid, maxLinks, authorizedBy);
}

function get(groupJid, userId, memberJid) {
  return db.getLinkAuthorization(groupJid, userId, memberJid);
}

/** Consomme `count` unités de quota. Retourne { allowed, remaining }. */
function consume(groupJid, userId, memberJid, count = 1) {
  return db.consumeLinkQuota(groupJid, userId, memberJid, count);
}

function resetUsage(groupJid, userId, memberJid) {
  return db.resetLinkUsage(groupJid, userId, memberJid);
}

module.exports = { authorize, get, consume, resetUsage };
