'use strict';

const GROUP_JID_RE = /^\d+@g\.us$/;
const USER_JID_RE = /^\d+@(s\.whatsapp\.net|lid)$/;

function isGroupJid(jid) {
  return typeof jid === 'string' && GROUP_JID_RE.test(jid);
}

function isValidUserJid(jid) {
  return typeof jid === 'string' && USER_JID_RE.test(jid);
}

/** Empêche toute traversée de chemin: le JID de groupe doit être strictement numérique + @g.us */
function assertSafeGroupJid(jid) {
  if (!isGroupJid(jid)) {
    throw new Error(`JID de groupe invalide: ${jid}`);
  }
  return jid;
}

function cleanPhoneDigits(raw) {
  return String(raw || '').replace(/\D/g, '');
}

function phoneToJid(phone) {
  return `${cleanPhoneDigits(phone)}@s.whatsapp.net`;
}

function jidToPhone(jid) {
  return String(jid || '').split('@')[0].replace(/:\d+$/, '');
}

/** Retire le suffixe d'appareil (":15") qu'ajoute Baileys sur sock.user.id */
function normalizeJid(jid) {
  return String(jid || '').replace(/:\d+(?=@)/, '');
}

/** Extrait le premier JID mentionné dans un message texte (via contextInfo), ou null. */
function firstMentionedJid(message) {
  const mentioned =
    message?.extendedTextMessage?.contextInfo?.mentionedJid ||
    message?.conversation?.contextInfo?.mentionedJid ||
    message?.imageMessage?.contextInfo?.mentionedJid ||
    [];
  return mentioned.length ? mentioned[0] : null;
}

function allMentionedJids(message) {
  return (
    message?.extendedTextMessage?.contextInfo?.mentionedJid ||
    message?.conversation?.contextInfo?.mentionedJid ||
    []
  );
}

module.exports = {
  isGroupJid,
  isValidUserJid,
  assertSafeGroupJid,
  cleanPhoneDigits,
  phoneToJid,
  jidToPhone,
  normalizeJid,
  firstMentionedJid,
  allMentionedJids,
};
