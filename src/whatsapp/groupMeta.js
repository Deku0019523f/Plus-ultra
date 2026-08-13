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

/** Extrait l'identifiant utilisateur brut d'un JID, sans suffixe device ni domaine. */
function jidUser(jid) {
  if (!jid) return null;
  return jid.split('@')[0].split(':')[0];
}

/**
 * Rassemble tous les identifiants plausibles pour l'expéditeur : le senderJid
 * "classique", et les variantes alternatives (LID <-> numéro de téléphone)
 * que Baileys attache parfois directement sur la clé du message depuis
 * l'introduction du système LID de WhatsApp.
 */
function candidateIds(senderJid, msg) {
  const candidates = new Set();
  const add = (jid) => {
    const u = jidUser(jid);
    if (u) candidates.add(u);
  };
  add(senderJid);
  add(msg?.key?.participantAlt);
  add(msg?.key?.participantPn);
  add(msg?.key?.participantLid);
  return candidates;
}

/** Tente une résolution LID <-> numéro via le repository signal de Baileys, si exposé par la version installée. */
async function resolveAltJid(sock, jid) {
  try {
    const mapping = sock?.signalRepository?.lidMapping;
    if (!mapping || !jid) return null;
    if (jid.endsWith('@lid') && mapping.getPNForLID) return await mapping.getPNForLID(jid);
    if (jid.endsWith('@s.whatsapp.net') && mapping.getLIDForPN) return await mapping.getLIDForPN(jid);
  } catch {
    return null;
  }
  return null;
}

function participantIds(p) {
  return [jidUser(p.id), jidUser(p.jid), jidUser(p.lid)].filter(Boolean);
}

async function isSenderAdmin(sock, groupJid, senderJid, msg) {
  try {
    const meta = await getGroupMetadata(sock, groupJid);
    const candidates = candidateIds(senderJid, msg);

    const altJid = await resolveAltJid(sock, senderJid);
    if (altJid) candidates.add(jidUser(altJid));

    const participant = meta.participants.find((p) => participantIds(p).some((id) => candidates.has(id)));
    return !!participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
  } catch (err) {
    logger.warn({ groupJid, err: err.message }, 'Impossible de vérifier le statut admin');
    return false;
  }
}

async function isBotAdmin(sock, groupJid) {
  try {
    const meta = await getGroupMetadata(sock, groupJid);
    const candidates = candidateIds(sock.user?.id, null);
    if (sock.user?.lid) candidates.add(jidUser(sock.user.lid));

    const participant = meta.participants.find((p) => participantIds(p).some((id) => candidates.has(id)));
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

/**
 * Retrouve le JID exact tel qu'il apparaît dans les participants du groupe
 * (meta.participants[].id) à partir de n'importe quel JID candidat (LID ou
 * numéro) — nécessaire car `groupParticipantsUpdate` exige le format exact
 * utilisé par WhatsApp pour ce groupe précis. Retourne le JID d'origine si
 * aucune correspondance n'est trouvée.
 */
async function resolveGroupParticipantJid(sock, groupJid, jid) {
  try {
    const meta = await getGroupMetadata(sock, groupJid);
    const candidates = candidateIds(jid, null);
    const altJid = await resolveAltJid(sock, jid);
    if (altJid) candidates.add(jidUser(altJid));
    const participant = meta.participants.find((p) => participantIds(p).some((id) => candidates.has(id)));
    return participant?.id || jid;
  } catch {
    return jid;
  }
}

module.exports = {
  getGroupMetadata,
  invalidateGroupMetadata,
  isSenderAdmin,
  isBotAdmin,
  getGroupDescription,
  getGroupName,
  resolveGroupParticipantJid,
};
