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

/**
 * Résout un JID vers sa forme "numéro de téléphone" (@s.whatsapp.net) quand
 * c'est un LID, via le repository Baileys — pour afficher/mentionner le vrai
 * numéro plutôt que l'identifiant LID (illisible et non reconnu comme
 * contact). Retourne le JID d'origine si déjà un numéro ou si la résolution
 * échoue (aucune garantie de disponibilité selon la version de Baileys).
 */
async function resolveToPhoneJid(sock, jid) {
  if (!jid || jid.endsWith('@s.whatsapp.net')) return jid;
  try {
    const mapping = sock?.signalRepository?.lidMapping;
    if (jid.endsWith('@lid') && mapping?.getPNForLID) {
      const pn = await mapping.getPNForLID(jid);
      if (pn) return pn;
    }
  } catch {
    // pas de mapping disponible, on retombe sur le JID d'origine
  }
  return jid;
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
  resolveToPhoneJid,
};
