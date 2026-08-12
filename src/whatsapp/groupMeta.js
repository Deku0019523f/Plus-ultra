'use strict';

const logger = require('../utils/logger');

const CACHE_TTL_MS = 60_000;
const metaCache = new Map(); // groupJid -> { meta, expiresAt }

async function getGroupMetadata(sock, groupJid) {
  const cached = metaCache.get(groupJid);
  if (cached && cached.expiresAt > Date.now()) return cached.meta;

  const meta = await sock.groupMetadata(groupJid);
  metaCache.set(groupJid, { meta, expiresAt: Date.now() + CACHE_TTL_MS });
  return meta;
}

function invalidateGroupMetadata(groupJid) {
  metaCache.delete(groupJid);
}

async function isSenderAdmin(sock, groupJid, senderJid) {
  try {
    const meta = await getGroupMetadata(sock, groupJid);
    const participant = meta.participants.find((p) => p.id === senderJid);
    return !!participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
  } catch (err) {
    logger.warn({ groupJid, err: err.message }, 'Impossible de vérifier le statut admin');
    return false;
  }
}

async function isBotAdmin(sock, groupJid) {
  try {
    const meta = await getGroupMetadata(sock, groupJid);
    const botJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
    const participant = meta.participants.find((p) => p.id.split(':')[0] === botJid.split('@')[0]);
    return !!participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
  } catch (err) {
    logger.warn({ groupJid, err: err.message }, 'Impossible de vérifier le statut admin du bot');
    return false;
  }
}

async function getGroupDescription(sock, groupJid) {
  const meta = await getGroupMetadata(sock, groupJid);
  return meta.desc || '';
}

async function getGroupName(sock, groupJid) {
  const meta = await getGroupMetadata(sock, groupJid);
  return meta.subject || groupJid;
}

module.exports = {
  getGroupMetadata,
  invalidateGroupMetadata,
  isSenderAdmin,
  isBotAdmin,
  getGroupDescription,
  getGroupName,
};
